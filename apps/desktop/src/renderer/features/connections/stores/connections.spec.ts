import type { ConnectionProfile, Session } from '@strata/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb, NO_ADAPTER_ERROR } from '../testing/fake-db'
import { useConnectionsStore } from './connections'

const sqliteProfile: ConnectionProfile = {
  id: 'p1',
  engine: 'sqlite',
  name: 'Local',
  readOnly: false,
  filePath: '/tmp/a.db',
}

const session: Session = {
  sessionId: 's1',
  profileId: 'p1',
  engine: 'sqlite',
  serverVersion: '3.46',
  readOnly: false,
  transaction: 'none',
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
})

describe('connections store', () => {
  it('loads profiles and selects the first one', async () => {
    installFakeDb(createFakeDb({ profiles: [sqliteProfile] }).db)
    const store = useConnectionsStore()

    await store.load()

    expect(store.loadStatus).toBe('ready')
    expect(store.selectedId).toBe('p1')
    expect(store.runtimeOf('p1').status).toBe('disconnected')
  })

  it('keeps the normalized error when listing fails', async () => {
    const { db, connections } = createFakeDb()
    connections.list.mockResolvedValue(ipcFail(NO_ADAPTER_ERROR))
    installFakeDb(db)
    const store = useConnectionsStore()

    await store.load()

    expect(store.loadStatus).toBe('error')
    expect(store.loadError).toEqual(NO_ADAPTER_ERROR)
  })

  it('stores the normalized error when connecting fails', async () => {
    installFakeDb(createFakeDb({ profiles: [sqliteProfile] }).db)
    const store = useConnectionsStore()
    await store.load()

    await store.connect('p1')

    expect(store.runtimeOf('p1')).toMatchObject({ status: 'error', error: NO_ADAPTER_ERROR })
  })

  it('connects, disconnects and reconnects', async () => {
    const { db, connections } = createFakeDb({
      profiles: [sqliteProfile],
      connectResult: ipcOk(session),
    })
    installFakeDb(db)
    const store = useConnectionsStore()
    await store.load()

    await store.connect('p1')
    expect(store.runtimeOf('p1')).toMatchObject({ status: 'connected', session })

    await store.reconnect('p1')
    expect(connections.disconnect).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(connections.connect).toHaveBeenCalledTimes(2)
    expect(store.runtimeOf('p1').status).toBe('connected')

    await store.disconnect('p1')
    expect(store.runtimeOf('p1').status).toBe('disconnected')
  })

  it('treats no_session on disconnect as already disconnected', async () => {
    const { db, connections } = createFakeDb({
      profiles: [sqliteProfile],
      connectResult: ipcOk(session),
    })
    connections.disconnect.mockResolvedValue(
      ipcFail({ code: 'no_session', message: 'Closed', retryable: false }),
    )
    installFakeDb(db)
    const store = useConnectionsStore()
    await store.load()
    await store.connect('p1')

    await store.disconnect('p1')

    expect(store.runtimeOf('p1').status).toBe('disconnected')
  })

  it('resets the runtime when an edit changes the connection target, not when only the name changes', async () => {
    installFakeDb(createFakeDb({ profiles: [sqliteProfile], connectResult: ipcOk(session) }).db)
    const store = useConnectionsStore()
    await store.load()
    await store.connect('p1')

    store.applySaved({ ...sqliteProfile, name: 'Renamed' })
    expect(store.runtimeOf('p1').status).toBe('connected')

    store.applySaved({ ...sqliteProfile, name: 'Renamed', readOnly: true })
    expect(store.runtimeOf('p1').status).toBe('disconnected')
  })

  it('removes a profile and moves the selection', async () => {
    const second = { ...sqliteProfile, id: 'p2', name: 'Other' }
    installFakeDb(createFakeDb({ profiles: [sqliteProfile, second] }).db)
    const store = useConnectionsStore()
    await store.load()

    expect(await store.remove('p1')).toBeNull()

    expect(store.profiles.map((profile) => profile.id)).toEqual(['p2'])
    expect(store.selectedId).toBe('p2')
  })

  it('applies the transaction state to the session that owns it and to no other', async () => {
    installFakeDb(createFakeDb({ profiles: [sqliteProfile], connectResult: ipcOk(session) }).db)
    const store = useConnectionsStore()
    await store.load()
    await store.connect('p1')

    store.applyTransaction('other', 'active')
    expect(store.runtimeOf('p1').session?.transaction).toBe('none')
    store.applyTransaction('s1', 'aborted')
    expect(store.runtimeOf('p1').session?.transaction).toBe('aborted')
  })

  it('never holds a password in its serialized state', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const { db } = createFakeDb()
    installFakeDb(db)
    const store = useConnectionsStore()
    await db.connections.create({
      engine: 'postgres',
      name: 'Prod',
      readOnly: false,
      host: 'localhost',
      port: 5432,
      user: 'me',
      database: 'app',
      ssl: 'disable',
      password: 'hunter2-secret',
    })
    await store.load()
    await store.testProfile('profile-1')

    expect(JSON.stringify(pinia.state.value)).not.toContain('hunter2-secret')
    expect(JSON.stringify(pinia.state.value)).not.toMatch(/password/i)
  })
})
