import { randomBytes } from 'node:crypto'
import type { QueryEvent, QueryRequest, Session } from '@strata/contracts'
import { Client } from 'pg'
import { describe, inject, it } from 'vitest'
import type { DatabaseAdapter, ResolvedPostgresProfile } from '../../adapter'
import { isAdapterError } from '../../normalization'
import type { PgTarget } from './target'

export type { PgTarget }

// Runs `define` once per PostgreSQL server the setup provided (13 and 17 in Docker, or the STRATA_TEST_PG_URL one).
// Without any server the suite is reported as skipped, with the reason in its name.
export function describeEachTarget(name: string, define: (target: PgTarget) => void): void {
  const targets = inject('pgTargets')
  if (targets.length === 0) {
    describe.skip(`${name} [skipped: no Docker daemon and STRATA_TEST_PG_URL is not set]`, () => {
      it('needs a PostgreSQL server', () => undefined)
    })
    return
  }
  for (const target of targets) {
    describe(`${name} (${target.label})`, () => define(target))
  }
}

export type Role = 'app' | 'limited'

export function profileFor(
  target: PgTarget,
  overrides: Partial<ResolvedPostgresProfile> & { role?: Role } = {},
): ResolvedPostgresProfile {
  const { role = 'app', ...rest } = overrides
  return {
    id: 'profile-1',
    name: 'integration',
    engine: 'postgres',
    host: target.host,
    port: target.port,
    user: role === 'app' ? target.appUser : target.limitedUser,
    database: target.database,
    ssl: 'disable',
    readOnly: false,
    password: role === 'app' ? target.appPassword : target.limitedPassword,
    ...rest,
  }
}

async function withClient<T>(
  target: PgTarget,
  user: string,
  password: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user,
    password,
  })
  client.on('error', () => undefined)
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

export const asAdmin = <T>(target: PgTarget, work: (client: Client) => Promise<T>): Promise<T> =>
  withClient(target, target.adminUser, target.adminPassword, work)

export const asApp = <T>(target: PgTarget, work: (client: Client) => Promise<T>): Promise<T> =>
  withClient(target, target.appUser, target.appPassword, work)

// One schema per suite keeps parallel test files apart. Objects are created by the app role, which owns the schema.
export async function createSchema(target: PgTarget, setupSql = ''): Promise<string> {
  const schema = `strata_${randomBytes(5).toString('hex')}`
  await asApp(target, async (client) => {
    await client.query(`CREATE SCHEMA ${schema}`)
    if (setupSql) {
      await client.query(setupSql.replaceAll('$SCHEMA', schema))
    }
  })
  return schema
}

export async function dropSchema(target: PgTarget, schema: string): Promise<void> {
  await asApp(target, (client) => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))
}

export function queryRequest(
  sessionId: string,
  sql: string,
  extra: Partial<QueryRequest> = {},
): QueryRequest {
  return { requestId: `req-${randomBytes(6).toString('hex')}`, sessionId, sql, ...extra }
}

export async function collect(events: AsyncIterable<QueryEvent>): Promise<QueryEvent[]> {
  const collected: QueryEvent[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

export function eventsOfType<T extends QueryEvent['type']>(
  events: readonly QueryEvent[],
  type: T,
): Extract<QueryEvent, { type: T }>[] {
  return events.filter((event): event is Extract<QueryEvent, { type: T }> => event.type === type)
}

export function last(events: readonly QueryEvent[]): QueryEvent {
  const event = events.at(-1)
  if (!event) throw new Error('no events')
  return event
}

export async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (isAdapterError(error)) return error.normalized
    throw error
  }
  throw new Error('expected rejection')
}

export async function run(
  adapter: DatabaseAdapter,
  session: Session,
  sql: string,
  extra: Partial<QueryRequest> = {},
): Promise<QueryEvent[]> {
  return collect(adapter.execute(queryRequest(session.sessionId, sql, extra)))
}

// Pulls one event at a time, so a test can act while a request is suspended between two of its events.
export function stepper(events: AsyncIterable<QueryEvent>) {
  const iterator = events[Symbol.asyncIterator]()
  return {
    async next(): Promise<QueryEvent | undefined> {
      const step = await iterator.next()
      return step.done ? undefined : step.value
    },
    async drain(): Promise<QueryEvent[]> {
      const rest: QueryEvent[] = []
      for (;;) {
        const step = await iterator.next()
        if (step.done) return rest
        rest.push(step.value)
      }
    },
    async stop(): Promise<void> {
      await iterator.return?.()
    },
  }
}

export async function pollUntil(
  condition: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
