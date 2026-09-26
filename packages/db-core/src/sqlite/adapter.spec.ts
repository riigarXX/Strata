import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryEventSchema, type QueryEvent, type Session } from '@strata/contracts'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseAdapter } from '../adapter'
import { isAdapterError } from '../normalization'
import { isSupportedSqliteVersion } from './adapter'
import {
  collect,
  COUNT_TO,
  createTempDatabase,
  createTestAdapter,
  eventsOfType,
  queryRequest,
  removeTempDirs,
  sqliteProfile,
} from './test-support'

const SEED = `
  CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, age INTEGER, active BOOLEAN);
  INSERT INTO people (name, age, active) VALUES ('Ada', 36, 1), ('Linus', 54, 0), ('Grace', 85, 1);
`

const adapter: DatabaseAdapter = createTestAdapter()
const sessions: Session[] = []

async function open(setupSql = SEED, readOnly = false) {
  const database = createTempDatabase(setupSql)
  const session = await adapter.connect(sqliteProfile(database.filePath, readOnly))
  sessions.push(session)
  return { ...database, session }
}

function last(events: readonly QueryEvent[]): QueryEvent {
  const event = events.at(-1)
  if (!event) throw new Error('no events')
  return event
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (isAdapterError(error)) return error.normalized
    throw error
  }
  throw new Error('expected rejection')
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await adapter.disconnect(session.sessionId)
  }
  removeTempDirs()
})

describe('capabilities', () => {
  it('declares what better-sqlite3 really supports', () => {
    expect(adapter.engine).toBe('sqlite')
    expect(adapter.capabilities).toEqual({
      cancellation: true,
      cancellationMode: 'immediate',
      schemas: false,
      explain: false,
      transactions: true,
      readOnlyMode: true,
    })
  })
})

describe('connection', () => {
  it('tests a connection, reporting the SQLite version, and leaves no session behind', async () => {
    const { filePath } = createTempDatabase(SEED)
    const result = await adapter.testConnection(sqliteProfile(filePath))
    expect(result).toMatchObject({ ok: true, serverVersion: expect.stringMatching(/^3\.\d+\.\d+/) })
    expect(() => adapter.transactionState('anything')).toThrow()
  })

  it('does not modify the file when testing a connection', async () => {
    const { dir, filePath } = createTempDatabase(SEED)
    const before = readFileSync(filePath)
    await adapter.testConnection(sqliteProfile(filePath))
    expect(readFileSync(filePath).equals(before)).toBe(true)
    expect(existsSync(join(dir, 'fixture.sqlite-journal'))).toBe(false)
  })

  it('connects and returns a session describing the profile', async () => {
    const { session } = await open()
    expect(session).toMatchObject({
      profileId: 'profile-1',
      engine: 'sqlite',
      readOnly: false,
      transaction: 'none',
    })
    expect(session.serverVersion).toMatch(/^3\.\d+\.\d+/)
  })

  it('rejects with unsupported_version when the library is older than the minimum', async () => {
    const strict = createTestAdapter({ minimumVersion: '99.0.0' })
    const { filePath } = createTempDatabase(SEED)
    const result = await strict.testConnection(sqliteProfile(filePath))
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported_version' } })
    expect((await rejection(strict.connect(sqliteProfile(filePath)))).code).toBe(
      'unsupported_version',
    )
  })

  it('compares versions numerically', () => {
    expect(isSupportedSqliteVersion('3.49.2')).toBe(true)
    expect(isSupportedSqliteVersion('3.35.0')).toBe(true)
    expect(isSupportedSqliteVersion('3.34.9')).toBe(false)
    expect(isSupportedSqliteVersion('3.9.0')).toBe(false)
    expect(isSupportedSqliteVersion('4.0')).toBe(true)
    expect(isSupportedSqliteVersion('garbage')).toBe(false)
  })

  it('fails clearly for a missing file without creating it', async () => {
    const { dir } = createTempDatabase()
    const filePath = join(dir, 'missing.sqlite')
    const error = await rejection(adapter.connect(sqliteProfile(filePath)))
    expect(error.code).toBe('connection_failed')
    expect(existsSync(filePath)).toBe(false)
  })

  it('fails for a file that is not a SQLite database', async () => {
    const { filePath } = createTempDatabase()
    writeFileSync(filePath, 'this is definitely not a sqlite database '.repeat(40))
    const error = await rejection(adapter.connect(sqliteProfile(filePath)))
    expect(error).toMatchObject({
      code: 'connection_failed',
      message: expect.stringContaining('SQLite'),
    })
  })

  it.skipIf(process.getuid?.() === 0)(
    'reports permission_denied for an unreadable file',
    async () => {
      const { filePath } = createTempDatabase(SEED)
      chmodSync(filePath, 0o000)
      try {
        expect((await rejection(adapter.connect(sqliteProfile(filePath)))).code).toBe(
          'permission_denied',
        )
        expect(await adapter.testConnection(sqliteProfile(filePath))).toMatchObject({
          ok: false,
          error: { code: 'permission_denied' },
        })
      } finally {
        chmodSync(filePath, 0o600)
      }
    },
  )

  it('rejects relative paths and non-SQLite profiles', async () => {
    expect((await rejection(adapter.connect(sqliteProfile('relative.sqlite')))).code).toBe(
      'validation_failed',
    )
    const postgres = {
      id: 'p',
      name: 'pg',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'u',
      database: 'd',
      ssl: 'disable',
      readOnly: false,
    } as const
    expect((await rejection(adapter.connect(postgres))).code).toBe('validation_failed')
  })

  it('disconnects idempotently and refuses further use of the session', async () => {
    const { session } = await open()
    await adapter.disconnect(session.sessionId)
    await adapter.disconnect(session.sessionId)
    await adapter.disconnect('never-existed')

    expect((await rejection(adapter.listSchemas(session.sessionId))).code).toBe('no_session')
    const events = await collect(adapter.execute(queryRequest(session.sessionId, 'SELECT 1')))
    expect(events).toHaveLength(1)
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'no_session' } })
  })
})

