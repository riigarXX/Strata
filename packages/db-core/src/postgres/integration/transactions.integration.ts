import type { Session } from '@strata/contracts'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createPostgresAdapter } from '../adapter'
import {
  collect,
  createSchema,
  describeEachTarget,
  dropSchema,
  eventsOfType,
  last,
  profileFor,
  queryRequest,
  rejection,
  run,
  stepper,
  type PgTarget,
} from './support'

const adapter = createPostgresAdapter()
const sessions: Session[] = []

async function open(target: PgTarget, overrides: Parameters<typeof profileFor>[1] = {}) {
  const session = await adapter.connect(profileFor(target, overrides))
  sessions.push(session)
  return session
}

describeEachTarget('PostgreSQL transactions', (target) => {
  let schema = ''
  const count = async (session: Session): Promise<number> => {
    const events = await run(adapter, session, `SELECT count(*)::int FROM ${schema}.items`)
    return Number(eventsOfType(events, 'chunk')[0]?.rows[0]?.[0])
  }

  beforeAll(async () => {
    schema = await createSchema(
      target,
      `CREATE TABLE $SCHEMA.items (id integer PRIMARY KEY, label text);`,
    )
  })

  afterAll(async () => {
    await dropSchema(target, schema)
  })

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await adapter.disconnect(session.sessionId)
    }
    const session = await adapter.connect(profileFor(target))
    await run(adapter, session, `DELETE FROM ${schema}.items`)
    await adapter.disconnect(session.sessionId)
  })

  it('commits work made between begin and commit, visible to other sessions only afterwards', async () => {
    const writer = await open(target)
    const reader = await open(target)

    expect(await adapter.begin(writer.sessionId)).toEqual({
      sessionId: writer.sessionId,
      transaction: 'active',
    })
    await run(adapter, writer, `INSERT INTO ${schema}.items VALUES (1, 'a')`)
    expect(adapter.transactionState(writer.sessionId)).toBe('active')
    expect(await count(reader)).toBe(0)

    expect(await adapter.commit(writer.sessionId)).toEqual({
      sessionId: writer.sessionId,
      transaction: 'none',
    })
    expect(adapter.transactionState(writer.sessionId)).toBe('none')
    expect(await count(reader)).toBe(1)
  })

  it('discards work on rollback', async () => {
    const session = await open(target)
    await adapter.begin(session.sessionId)
    await run(adapter, session, `INSERT INTO ${schema}.items VALUES (1, 'a')`)
    expect(await count(session)).toBe(1)
    expect((await adapter.rollback(session.sessionId)).transaction).toBe('none')
    expect(await count(session)).toBe(0)
  })

  it('is idempotent: begin, commit and rollback converge on the requested state', async () => {
    const session = await open(target)
    expect((await adapter.commit(session.sessionId)).transaction).toBe('none')
    expect((await adapter.rollback(session.sessionId)).transaction).toBe('none')
    expect((await adapter.begin(session.sessionId)).transaction).toBe('active')
    expect((await adapter.begin(session.sessionId)).transaction).toBe('active')
    expect((await adapter.rollback(session.sessionId)).transaction).toBe('none')
  })

  it('follows a BEGIN, COMMIT and ROLLBACK typed by the user', async () => {
    const session = await open(target)
    await run(adapter, session, 'BEGIN')
    expect(adapter.transactionState(session.sessionId)).toBe('active')
    await run(adapter, session, `INSERT INTO ${schema}.items VALUES (1, 'a')`)
    await run(adapter, session, 'COMMIT')
    expect(adapter.transactionState(session.sessionId)).toBe('none')
    expect(await count(session)).toBe(1)

    await run(adapter, session, `BEGIN; INSERT INTO ${schema}.items VALUES (2, 'b')`)
    expect(adapter.transactionState(session.sessionId)).toBe('active')
    await run(adapter, session, 'ROLLBACK')
    expect(adapter.transactionState(session.sessionId)).toBe('none')
    expect(await count(session)).toBe(1)

    await run(adapter, session, 'START TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    expect(adapter.transactionState(session.sessionId)).toBe('active')
    await run(adapter, session, 'END')
    expect(adapter.transactionState(session.sessionId)).toBe('none')
  })

  it('lets adapter commit end a transaction the user started by hand', async () => {
    const session = await open(target)
    await run(adapter, session, `BEGIN; INSERT INTO ${schema}.items VALUES (1, 'a')`)
    expect((await adapter.commit(session.sessionId)).transaction).toBe('none')
    expect(await count(session)).toBe(1)
  })

  it('reflects the aborted state after an error inside a transaction until it is rolled back', async () => {
    const session = await open(target)
    await adapter.begin(session.sessionId)
    expect(adapter.transactionState(session.sessionId)).toBe('active')

    const failed = await run(
      adapter,
      session,
      `INSERT INTO ${schema}.items VALUES (1, 'a'); SELECT 1 / 0`,
    )
    expect(last(failed)).toMatchObject({ type: 'error', error: { code: 'validation_failed' } })
    expect(adapter.transactionState(session.sessionId)).toBe('aborted')

    const ignored = await run(adapter, session, 'SELECT 1')
    expect(last(ignored)).toMatchObject({
      type: 'error',
      error: { code: 'validation_failed', message: expect.stringContaining('aborted') },
    })

    expect((await adapter.rollback(session.sessionId)).transaction).toBe('none')
    expect(adapter.transactionState(session.sessionId)).toBe('none')
    expect(await count(session)).toBe(0)
  })

  it('treats COMMIT of an aborted transaction as a rollback', async () => {
    const session = await open(target)
    await run(adapter, session, `BEGIN; INSERT INTO ${schema}.items VALUES (1, 'a'); SELECT nope`)
    expect(adapter.transactionState(session.sessionId)).toBe('aborted')
    expect((await adapter.commit(session.sessionId)).transaction).toBe('none')
    expect(await count(session)).toBe(0)
  })

  it('keeps an aborted transaction aborted on begin, which never nests', async () => {
    const session = await open(target)
    await run(adapter, session, 'BEGIN; SELECT nope')
    expect((await adapter.begin(session.sessionId)).transaction).toBe('aborted')
    expect((await adapter.rollback(session.sessionId)).transaction).toBe('none')
  })

  it('reports the resulting transaction state on done', async () => {
    const session = await open(target)
    const finalEvent = async (sql: string) => last(await run(adapter, session, sql))
    expect(await finalEvent('SELECT 1')).toMatchObject({ type: 'done', transaction: 'none' })
    expect(await finalEvent('BEGIN')).toMatchObject({ type: 'done', transaction: 'active' })
    expect(await finalEvent('SELECT 1')).toMatchObject({ type: 'done', transaction: 'active' })
    expect(await finalEvent('SELECT * FROM generate_series(1, 5)')).toMatchObject({
      type: 'done',
      transaction: 'active',
    })
    expect(await finalEvent('ROLLBACK')).toMatchObject({ type: 'done', transaction: 'none' })
  })

  it('leaves the transaction aborted, and the session usable, after a cancel inside it', async () => {
    const session = await open(target)
    await adapter.begin(session.sessionId)
    const request = queryRequest(session.sessionId, 'SELECT pg_sleep(30)')
    const pending = collect(adapter.execute(request))
    await new Promise((resolve) => setTimeout(resolve, 300))
    await adapter.cancel(request.requestId)
    expect(last(await pending).type).toBe('cancelled')

    expect(adapter.transactionState(session.sessionId)).toBe('aborted')
    await adapter.rollback(session.sessionId)
    expect(last(await run(adapter, session, 'SELECT 1')).type).toBe('done')
  })

  it('does not abort the transaction when a cancel arrives outside any statement', async () => {
    const session = await open(target)
    await adapter.begin(session.sessionId)
    expect(await adapter.cancel('nothing-running')).toMatchObject({ outcome: 'not_running' })
    expect(adapter.transactionState(session.sessionId)).toBe('active')
    expect(last(await run(adapter, session, 'SELECT 1')).type).toBe('done')
  })

  it('refuses transaction control and catalog reads while a query is running', async () => {
    const session = await open(target)
    const stream = stepper(
      adapter.execute(
        queryRequest(session.sessionId, 'SELECT g FROM generate_series(1, 100) g', {
          chunkSize: 10,
        }),
      ),
    )
    await stream.next()
    for (const attempt of [
      adapter.begin(session.sessionId),
      adapter.commit(session.sessionId),
      adapter.rollback(session.sessionId),
      adapter.listSchemas(session.sessionId),
    ]) {
      expect(await rejection(attempt)).toMatchObject({ code: 'busy', retryable: true })
    }
    await stream.stop()
    expect((await adapter.begin(session.sessionId)).transaction).toBe('active')
  })

  it('rejects unknown sessions with no_session', async () => {
    expect(await rejection(adapter.begin('missing'))).toMatchObject({ code: 'no_session' })
    expect(() => adapter.transactionState('missing')).toThrow()
  })

  it('aborts a transaction on a read-only profile when a write is attempted', async () => {
    const session = await open(target, { readOnly: true })
    await adapter.begin(session.sessionId)
    const events = await run(adapter, session, `INSERT INTO ${schema}.items VALUES (9, 'z')`)
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'read_only_violation' } })
    expect(adapter.transactionState(session.sessionId)).toBe('aborted')
    await adapter.rollback(session.sessionId)
  })

  it('rolls back an open transaction when the session is disconnected', async () => {
    const session = await open(target)
    await run(adapter, session, `BEGIN; INSERT INTO ${schema}.items VALUES (5, 'lost')`)
    await adapter.disconnect(session.sessionId)
    const other = await open(target)
    expect(await count(other)).toBe(0)
  })
})
