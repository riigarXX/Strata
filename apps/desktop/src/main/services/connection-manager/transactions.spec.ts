// @vitest-environment node
import { AdapterError, AdapterRegistry, createNormalizedError } from '@strata/db-core'
import { describe, expect, it, vi } from 'vitest'
import { createApprovedSqlitePaths } from './approved-sqlite-paths'
import { createConnectionManager } from './connection-manager'
import { createProfileStore } from './profile-store'
import { createFakeAdapter, createFakeCredentialStore, createMemoryFileSystem } from './testing'

const HOST = 'db.internal.example'
const PASSWORD = 'sup3r-s3cret-pw!'

async function setup(beforeSessionClose?: (sessionId: string) => Promise<void>) {
  const adapter = createFakeAdapter('postgres')
  adapter.begin = vi.fn(async (sessionId) => ({ sessionId, transaction: 'active' as const }))
  adapter.commit = vi.fn(async (sessionId) => ({ sessionId, transaction: 'none' as const }))
  adapter.rollback = vi.fn(async (sessionId) => ({ sessionId, transaction: 'none' as const }))
  const adapters = new AdapterRegistry()
  adapters.register(adapter)
  const memory = createMemoryFileSystem()
  const manager = createConnectionManager({
    profileStore: createProfileStore({ fileSystem: memory.fileSystem, filePath: '/ud/c.json' }),
    credentialStore: createFakeCredentialStore().store,
    adapters,
    approvedSqlitePaths: createApprovedSqlitePaths(),
    beforeSessionClose,
  })
  const profile = await manager.createProfile({
    engine: 'postgres',
    name: 'PG',
    readOnly: true,
    host: HOST,
    port: 5432,
    user: 'me',
    database: 'app',
    ssl: 'disable',
    password: PASSWORD,
  })
  const session = await manager.connect({ profileId: profile.id })
  return { manager, adapter, session, profile }
}

describe('ConnectionManager: transacciones', () => {
  it('begin, commit y rollback devuelven el estado que reporta el adapter', async () => {
    const { manager, session } = await setup()
    const { sessionId } = session

    await expect(manager.begin({ sessionId })).resolves.toEqual({
      sessionId,
      transaction: 'active',
    })
    await expect(manager.commit({ sessionId })).resolves.toEqual({ sessionId, transaction: 'none' })
    await expect(manager.rollback({ sessionId })).resolves.toEqual({
      sessionId,
      transaction: 'none',
    })
  })

  it('no_session si la sesión no existe', async () => {
    const { manager } = await setup()
    for (const operation of [manager.begin, manager.commit, manager.rollback]) {
      await expect(operation({ sessionId: 'nope' })).rejects.toMatchObject({
        normalized: { code: 'no_session' },
      })
    }
  })

  it('propaga busy del adapter y redacta host y password de cualquier fallo', async () => {
    const { manager, adapter, session } = await setup()
    adapter.begin = vi.fn(async () => {
      throw new AdapterError(createNormalizedError('busy', 'A query is running on this session'))
    })
    adapter.commit = vi.fn(async () => {
      throw new AdapterError({
        code: 'connection_failed',
        message: `lost ${HOST} using ${PASSWORD}`,
        retryable: true,
      })
    })

    await expect(manager.begin({ sessionId: session.sessionId })).rejects.toMatchObject({
      normalized: { code: 'busy' },
    })
    const failure = await manager.commit({ sessionId: session.sessionId }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(AdapterError)
    expect(JSON.stringify((failure as AdapterError).normalized)).not.toContain(HOST)
    expect(JSON.stringify((failure as AdapterError).normalized)).not.toContain(PASSWORD)
  })
})

describe('ConnectionManager: transactionState', () => {
  it('devuelve el estado que reporta el adapter en cada momento', async () => {
    const { manager, adapter, session } = await setup()
    const states = ['none', 'active', 'aborted'] as const
    let current: (typeof states)[number] = 'none'
    adapter.transactionState = vi.fn(() => current)

    for (const state of states) {
      current = state
      expect(manager.transactionState(session.sessionId)).toBe(state)
    }
  })

  it('devuelve undefined si la sesión no existe o el adapter ya no la conoce', async () => {
    const { manager, adapter, session } = await setup()
    adapter.transactionState = vi.fn(() => {
      throw new AdapterError(createNormalizedError('no_session', 'gone'))
    })

    expect(manager.transactionState('nope')).toBeUndefined()
    expect(manager.transactionState(session.sessionId)).toBeUndefined()
  })
})

describe('ConnectionManager: getSessionRuntime y beforeSessionClose', () => {
  it('expone sesión, adapter y contexto de redacción, con readOnly fijado por el perfil', async () => {
    const { manager, adapter, session } = await setup()

    const runtime = manager.getSessionRuntime(session.sessionId)

    expect(runtime?.adapter).toBe(adapter)
    expect(runtime?.session.readOnly).toBe(true)
    expect(runtime?.profileName).toBe('PG')
    expect(runtime?.redaction).toMatchObject({ host: HOST, secrets: [PASSWORD] })
    expect(manager.getSessionRuntime('nope')).toBeUndefined()
  })

  it('espera a beforeSessionClose antes de cerrar la sesión al desconectar y al cerrar todo', async () => {
    const order: string[] = []
    const hook = vi.fn(async (sessionId: string) => {
      order.push(`before:${sessionId}`)
    })
    const { manager, adapter, session } = await setup(hook)
    adapter.behavior.disconnect = async () => {
      order.push('disconnect')
    }

    await manager.disconnect({ sessionId: session.sessionId })
    expect(order).toEqual([`before:${session.sessionId}`, 'disconnect'])

    const reconnected = await manager.connect({ profileId: session.profileId })
    await manager.closeAll()
    expect(order.slice(2)).toEqual([`before:${reconnected.sessionId}`, 'disconnect'])
    expect(manager.getSessionRuntime(reconnected.sessionId)).toBeUndefined()
  })

  it('cambiar el perfil de una sesión abierta también pasa por el hook', async () => {
    const hook = vi.fn(async () => {})
    const { manager, session, profile } = await setup(hook)

    await manager.updateProfile({
      id: profile.id,
      engine: 'postgres',
      name: 'PG',
      readOnly: false,
      host: HOST,
      port: 5432,
      user: 'me',
      database: 'app',
      ssl: 'disable',
    })

    expect(hook).toHaveBeenCalledExactlyOnceWith(session.sessionId)
  })

  it('un fallo del hook no impide cerrar la sesión', async () => {
    const { manager, adapter, session } = await setup(async () => {
      throw new Error('boom')
    })

    await expect(manager.disconnect({ sessionId: session.sessionId })).resolves.toBeUndefined()
    expect(adapter.disconnected).toEqual([session.sessionId])
  })
})