describe('execute', () => {
  it('streams a SELECT as typed chunks followed by statement_done and done', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(queryRequest(session.sessionId, 'SELECT * FROM people ORDER BY id')),
    )

    expect(events.map((event) => event.type)).toEqual(['chunk', 'statement_done', 'done'])
    const [chunk] = eventsOfType(events, 'chunk')
    expect(chunk?.columns).toEqual([
      { name: 'id', dataType: 'INTEGER', kind: 'number' },
      { name: 'name', dataType: 'TEXT', kind: 'text' },
      { name: 'age', dataType: 'INTEGER', kind: 'number' },
      { name: 'active', dataType: 'BOOLEAN', kind: 'boolean' },
    ])
    expect(chunk?.rows).toEqual([
      [1, 'Ada', 36, true],
      [2, 'Linus', 54, false],
      [3, 'Grace', 85, true],
    ])
    expect(eventsOfType(events, 'statement_done')[0]).toMatchObject({
      statementIndex: 0,
      command: 'SELECT',
      rowsReturned: 3,
      rowsAffected: null,
      truncated: false,
    })
    expect(last(events)).toMatchObject({ type: 'done', statementCount: 1 })
  })

  it('reports the resulting transaction state on done', async () => {
    const { session } = await open()
    const run = async (sql: string) =>
      last(await collect(adapter.execute(queryRequest(session.sessionId, sql))))

    expect(await run('SELECT 1')).toMatchObject({ type: 'done', transaction: 'none' })
    expect(await run('BEGIN')).toMatchObject({ type: 'done', transaction: 'active' })
    expect(await run('SELECT 1')).toMatchObject({ type: 'done', transaction: 'active' })
    expect(await run('ROLLBACK')).toMatchObject({ type: 'done', transaction: 'none' })
  })

  it('classifies uuid columns by their declared type', async () => {
    const { session } = await open(
      'CREATE TABLE ids (id UUID, other GUID); INSERT INTO ids VALUES (1, 2);',
    )
    const events = await collect(
      adapter.execute(queryRequest(session.sessionId, 'SELECT * FROM ids')),
    )
    expect(eventsOfType(events, 'chunk')[0]?.columns.map((column) => column.kind)).toEqual([
      'uuid',
      'uuid',
    ])
  })

  it('emits only schema-valid events', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(
        queryRequest(
          session.sessionId,
          `SELECT 1; INSERT INTO people(name) VALUES ('X'); SELECT * FROM people; SELECT nope`,
        ),
      ),
    )
    for (const event of events) {
      expect(QueryEventSchema.safeParse(event).success).toBe(true)
    }
  })

  it('splits rows into chunks of chunkSize', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(queryRequest(session.sessionId, COUNT_TO(250), { chunkSize: 100 })),
    )
    const chunks = eventsOfType(events, 'chunk')
    expect(chunks.map((chunk) => chunk.rows.length)).toEqual([100, 100, 50])
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2])
    expect(chunks[2]?.columns).toEqual(chunks[0]?.columns)
    expect(eventsOfType(events, 'statement_done')[0]?.rowsReturned).toBe(250)
  })

  it('does not emit an empty trailing chunk when the rows fill the last chunk exactly', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(queryRequest(session.sessionId, COUNT_TO(200), { chunkSize: 100 })),
    )
    expect(eventsOfType(events, 'chunk')).toHaveLength(2)
  })

  it('still emits one chunk, with columns, for a result without rows', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(queryRequest(session.sessionId, 'SELECT id, name FROM people WHERE 0')),
    )
    const [chunk] = eventsOfType(events, 'chunk')
    expect(chunk?.rows).toEqual([])
    expect(chunk?.columns.map((column) => column.name)).toEqual(['id', 'name'])
  })

  it('infers types for expression columns and keeps huge integers exact', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(
        queryRequest(
          session.sessionId,
          `SELECT 1 AS i, 1.5 AS f, 'x' AS t, x'0AFF' AS b, NULL AS n, 9223372036854775807 AS big`,
        ),
      ),
    )
    const [chunk] = eventsOfType(events, 'chunk')
    expect(chunk?.columns.map((column) => [column.dataType, column.kind])).toEqual([
      ['INTEGER', 'number'],
      ['REAL', 'number'],
      ['TEXT', 'text'],
      ['BLOB', 'binary'],
      ['ANY', 'other'],
      ['INTEGER', 'number'],
    ])
    expect(chunk?.rows[0]).toEqual([1, 1.5, 'x', '0x0aff', null, '9223372036854775807'])
  })

  it('runs several statements in order, with one statement_done each', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(
        queryRequest(
          session.sessionId,
          `INSERT INTO people(name, age) VALUES ('Alan', 41);
           UPDATE people SET age = age + 1 WHERE age > 40;
           SELECT count(*) AS n FROM people;`,
        ),
      ),
    )
    expect(events.map((event) => event.type)).toEqual([
      'statement_done',
      'statement_done',
      'chunk',
      'statement_done',
      'done',
    ])
    const dones = eventsOfType(events, 'statement_done')
    expect(dones.map((done) => [done.statementIndex, done.command, done.rowsAffected])).toEqual([
      [0, 'INSERT', 1],
      [1, 'UPDATE', 3],
      [2, 'SELECT', null],
    ])
    expect(eventsOfType(events, 'chunk')[0]?.rows).toEqual([[4]])
    expect(last(events)).toMatchObject({ type: 'done', statementCount: 3 })
  })

  it('runs DDL and reports null affected rows', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(
        queryRequest(session.sessionId, 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)'),
      ),
    )
    expect(eventsOfType(events, 'statement_done')[0]).toMatchObject({
      command: 'CREATE',
      rowsAffected: null,
      rowsReturned: 0,
    })
    const tables = await adapter.listTables(session.sessionId)
    expect(tables.map((table) => table.name)).toContain('notes')
  })

  it('reports affected rows for DML with RETURNING', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(
        queryRequest(
          session.sessionId,
          `INSERT INTO people(name) VALUES ('A'), ('B') RETURNING id, name`,
        ),
      ),
    )
    expect(eventsOfType(events, 'chunk')[0]?.rows).toHaveLength(2)
    expect(eventsOfType(events, 'statement_done')[0]).toMatchObject({
      command: 'INSERT',
      rowsReturned: 2,
      rowsAffected: 2,
    })
  })

  it('creates a trigger and does not split its body', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(
        queryRequest(
          session.sessionId,
          `CREATE TABLE audit (msg TEXT);
           CREATE TRIGGER people_ai AFTER INSERT ON people BEGIN
             INSERT INTO audit VALUES ('inserted; ' || NEW.name);
             INSERT INTO audit VALUES (CASE WHEN NEW.age > 50 THEN 'senior' ELSE 'junior' END);
           END;
           INSERT INTO people(name, age) VALUES ('Tim', 60);
           SELECT msg FROM audit ORDER BY rowid;`,
        ),
      ),
    )
    expect(last(events).type).toBe('done')
    expect(eventsOfType(events, 'chunk').at(-1)?.rows).toEqual([['inserted; Tim'], ['senior']])
  })

  it('stops at the first failing statement and reports it with its index', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(
        queryRequest(
          session.sessionId,
          `INSERT INTO people(name) VALUES ('Before'); SELEC 1; INSERT INTO people(name) VALUES ('After')`,
        ),
      ),
    )
    expect(events.map((event) => event.type)).toEqual(['statement_done', 'error'])
    expect(last(events)).toMatchObject({
      type: 'error',
      statementIndex: 1,
      error: { code: 'syntax_error' },
    })
    const check = await collect(
      adapter.execute(
        queryRequest(session.sessionId, `SELECT name FROM people WHERE name IN ('Before','After')`),
      ),
    )
    expect(eventsOfType(check, 'chunk')[0]?.rows).toEqual([['Before']])
  })

  it('reports syntax errors, missing objects and constraint violations', async () => {
    const { session } = await open()
    const run = async (sql: string) =>
      last(await collect(adapter.execute(queryRequest(session.sessionId, sql))))

    expect(await run('SELEC * FROM people')).toMatchObject({ error: { code: 'syntax_error' } })
    expect(await run('SELECT * FROM')).toMatchObject({ error: { code: 'syntax_error' } })
    expect(await run('SELECT * FROM nowhere')).toMatchObject({
      error: { code: 'not_found', message: expect.stringContaining('no such table') },
    })
    expect(await run(`INSERT INTO people(name) VALUES ('Ada')`)).toMatchObject({
      error: {
        code: 'constraint_violation',
        message: expect.stringContaining('UNIQUE'),
        retryable: false,
      },
    })
  })

  it('does nothing but finish for a document made only of comments', async () => {
    const { session } = await open()
    const events = await collect(adapter.execute(queryRequest(session.sessionId, '-- just a note')))
    expect(events).toMatchObject([{ type: 'done', statementCount: 0 }])
  })

  it('rejects a second query while one is streaming on the same session', async () => {
    const { session } = await open()
    const first = adapter
      .execute(queryRequest(session.sessionId, COUNT_TO(1000), { chunkSize: 100 }))
      [Symbol.asyncIterator]()
    expect((await first.next()).value).toMatchObject({ type: 'chunk' })

    const second = await collect(adapter.execute(queryRequest(session.sessionId, 'SELECT 1')))
    expect(last(second)).toMatchObject({
      type: 'error',
      error: { code: 'busy', retryable: true },
    })
    expect(await rejection(adapter.begin(session.sessionId))).toMatchObject({
      code: 'busy',
      retryable: true,
    })

    await first.return?.()
    const after = await collect(adapter.execute(queryRequest(session.sessionId, 'SELECT 1')))
    expect(last(after).type).toBe('done')
  })

  it('lets metadata reads run while a query is streaming', async () => {
    const { session } = await open()
    const stream = adapter
      .execute(queryRequest(session.sessionId, COUNT_TO(1000), { chunkSize: 100 }))
      [Symbol.asyncIterator]()
    await stream.next()
    expect((await adapter.listTables(session.sessionId)).map((table) => table.name)).toEqual([
      'people',
    ])
    await stream.return?.()
  })
})

