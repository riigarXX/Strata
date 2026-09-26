import { createServer } from 'node:net'
import { TestConnectionResultSchema, type Session } from '@strata/contracts'
import { afterEach, expect, it } from 'vitest'
import { createPostgresAdapter } from '../adapter'
import {
  asAdmin,
  describeEachTarget,
  eventsOfType,
  pollUntil,
  profileFor,
  rejection,
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

const connectionsOf = (target: PgTarget, user: string): Promise<number> =>
  asAdmin(target, async (client) => {
    const { rows } = await client.query<{ total: string }>(
      'SELECT count(*) AS total FROM pg_stat_activity WHERE usename = $1',
      [user],
    )
    return Number(rows[0]?.total)
  })

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (typeof address !== 'object' || address === null) throw new Error('no port')
  return address.port
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await adapter.disconnect(session.sessionId)
  }
})

describeEachTarget('PostgreSQL connection', (target) => {
  const forbidden = (): string[] => [
    target.host,
    target.appUser,
    target.limitedUser,
    target.appPassword,
    target.database,
    String(target.port),
  ]

  it('declares the capabilities it really provides', () => {
    expect(adapter.engine).toBe('postgres')
    expect(adapter.capabilities).toEqual({
      cancellation: true,
      cancellationMode: 'immediate',
      schemas: true,
      explain: false,
      transactions: true,
      readOnlyMode: true,
    })
  })

  it('tests a connection, reports the server version and leaves no connection behind', async () => {
    const profile = profileFor(target, { role: 'limited' })
    const result = await adapter.testConnection(profile)
    expect(TestConnectionResultSchema.parse(result)).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('unreachable')
    expect(result.serverVersion.startsWith(target.version.split('.')[0] ?? '')).toBe(true)
    expect(result.latencyMs).toBeGreaterThan(0)
    await pollUntil(async () => (await connectionsOf(target, target.limitedUser)) === 0)
  })

  it('rejects a server older than the supported minimum with unsupported_version', async () => {
    const strict = createPostgresAdapter({ minimumMajorVersion: 99 })
    const profile = profileFor(target, { role: 'limited' })
    const result = await strict.testConnection(profile)
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported_version' } })
    expect((await rejection(strict.connect(profile))).code).toBe('unsupported_version')
    await pollUntil(async () => (await connectionsOf(target, target.limitedUser)) === 0)
  })

  it('connects, describes the session and disconnects idempotently', async () => {
    const session = await open(target, { role: 'limited' })
    expect(session).toMatchObject({
      profileId: 'profile-1',
      engine: 'postgres',
      readOnly: false,
      transaction: 'none',
    })
    expect(await connectionsOf(target, target.limitedUser)).toBe(1)

    await adapter.disconnect(session.sessionId)
    await adapter.disconnect(session.sessionId)
    await pollUntil(async () => (await connectionsOf(target, target.limitedUser)) === 0)

    const events = await run(adapter, session, 'SELECT 1')
    expect(events).toMatchObject([{ type: 'error', error: { code: 'no_session' } }])
  })

  it('fails authentication without echoing user, password, host or database', async () => {
    const profile = profileFor(target, { password: 'definitely-wrong-password' })
    const result = await adapter.testConnection(profile)
    expect(result).toMatchObject({ ok: false, error: { code: 'authentication_failed' } })
    const error = await rejection(adapter.connect(profile))
    expect(error.code).toBe('authentication_failed')
    for (const text of [JSON.stringify(result), JSON.stringify(error)]) {
      for (const secret of [...forbidden(), 'definitely-wrong-password']) {
        expect(text).not.toContain(secret)
      }
    }
  })

  it('reports a missing database as connection_failed without naming it', async () => {
    const profile = profileFor(target, { database: 'strata_no_such_database' })
    const error = await rejection(adapter.connect(profile))
    expect(error).toMatchObject({ code: 'connection_failed' })
    expect(JSON.stringify(error)).not.toContain('strata_no_such_database')
    expect(JSON.stringify(error)).not.toContain(target.appUser)
  })

  it('reports a refused connection without leaking the address', async () => {
    const port = await freePort()
    const error = await rejection(adapter.connect(profileFor(target, { host: '127.0.0.1', port })))
    expect(error).toMatchObject({ code: 'connection_failed', retryable: true })
    expect(JSON.stringify(error)).not.toContain('127.0.0.1')
    expect(JSON.stringify(error)).not.toContain(String(port))
  })

  it('reports an unresolvable host as connection_failed without naming it', async () => {
    const host = 'strata-no-such-host.invalid'
    const error = await rejection(adapter.connect(profileFor(target, { host })))
    expect(error.code).toBe('connection_failed')
    expect(JSON.stringify(error)).not.toContain(host)
  })

  it('forces default_transaction_read_only for a read-only profile only', async () => {
    const readOnly = await open(target, { readOnly: true })
    const normal = await open(target)
    const setting = async (session: Session) =>
      eventsOfType(await run(adapter, session, 'SHOW default_transaction_read_only'), 'chunk')[0]
        ?.rows[0]?.[0]
    expect(readOnly.readOnly).toBe(true)
    expect(await setting(readOnly)).toBe('on')
    expect(await setting(normal)).toBe('off')
  })

  it.skipIf(!target.tls)('encrypts the connection when the profile asks for TLS', async () => {
    const session = await open(target, { ssl: 'require' })
    const events = await run(
      adapter,
      session,
      'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
    )
    expect(eventsOfType(events, 'chunk')[0]?.rows).toEqual([[true]])
  })

  it.skipIf(!target.tls)(
    'rejects an unverifiable certificate under verify-full without leaking details',
    async () => {
      const error = await rejection(adapter.connect(profileFor(target, { ssl: 'verify-full' })))
      expect(error.code).toBe('connection_failed')
      for (const secret of forbidden()) {
        expect(JSON.stringify(error)).not.toContain(secret)
      }
    },
  )

  it('reports a connection the server terminated as connection_failed and keeps working afterwards', async () => {
    const session = await open(target)
    const pidEvents = await run(adapter, session, 'SELECT pg_backend_pid()')
    const pid = Number(eventsOfType(pidEvents, 'chunk')[0]?.rows[0]?.[0])
    const terminate = () =>
      asAdmin(target, (client) => client.query('SELECT pg_terminate_backend($1)', [pid]))

    await terminate()
    await pollUntil(async () => {
      const events = await run(adapter, session, 'SELECT 1')
      return events.some((event) => event.type === 'error')
    })
    const events = await run(adapter, session, 'SELECT 1')
    expect(events).toMatchObject([{ type: 'error', error: { code: 'connection_failed' } }])
    expect(JSON.stringify(events)).not.toContain(target.appUser)
    await adapter.disconnect(session.sessionId)

    const fresh = await open(target)
    expect(fresh.sessionId).not.toBe(session.sessionId)
  })

  it('reports a backend terminated in the middle of a query as an error event', async () => {
    const session = await open(target)
    const pidEvents = await run(adapter, session, 'SELECT pg_backend_pid()')
    const pid = Number(eventsOfType(pidEvents, 'chunk')[0]?.rows[0]?.[0])
    const pending = run(adapter, session, 'SELECT pg_sleep(30)')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await asAdmin(target, (client) => client.query('SELECT pg_terminate_backend($1)', [pid]))
    const events = await pending
    expect(events).toMatchObject([{ type: 'error', error: { code: 'connection_failed' } }])
  })

  it('closes every session it opened when disconnected', async () => {
    const opened = await Promise.all([
      open(target, { role: 'limited' }),
      open(target, { role: 'limited' }),
    ])
    expect(await connectionsOf(target, target.limitedUser)).toBe(2)
    await Promise.all(opened.map((session) => adapter.disconnect(session.sessionId)))
    await pollUntil(async () => (await connectionsOf(target, target.limitedUser)) === 0)
  })
})
