import type { Session } from '@strata/contracts'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createPostgresAdapter } from '../adapter'
import {
  asApp,
  collect,
  createSchema,
  describeEachTarget,
  dropSchema,
  eventsOfType,
  last,
  profileFor,
  queryRequest,
  run,
  type PgTarget,
} from './support'

const adapter = createPostgresAdapter()
const sessions: Session[] = []

async function open(target: PgTarget, overrides: Parameters<typeof profileFor>[1] = {}) {
  const session = await adapter.connect(profileFor(target, overrides))
  sessions.push(session)
  return session
}

const readOnlyRun = (session: Session, sql: string) =>
  run(adapter, session, sql, { enforceReadOnly: true })

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await adapter.disconnect(session.sessionId)
  }
})

// ADR 0012: the automatic execution of AI-generated SQL runs in a READ ONLY transaction that is always rolled back,
// because a SELECT can call functions the analyzer knows nothing about and PostgreSQL will not let them write there.
describeEachTarget('PostgreSQL read-only runs', (target) => {
  let schema = ''
  const audited = async (): Promise<number> =>
    asApp(target, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${schema}.audit`,
      )
      return rows[0]?.n ?? -1
    })

  beforeAll(async () => {
    schema = await createSchema(
      target,
      `CREATE TABLE $SCHEMA.items (id integer PRIMARY KEY, label text);
       INSERT INTO $SCHEMA.items VALUES (1, 'a'), (2, 'b');
       CREATE TABLE $SCHEMA.audit (id serial PRIMARY KEY);
       CREATE FUNCTION $SCHEMA.touch() RETURNS integer LANGUAGE sql VOLATILE
         AS $$ INSERT INTO $SCHEMA.audit DEFAULT VALUES RETURNING id $$;`,
    )
  })

  afterAll(async () => {
    await dropSchema(target, schema)
  })

  it('returns the rows and leaves the session outside any transaction', async () => {
    const session = await open(target)
    const events = await readOnlyRun(session, `SELECT id, label FROM ${schema}.items ORDER BY id`)

    expect(eventsOfType(events, 'chunk')[0]?.rows).toEqual([
      [1, 'a'],
      [2, 'b'],
    ])
    expect(last(events)).toMatchObject({ type: 'done', transaction: 'none' })
    expect(adapter.transactionState(session.sessionId)).toBe('none')
  })

  it('runs inside a READ ONLY transaction that does not outlive the run', async () => {
    const session = await open(target)
    const events = await readOnlyRun(
      session,
      `SELECT current_setting('transaction_read_only') AS ro, now() = statement_timestamp() AS fresh`,
    )
    expect(eventsOfType(events, 'chunk')[0]?.rows[0]?.[0]).toBe('on')

    const after = await run(adapter, session, `SELECT current_setting('transaction_read_only')`)
    expect(eventsOfType(after, 'chunk')[0]?.rows[0]?.[0]).toBe('off')
  })

  it('refuses the writes a function hides inside a SELECT, which the analyzer cannot see', async () => {
    const session = await open(target)
    const before = await audited()

    const events = await readOnlyRun(session, `SELECT ${schema}.touch()`)
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'read_only_violation' } })
    expect(await audited()).toBe(before)

    // Without the flag the very same statement writes: the transaction is what makes the difference.
    const unrestricted = await run(adapter, session, `SELECT ${schema}.touch()`)
    expect(last(unrestricted).type).toBe('done')
    expect(await audited()).toBe(before + 1)
  })

  it('rolls back and leaves no aborted transaction after an error', async () => {
    const session = await open(target)
    const events = await readOnlyRun(session, 'SELECT 1 / 0')

    expect(last(events)).toMatchObject({ type: 'error' })
    expect(adapter.transactionState(session.sessionId)).toBe('none')
    expect(last(await run(adapter, session, 'SELECT 1')).type).toBe('done')
  })

  it('cancels a slow query for real and ends its transaction', async () => {
    const session = await open(target)
    const request = queryRequest(session.sessionId, 'SELECT pg_sleep(30)', {
      enforceReadOnly: true,
    })
    const startedAt = Date.now()
    const pending = collect(adapter.execute(request))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await adapter.cancel(request.requestId)).toMatchObject({ outcome: 'requested' })
    const events = await pending

    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(last(events).type).toBe('cancelled')
    expect(adapter.transactionState(session.sessionId)).toBe('none')
  })

  it('refuses to run inside a transaction the user opened, without touching it', async () => {
    const session = await open(target)
    await adapter.begin(session.sessionId)

    const events = await readOnlyRun(session, 'SELECT 1')
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'validation_failed' } })
    expect(eventsOfType(events, 'chunk')).toEqual([])
    expect(adapter.transactionState(session.sessionId)).toBe('active')
  })

  it('refuses to run in an aborted transaction', async () => {
    const session = await open(target)
    await adapter.begin(session.sessionId)
    await run(adapter, session, 'SELECT 1 / 0')
    expect(adapter.transactionState(session.sessionId)).toBe('aborted')

    const events = await readOnlyRun(session, 'SELECT 1')
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'validation_failed' } })
    expect(adapter.transactionState(session.sessionId)).toBe('aborted')
  })

  it.each([
    'SELECT 1; COMMIT',
    'COMMIT',
    'ROLLBACK',
    'BEGIN READ WRITE; SELECT 1',
    `SELECT set_config('application_name', 'x', false)`,
    `INSERT INTO items VALUES (9, 'z')`,
    'SET default_transaction_read_only = off',
  ])('refuses text that is not plain queries: %s', async (sql) => {
    const session = await open(target)
    const events = await readOnlyRun(session, sql)

    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'validation_failed' } })
    expect(eventsOfType(events, 'chunk')).toEqual([])
    expect(adapter.transactionState(session.sessionId)).toBe('none')
  })

  it('also works on a read-only profile', async () => {
    const session = await open(target, { readOnly: true })
    const events = await readOnlyRun(session, `SELECT count(*)::int FROM ${schema}.items`)

    expect(eventsOfType(events, 'chunk')[0]?.rows).toEqual([[2]])
    expect(last(events)).toMatchObject({ type: 'done', transaction: 'none' })
  })

  it('a request without the flag keeps its usual behaviour (explicit transactions are not touched)', async () => {
    const session = await open(target)
    await adapter.begin(session.sessionId)
    const events = await run(adapter, session, 'SELECT 1')

    expect(last(events)).toMatchObject({ type: 'done', transaction: 'active' })
    await adapter.rollback(session.sessionId)
  })
})