describe('limits and cancellation', () => {
  it('cuts the result at maxRows and says so', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(
        queryRequest(session.sessionId, COUNT_TO(1000), { maxRows: 250, chunkSize: 100 }),
      ),
    )
    expect(eventsOfType(events, 'chunk').map((chunk) => chunk.rows.length)).toEqual([100, 100, 50])
    expect(eventsOfType(events, 'notice')[0]).toMatchObject({
      level: 'warning',
      message: expect.stringContaining('250'),
    })
    expect(eventsOfType(events, 'statement_done')[0]).toMatchObject({
      rowsReturned: 250,
      truncated: true,
    })
    expect(last(events).type).toBe('done')
  })

  it('does not flag truncation when the result has exactly maxRows rows', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(queryRequest(session.sessionId, COUNT_TO(100), { maxRows: 100 })),
    )
    expect(eventsOfType(events, 'notice')).toHaveLength(0)
    expect(eventsOfType(events, 'statement_done')[0]?.truncated).toBe(false)
  })

  it('applies maxRows to each statement and keeps going', async () => {
    const { session } = await open()
    const events = await collect(
      adapter.execute(
        queryRequest(session.sessionId, `${COUNT_TO(50)}; ${COUNT_TO(50)}`, { maxRows: 10 }),
      ),
    )
    expect(eventsOfType(events, 'statement_done').map((done) => done.truncated)).toEqual([
      true,
      true,
    ])
  })

  it('cancels between chunks and ends with a cancelled event', async () => {
    const { session } = await open()
    const request = queryRequest(session.sessionId, COUNT_TO(100_000), { chunkSize: 100 })
    const events: QueryEvent[] = []
    let cancelled = false
    for await (const event of adapter.execute(request)) {
      events.push(event)
      if (event.type === 'chunk' && !cancelled) {
        cancelled = true
        expect(await adapter.cancel(request.requestId)).toEqual({
          requestId: request.requestId,
          outcome: 'requested',
        })
      }
    }
    expect(last(events)).toMatchObject({ type: 'cancelled', statementIndex: 0 })
    expect(eventsOfType(events, 'chunk').length).toBeLessThan(5)
    expect(eventsOfType(events, 'done')).toHaveLength(0)

    const after = await collect(adapter.execute(queryRequest(session.sessionId, 'SELECT 1')))
    expect(last(after).type).toBe('done')
  })

  it('does not run the statements after a cancelled one', async () => {
    const { session } = await open()
    const request = queryRequest(
      session.sessionId,
      `${COUNT_TO(10_000)}; INSERT INTO people(name) VALUES ('Never')`,
      { chunkSize: 100 },
    )
    for await (const event of adapter.execute(request)) {
      if (event.type === 'chunk') await adapter.cancel(request.requestId)
    }
    const check = await collect(
      adapter.execute(queryRequest(session.sessionId, `SELECT 1 FROM people WHERE name = 'Never'`)),
    )
    expect(eventsOfType(check, 'chunk')[0]?.rows).toEqual([])
  })

  it('reports not_running for an unknown or finished request', async () => {
    const { session } = await open()
    const request = queryRequest(session.sessionId, 'SELECT 1')
    await collect(adapter.execute(request))
    expect((await adapter.cancel(request.requestId)).outcome).toBe('not_running')
    expect((await adapter.cancel('unknown')).outcome).toBe('not_running')
  })

  it('stops with a timeout error once the time limit passes', async () => {
    const { session } = await open()
    const startedAt = performance.now()
    const events = await collect(
      adapter.execute(
        queryRequest(session.sessionId, COUNT_TO(50_000_000), { timeoutMs: 20, chunkSize: 1000 }),
      ),
    )
    expect(last(events)).toMatchObject({
      type: 'error',
      statementIndex: 0,
      error: { code: 'timeout', retryable: true },
    })
    expect(performance.now() - startedAt).toBeLessThan(2000)
  })

  it('ends a request cleanly when the session is disconnected mid-stream', async () => {
    const { session } = await open()
    const events: QueryEvent[] = []
    let disconnected = false
    for await (const event of adapter.execute(
      queryRequest(session.sessionId, COUNT_TO(100_000), { chunkSize: 100 }),
    )) {
      events.push(event)
      if (!disconnected) {
        disconnected = true
        await adapter.disconnect(session.sessionId)
      }
    }
    expect(last(events)).toMatchObject({ type: 'cancelled' })
  })
})

