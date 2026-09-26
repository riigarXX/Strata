import { QueryEventSchema, type QueryEvent, type Session } from '@strata/contracts'
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

// What crosses IPC must survive structured clone and the contracts' own schema.
function expectIpcSafe(events: readonly QueryEvent[]): void {
  for (const event of events) {
    expect(QueryEventSchema.parse(event)).toEqual(event)
    expect(structuredClone(event)).toEqual(event)
  }
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await adapter.disconnect(session.sessionId)
  }
})

describeEachTarget('PostgreSQL execution', (target) => {
  let schema = ''

  beforeAll(async () => {
    schema = await createSchema(
      target,
      `CREATE TABLE $SCHEMA.people (id serial PRIMARY KEY, name text NOT NULL UNIQUE, age integer);
       INSERT INTO $SCHEMA.people (name, age) VALUES ('Ada', 36), ('Linus', 54), ('Grace', 85);
       CREATE TYPE $SCHEMA.mood AS ENUM ('sad', 'ok', 'happy');
       CREATE TABLE $SCHEMA.priced (price numeric(10, 2), label varchar(20), moment timestamp(3), mood $SCHEMA.mood);
       INSERT INTO $SCHEMA.priced VALUES (12.50, 'abc', '2024-03-01 08:09:10.123', 'happy');`,
    )
  })

  afterAll(async () => {
    await dropSchema(target, schema)
  })

  it('streams a SELECT in chunks with readable column types', async () => {
    const session = await open(target)
    const events = await run(
      adapter,
      session,
      `SELECT g AS n, 'row ' || g AS label FROM generate_series(1, 1250) AS g`,
      { chunkSize: 500 },
    )

    const chunks = eventsOfType(events, 'chunk')
    expect(chunks.map((chunk) => chunk.rows.length)).toEqual([500, 500, 250])
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2])
    expect(chunks[0]?.columns).toEqual([
      { name: 'n', dataType: 'integer', kind: 'number' },
      { name: 'label', dataType: 'text', kind: 'text' },
    ])
    expect(chunks[0]?.rows[0]).toEqual([1, 'row 1'])
    expect(eventsOfType(events, 'statement_done')).toMatchObject([
      {
        statementIndex: 0,
        command: 'SELECT',
        rowsReturned: 1250,
        rowsAffected: null,
        truncated: false,
      },
    ])
    expect(last(events)).toMatchObject({ type: 'done', statementCount: 1 })
    expectIpcSafe(events)
  })

  it('emits a chunk with the columns even when there are no rows', async () => {
    const session = await open(target)
    const events = await run(adapter, session, 'SELECT 1 AS a, true AS b WHERE false')
    expect(eventsOfType(events, 'chunk')).toMatchObject([
      {
        rows: [],
        columns: [
          { name: 'a', dataType: 'integer', kind: 'number' },
          { name: 'b', dataType: 'boolean', kind: 'boolean' },
        ],
      },
    ])
  })

  it('honors maxRows, reports truncation and leaves the session usable', async () => {
    const session = await open(target)
    const events = await run(adapter, session, 'SELECT g FROM generate_series(1, 1000) g', {
      maxRows: 100,
      chunkSize: 40,
    })
    expect(eventsOfType(events, 'chunk').map((chunk) => chunk.rows.length)).toEqual([40, 40, 20])
    expect(eventsOfType(events, 'statement_done')[0]).toMatchObject({
      rowsReturned: 100,
      truncated: true,
      rowsAffected: null,
    })
    expect(eventsOfType(events, 'notice')).toMatchObject([
      { level: 'warning', message: expect.stringContaining('100') },
    ])
    expect(last(events).type).toBe('done')

    const after = await run(adapter, session, 'SELECT 1')
    expect(last(after).type).toBe('done')
  })

  it('does not flag a result that fits exactly in maxRows as truncated', async () => {
    const session = await open(target)
    const events = await run(adapter, session, 'SELECT g FROM generate_series(1, 10) g', {
      maxRows: 10,
      chunkSize: 5,
    })
    expect(eventsOfType(events, 'chunk').map((chunk) => chunk.rows.length)).toEqual([5, 5])
    expect(eventsOfType(events, 'statement_done')[0]).toMatchObject({
      rowsReturned: 10,
      truncated: false,
    })
  })

  it('runs several statements in order, with per-statement results and affected rows', async () => {
    const session = await open(target)
    const events = await run(
      adapter,
      session,
      `CREATE TABLE ${schema}.scratch (id integer, note text);
       INSERT INTO ${schema}.scratch VALUES (1, 'a;b'), (2, 'c'), (3, 'd');
       SELECT id, note FROM ${schema}.scratch ORDER BY id;
       UPDATE ${schema}.scratch SET note = 'x' WHERE id < 3;
       DELETE FROM ${schema}.scratch WHERE id = 3;
       DROP TABLE ${schema}.scratch`,
    )
    expect(
      eventsOfType(events, 'statement_done').map(
        ({ statementIndex, command, rowsReturned, rowsAffected }) => [
          statementIndex,
          command,
          rowsReturned,
          rowsAffected,
        ],
      ),
    ).toEqual([
      [0, 'CREATE', 0, null],
      [1, 'INSERT', 0, 3],
      [2, 'SELECT', 3, null],
      [3, 'UPDATE', 0, 2],
      [4, 'DELETE', 0, 1],
      [5, 'DROP', 0, null],
    ])
    expect(eventsOfType(events, 'chunk')[0]?.rows[0]).toEqual([1, 'a;b'])
    expect(last(events)).toMatchObject({ type: 'done', statementCount: 6 })
    expectIpcSafe(events)
  })

  it('reports the rows of INSERT ... RETURNING both as a result set and as affected rows', async () => {
    const session = await open(target)
    const events = await run(
      adapter,
      session,
      `INSERT INTO ${schema}.people (name, age) VALUES ('Tim', 1), ('Ken', 2) RETURNING id, name`,
    )
    expect(eventsOfType(events, 'chunk')[0]?.rows.map((row) => row[1])).toEqual(['Tim', 'Ken'])
    expect(eventsOfType(events, 'statement_done')[0]).toMatchObject({
      command: 'INSERT',
      rowsReturned: 2,
      rowsAffected: 2,
    })
    await run(adapter, session, `DELETE FROM ${schema}.people WHERE name IN ('Tim', 'Ken')`)
  })

  it('does not split on semicolons in strings, comments, quoted identifiers or dollar-quoted bodies', async () => {
    const session = await open(target)
    const events = await run(
      adapter,
      session,
      `CREATE FUNCTION ${schema}.shout(t text) RETURNS text LANGUAGE plpgsql AS $body$
         BEGIN
           -- a comment; with a semicolon
           RETURN upper(t) || ';';
         END
       $body$;
       /* outer /* nested; */ still comment; */
       SELECT ${schema}.shout('it''s;') AS "we;ird", E'a\\';b' AS esc, $$x;y$$ AS dq`,
    )
    expect(last(events)).toMatchObject({ type: 'done', statementCount: 2 })
    expect(eventsOfType(events, 'chunk')[0]).toMatchObject({
      columns: [{ name: 'we;ird' }, { name: 'esc' }, { name: 'dq' }],
      rows: [["IT'S;;", "a';b", 'x;y']],
    })
  })

  it('reports a syntax error, stops the document there and keeps the message free of connection data', async () => {
    const session = await open(target)
    const events = await run(adapter, session, 'SELECT 1; SELEC 2; SELECT 3')
    expect(eventsOfType(events, 'chunk')).toHaveLength(1)
    expect(last(events)).toMatchObject({
      type: 'error',
      statementIndex: 1,
      error: { code: 'syntax_error', message: expect.stringContaining('SELEC') },
    })
    expect(events.some((event) => event.type === 'done')).toBe(false)
    const text = JSON.stringify(last(events))
    for (const secret of [target.appUser, target.appPassword, target.host]) {
      expect(text).not.toContain(secret)
    }
    expectIpcSafe(events)
  })

  it('maps runtime errors, constraint violations and missing objects to their own codes', async () => {
    const session = await open(target)
    expect(last(await run(adapter, session, 'SELECT 1 / 0'))).toMatchObject({
      type: 'error',
      error: { code: 'validation_failed' },
    })
    expect(
      last(await run(adapter, session, `INSERT INTO ${schema}.people (name) VALUES ('Ada')`)),
    ).toMatchObject({
      type: 'error',
      error: {
        code: 'constraint_violation',
        message: expect.stringContaining('people_name_key'),
        retryable: false,
      },
    })
    expect(last(await run(adapter, session, `SELECT * FROM ${schema}.nope`))).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    expect(last(await run(adapter, session, 'SELECT * FROM strata_no_such.t'))).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
  })

  it('reports permission_denied for a role without privileges', async () => {
    const session = await open(target, { role: 'limited' })
    const events = await run(adapter, session, `SELECT * FROM ${schema}.people`)
    expect(last(events)).toMatchObject({
      type: 'error',
      statementIndex: 0,
      error: { code: 'permission_denied', message: expect.stringContaining('permission denied') },
    })
  })

  it('rejects writes on a read-only profile but still serves reads', async () => {
    const session = await open(target, { readOnly: true })
    for (const sql of [
      `INSERT INTO ${schema}.people (name) VALUES ('Nope')`,
      `CREATE TABLE ${schema}.blocked (a int)`,
      `DELETE FROM ${schema}.people`,
    ]) {
      expect(last(await run(adapter, session, sql))).toMatchObject({
        type: 'error',
        error: { code: 'read_only_violation' },
      })
    }
    const read = await run(adapter, session, `SELECT count(*)::int FROM ${schema}.people`)
    expect(eventsOfType(read, 'chunk')[0]?.rows).toEqual([[3]])
  })

  it('delivers server notices with the statement that raised them', async () => {
    const session = await open(target)
    const events = await run(
      adapter,
      session,
      `SELECT 1;
       DO $$ BEGIN RAISE NOTICE 'hello %', 'world'; RAISE WARNING 'careful'; END $$;
       CREATE TABLE IF NOT EXISTS ${schema}.people (id int)`,
    )
    expect(eventsOfType(events, 'notice')).toMatchObject([
      { statementIndex: 1, level: 'info', message: 'hello world' },
      { statementIndex: 1, level: 'warning', message: 'careful' },
      { statementIndex: 2, level: 'info', message: expect.stringContaining('already exists') },
    ])
    const order = events.map((event) => event.type)
    expect(order.indexOf('notice')).toBeLessThan(order.indexOf('done'))
    expectIpcSafe(events)
  })

  it('converts special types to IPC-safe cells', async () => {
    const session = await open(target)
    const events = await run(
      adapter,
      session,
      `SET TIME ZONE 'UTC';
       SELECT 9223372036854775807::bigint AS big,
              12345678901234567890.123456789::numeric AS dec,
              '2024-01-15 10:30:00.123456+00'::timestamptz AS tz,
              '2024-01-15 10:30:00'::timestamp AS ts,
              '2024-01-15'::date AS d,
              '{"a": [1, 2]}'::jsonb AS doc,
              '{"a": 1}'::json AS raw,
              '\\xdeadbeef'::bytea AS bin,
              true AS flag,
              1.5::float8 AS f,
              'NaN'::float8 AS nan,
              7::smallint AS small,
              '11111111-2222-3333-4444-555555555555'::uuid AS id,
              ARRAY[1, 2, 3] AS nums,
              NULL::text AS nothing,
              '1 day 02:03:04'::interval AS span`,
    )
    const [chunk] = eventsOfType(events, 'chunk')
    expect(chunk?.columns.map(({ name, dataType, kind }) => [name, dataType, kind])).toEqual([
      ['big', 'bigint', 'number'],
      ['dec', 'numeric', 'number'],
      ['tz', 'timestamp with time zone', 'datetime'],
      ['ts', 'timestamp without time zone', 'datetime'],
      ['d', 'date', 'datetime'],
      ['doc', 'jsonb', 'json'],
      ['raw', 'json', 'json'],
      ['bin', 'bytea', 'binary'],
      ['flag', 'boolean', 'boolean'],
      ['f', 'double precision', 'number'],
      ['nan', 'double precision', 'number'],
      ['small', 'smallint', 'number'],
      ['id', 'uuid', 'uuid'],
      ['nums', 'integer[]', 'array'],
      ['nothing', 'text', 'text'],
      ['span', 'interval', 'datetime'],
    ])
    expect(chunk?.rows[0]).toEqual([
      '9223372036854775807',
      '12345678901234567890.123456789',
      '2024-01-15T10:30:00.123456+00:00',
      '2024-01-15T10:30:00',
      '2024-01-15',
      '{"a": [1, 2]}',
      '{"a": 1}',
      '0xdeadbeef',
      true,
      1.5,
      'NaN',
      7,
      '11111111-2222-3333-4444-555555555555',
      '{1,2,3}',
      null,
      '1 day 02:03:04',
    ])
    expectIpcSafe(events)
  })

  it('names column types with their modifiers and resolves enum and user-defined types', async () => {
    const session = await open(target)
    const events = await run(adapter, session, `SELECT * FROM ${schema}.priced`)
    const [chunk] = eventsOfType(events, 'chunk')
    expect(chunk?.columns.map((column) => column.dataType)).toEqual([
      'numeric(10,2)',
      'character varying(20)',
      'timestamp(3) without time zone',
      expect.stringMatching(/mood$/),
    ])
    expect(chunk?.rows[0]).toEqual(['12.50', 'abc', '2024-03-01T08:09:10.123', 'happy'])
  })

  it('classifies arrays of types missing from the built-in table as arrays', async () => {
    const session = await open(target)
    const events = await run(
      adapter,
      session,
      `SELECT ARRAY['sad', 'ok']::${schema}.mood[] AS moods, ARRAY['10.0.0.1']::inet[] AS hosts`,
    )
    const [chunk] = eventsOfType(events, 'chunk')
    expect(chunk?.columns.map(({ kind }) => kind)).toEqual(['array', 'array'])
    expect(chunk?.columns[1]?.dataType).toBe('inet[]')
  })

  it('keeps session state such as search_path between requests', async () => {
    const session = await open(target)
    await run(adapter, session, `SET search_path TO ${schema}`)
    const events = await run(adapter, session, 'SELECT count(*)::int FROM people')
    expect(eventsOfType(events, 'chunk')[0]?.rows).toEqual([[3]])
  })

  it('refuses COPY to or from the client instead of hanging', async () => {
    const session = await open(target)
    const events = await run(adapter, session, `COPY ${schema}.people TO STDOUT`)
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'validation_failed' } })
    expect(last(await run(adapter, session, 'SELECT 1')).type).toBe('done')
  })

  it('rejects a second request while one is running on the session', async () => {
    const session = await open(target)
    const first = stepper(
      adapter.execute(
        queryRequest(session.sessionId, 'SELECT g FROM generate_series(1, 100) g', {
          chunkSize: 10,
        }),
      ),
    )
    expect((await first.next())?.type).toBe('chunk')
    const second = await run(adapter, session, 'SELECT 1')
    expect(second).toMatchObject([{ type: 'error', error: { code: 'busy', retryable: true } }])
    await first.stop()
    expect(last(await run(adapter, session, 'SELECT 1')).type).toBe('done')
  })

  it('releases the session when the consumer stops early', async () => {
    const session = await open(target)
    const partial = stepper(
      adapter.execute(
        queryRequest(session.sessionId, 'SELECT g FROM generate_series(1, 5000) g', {
          chunkSize: 100,
        }),
      ),
    )
    await partial.next()
    await partial.stop()
    const after = await run(adapter, session, 'SELECT 42 AS answer')
    expect(eventsOfType(after, 'chunk')[0]?.rows).toEqual([[42]])
  })

  it('ends with a timeout error when timeoutMs is exceeded and stays usable', async () => {
    const session = await open(target)
    const startedAt = Date.now()
    const events = await run(adapter, session, 'SELECT pg_sleep(30)', { timeoutMs: 300 })
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(last(events)).toMatchObject({
      type: 'error',
      statementIndex: 0,
      error: { code: 'timeout', message: expect.stringContaining('300') },
    })
    expect(last(await run(adapter, session, 'SELECT 1')).type).toBe('done')
  })

  it('cancels a running pg_sleep for real and leaves the session usable', async () => {
    const session = await open(target)
    const request = queryRequest(session.sessionId, 'SELECT 1; SELECT pg_sleep(30); SELECT 3')
    const startedAt = Date.now()
    const pending = collect(adapter.execute(request))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await adapter.cancel(request.requestId)).toEqual({
      requestId: request.requestId,
      outcome: 'requested',
    })
    const events = await pending

    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(last(events)).toMatchObject({ type: 'cancelled', statementIndex: 1 })
    expect(eventsOfType(events, 'chunk')).toHaveLength(1)
    expect(events.some((event) => event.type === 'error' || event.type === 'done')).toBe(false)
    expect(await adapter.cancel(request.requestId)).toMatchObject({ outcome: 'not_running' })

    const after = await run(adapter, session, 'SELECT 7 AS n')
    expect(eventsOfType(after, 'chunk')[0]?.rows).toEqual([[7]])
    expectIpcSafe(events)
  })

  it('cancels between chunks when the consumer is paused', async () => {
    const session = await open(target)
    const request = queryRequest(session.sessionId, 'SELECT g FROM generate_series(1, 1000) g', {
      chunkSize: 10,
    })
    const stream = stepper(adapter.execute(request))
    expect((await stream.next())?.type).toBe('chunk')
    expect(await adapter.cancel(request.requestId)).toMatchObject({ outcome: 'requested' })
    expect((await stream.drain()).map((event) => event.type)).toEqual(['cancelled'])
    expect(last(await run(adapter, session, 'SELECT 1')).type).toBe('done')
  })

  it('reports not_running when cancelling an unknown request', async () => {
    expect(await adapter.cancel('never-existed')).toEqual({
      requestId: 'never-existed',
      outcome: 'not_running',
    })
  })

  it('cancels the running request when the session is disconnected', async () => {
    const session = await open(target)
    const pending = collect(adapter.execute(queryRequest(session.sessionId, 'SELECT pg_sleep(30)')))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const startedAt = Date.now()
    await adapter.disconnect(session.sessionId)
    const events = await pending
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(last(events).type).toBe('cancelled')
  })
})