describe('read-only profiles', () => {
  it('reads normally but rejects writes at the driver level', async () => {
    const { session } = await open(SEED, true)
    expect(session.readOnly).toBe(true)

    const read = await collect(
      adapter.execute(queryRequest(session.sessionId, 'SELECT * FROM people')),
    )
    expect(last(read).type).toBe('done')

    for (const sql of [
      `INSERT INTO people(name) VALUES ('Nope')`,
      'CREATE TABLE t (a)',
      'DROP TABLE people',
    ]) {
      const events = await collect(adapter.execute(queryRequest(session.sessionId, sql)))
      expect(last(events)).toMatchObject({ type: 'error', error: { code: 'read_only_violation' } })
    }
  })

  it('still allows transaction control', async () => {
    const { session } = await open(SEED, true)
    expect((await adapter.begin(session.sessionId)).transaction).toBe('active')
    expect((await adapter.rollback(session.sessionId)).transaction).toBe('none')
  })
})

describe('transactions', () => {
  const count = async (sessionId: string) => {
    const events = await collect(
      adapter.execute(queryRequest(sessionId, 'SELECT count(*) FROM people')),
    )
    return eventsOfType(events, 'chunk')[0]?.rows[0]?.[0]
  }

  it('commits and rolls back for real', async () => {
    const { session } = await open()
    const id = session.sessionId

    expect(await adapter.begin(id)).toEqual({ sessionId: id, transaction: 'active' })
    await collect(adapter.execute(queryRequest(id, `INSERT INTO people(name) VALUES ('Temp')`)))
    expect(await count(id)).toBe(4)
    expect(await adapter.rollback(id)).toEqual({ sessionId: id, transaction: 'none' })
    expect(await count(id)).toBe(3)

    await adapter.begin(id)
    await collect(adapter.execute(queryRequest(id, `INSERT INTO people(name) VALUES ('Kept')`)))
    expect((await adapter.commit(id)).transaction).toBe('none')
    expect(await count(id)).toBe(4)
  })

  it('shows a rolled-back change is invisible to another connection until commit', async () => {
    const { session, filePath } = await open()
    await adapter.begin(session.sessionId)
    await collect(
      adapter.execute(
        queryRequest(session.sessionId, `INSERT INTO people(name) VALUES ('Hidden')`),
      ),
    )

    const other = new Database(filePath, { readonly: true })
    expect(other.prepare('SELECT count(*) FROM people').pluck().get()).toBe(3)
    await adapter.commit(session.sessionId)
    expect(other.prepare('SELECT count(*) FROM people').pluck().get()).toBe(4)
    other.close()
  })

  it('reflects a BEGIN and a COMMIT typed by the user', async () => {
    const { session } = await open()
    const id = session.sessionId
    expect(adapter.transactionState(id)).toBe('none')

    await collect(adapter.execute(queryRequest(id, 'BEGIN')))
    expect(adapter.transactionState(id)).toBe('active')
    expect((await adapter.begin(id)).transaction).toBe('active')

    await collect(adapter.execute(queryRequest(id, `INSERT INTO people(name) VALUES ('Manual')`)))
    await collect(adapter.execute(queryRequest(id, 'COMMIT')))
    expect(adapter.transactionState(id)).toBe('none')
    expect((await adapter.commit(id)).transaction).toBe('none')
    expect(await count(id)).toBe(4)
  })

  it('handles BEGIN ... ROLLBACK inside a single document', async () => {
    const { session } = await open()
    const id = session.sessionId
    await collect(
      adapter.execute(
        queryRequest(id, `BEGIN; INSERT INTO people(name) VALUES ('Gone'); ROLLBACK;`),
      ),
    )
    expect(adapter.transactionState(id)).toBe('none')
    expect(await count(id)).toBe(3)
  })

  it('leaves the transaction open when a statement fails inside it', async () => {
    const { session } = await open()
    const id = session.sessionId
    await adapter.begin(id)
    await collect(adapter.execute(queryRequest(id, `INSERT INTO people(name) VALUES ('Ada')`)))
    expect(adapter.transactionState(id)).toBe('active')
    await adapter.rollback(id)
  })

  it('rolls back an open transaction when the session disconnects', async () => {
    const { session, filePath } = await open()
    await adapter.begin(session.sessionId)
    await collect(
      adapter.execute(queryRequest(session.sessionId, `INSERT INTO people(name) VALUES ('Lost')`)),
    )
    await adapter.disconnect(session.sessionId)

    const check = new Database(filePath, { readonly: true })
    expect(check.prepare('SELECT count(*) FROM people').pluck().get()).toBe(3)
    check.close()
  })

  it('fails with no_session for unknown sessions', async () => {
    expect((await rejection(adapter.begin('ghost'))).code).toBe('no_session')
    expect((await rejection(adapter.commit('ghost'))).code).toBe('no_session')
    expect((await rejection(adapter.rollback('ghost'))).code).toBe('no_session')
  })
})

describe('error hygiene', () => {
  it('never puts the file path in any error', async () => {
    const { dir, filePath, session } = await open(SEED, true)
    const messages: string[] = []

    for (const sql of [
      'SELEC 1',
      'SELECT * FROM nowhere',
      `ATTACH DATABASE '${filePath}' AS twin; INSERT INTO twin.people(name) VALUES ('Ada')`,
      `INSERT INTO people(name) VALUES ('Ada')`,
      'CREATE TABLE x (a)',
    ]) {
      for (const event of await collect(adapter.execute(queryRequest(session.sessionId, sql)))) {
        if (event.type === 'error') messages.push(event.error.message)
      }
    }

    const failures = [
      adapter.connect(sqliteProfile(join(dir, 'missing.sqlite'))),
      adapter.connect(sqliteProfile(join(dir, 'no', 'such', 'dir', 'db.sqlite'))),
      adapter.connect(sqliteProfile(dir)),
    ]
    for (const failure of failures) {
      messages.push((await rejection(failure)).message)
    }
    const test = await adapter.testConnection(sqliteProfile(join(dir, 'missing.sqlite')))
    if (!test.ok) messages.push(test.error.message)

    expect(messages.length).toBeGreaterThanOrEqual(7)
    for (const message of messages) {
      expect(message).not.toContain(dir)
      expect(message).not.toContain('fixture.sqlite')
    }
  })
})

describe('a heavy single-step statement', () => {
  // One aggregate row: SQLite spends seconds inside a single step, so nothing between rows or chunks ever runs.
  const HEAVY = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000000) SELECT count(*), sum(x) FROM c`
  const IMMEDIATE_MS = 1500

  it('is cancelled at once, not when the step finishes, and the session keeps working', async () => {
    const { session } = await open()
    const request = queryRequest(session.sessionId, HEAVY)
    const startedAt = performance.now()
    const events: QueryEvent[] = []
    const consuming = (async () => {
      for await (const event of adapter.execute(request)) events.push(event)
    })()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await adapter.cancel(request.requestId)).toEqual({
      requestId: request.requestId,
      outcome: 'requested',
    })
    await consuming
    expect(performance.now() - startedAt).toBeLessThan(IMMEDIATE_MS)
    expect(events).toEqual([{ type: 'cancelled', requestId: request.requestId, statementIndex: 0 }])

    const after = await collect(adapter.execute(queryRequest(session.sessionId, 'SELECT 1 AS one')))
    expect(eventsOfType(after, 'chunk')[0]?.rows).toEqual([[1]])
    expect(last(after)).toMatchObject({ type: 'done' })
  })

  it('times out at once, not when the step finishes', async () => {
    const { session } = await open()
    const startedAt = performance.now()
    const events = await collect(
      adapter.execute(queryRequest(session.sessionId, HEAVY, { timeoutMs: 100 })),
    )
    expect(performance.now() - startedAt).toBeLessThan(IMMEDIATE_MS)
    expect(last(events)).toMatchObject({
      type: 'error',
      statementIndex: 0,
      error: { code: 'timeout', retryable: true },
    })
  })

  it('keeps the event loop free while the step runs', async () => {
    const { session } = await open()
    const request = queryRequest(session.sessionId, HEAVY, { timeoutMs: 700 })
    const consuming = collect(adapter.execute(request))
    let worstGapMs = 0
    let previous = performance.now()
    const ticker = setInterval(() => {
      const now = performance.now()
      worstGapMs = Math.max(worstGapMs, now - previous)
      previous = now
    }, 10)
    await consuming
    clearInterval(ticker)
    expect(worstGapMs).toBeLessThan(200)
  })

  // Each statement is a step of a few hundred ms, far longer than the 1 ms grace: the worker cannot acknowledge the abort in time, but it does between statements.
  const SLOW_STEPS = Array.from(
    { length: 40 },
    () =>
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT count(*) FROM c;',
  ).join('\n')

  async function inTransaction(transactionAbortGraceMs: number, abortGraceMs: number) {
    const local = createTestAdapter({ abortGraceMs, transactionAbortGraceMs })
    const database = createTempDatabase(SEED)
    const session = await local.connect(sqliteProfile(database.filePath))
    sessions.push(session)
    await local.begin(session.sessionId)
    await collect(
      local.execute(
        queryRequest(session.sessionId, "INSERT INTO people (name) VALUES ('Pending')"),
      ),
    )
    const pending = async () =>
      eventsOfType(
        await collect(
          local.execute(
            queryRequest(session.sessionId, "SELECT name FROM people WHERE name = 'Pending'"),
          ),
        ),
        'chunk',
      ).flatMap((chunk) => chunk.rows)
    return { local, session, pending }
  }

  async function cancelAfter(
    local: DatabaseAdapter,
    request: ReturnType<typeof queryRequest>,
    delayMs: number,
  ) {
    const consuming = collect(local.execute(request))
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    await local.cancel(request.requestId)
    return consuming
  }

  it('keeps the transaction when cancelling a statement whose steps outlast the grace', async () => {
    const { local, session, pending } = await inTransaction(10_000, 1)
    const events = await cancelAfter(local, queryRequest(session.sessionId, SLOW_STEPS), 100)
    expect(events.map((event) => event.type)).toEqual(['cancelled'])
    expect(local.transactionState(session.sessionId)).toBe('active')
    expect(await pending()).toEqual([['Pending']])
    expect((await local.rollback(session.sessionId)).transaction).toBe('none')
    expect(await pending()).toEqual([])
    await local.disconnect(session.sessionId)
  })

  it('keeps the transaction when a slow statement times out', async () => {
    const { local, session, pending } = await inTransaction(10_000, 1)
    const events = await collect(
      local.execute(queryRequest(session.sessionId, SLOW_STEPS, { timeoutMs: 100 })),
    )
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'timeout' } })
    expect(events.some((event) => event.type === 'notice')).toBe(false)
    expect(local.transactionState(session.sessionId)).toBe('active')
    expect(await pending()).toEqual([['Pending']])
    await local.disconnect(session.sessionId)
  })

  it('rolls the transaction back and says so when a single step cannot be interrupted', async () => {
    const { local, session, pending } = await inTransaction(200, 50)
    const events = await cancelAfter(local, queryRequest(session.sessionId, HEAVY), 100)
    expect(events.map((event) => event.type)).toEqual(['notice', 'cancelled'])
    expect(events[0]).toMatchObject({
      type: 'notice',
      level: 'warning',
      message: 'The statement could not be interrupted: the transaction was rolled back',
      code: 'transaction_lost',
    })
    expect(local.transactionState(session.sessionId)).toBe('none')
    expect(await pending()).toEqual([])
    await local.disconnect(session.sessionId)
  })

  it('rolls back an open transaction when the stuck worker is replaced on timeout', async () => {
    const { local, session } = await inTransaction(200, 50)
    const events = await collect(
      local.execute(queryRequest(session.sessionId, HEAVY, { timeoutMs: 100 })),
    )
    expect(events.map((event) => event.type)).toEqual(['notice', 'error'])
    expect(local.transactionState(session.sessionId)).toBe('none')
    await local.disconnect(session.sessionId)
  })
})
