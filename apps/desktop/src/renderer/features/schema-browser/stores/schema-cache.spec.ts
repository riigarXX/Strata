import type { NormalizedError } from '@strata/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { schemaKey, tableKey } from '../model/node-keys'
import { POSTGRES_CATALOG, SQLITE_CATALOG, table } from '../testing/catalog'
import { useSchemaCacheStore } from './schema-cache'

const TIMEOUT: NormalizedError = {
  code: 'timeout',
  message: 'The query timed out',
  retryable: true,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(catalog = POSTGRES_CATALOG) {
  const fake = createFakeDb({ catalog })
  installFakeDb(fake.db)
  setActivePinia(createPinia())
  return { ...fake, store: useSchemaCacheStore() }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
})

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('lazy loading', () => {
  it('loads schemas once and keeps them cached', async () => {
    const { store, metadata } = setup()
    await store.ensureSchemas('s1')
    await store.ensureSchemas('s1')

    expect(metadata.listSchemas).toHaveBeenCalledTimes(1)
    expect(metadata.listSchemas).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(store.sessions['s1']?.schemas?.data).toEqual([{ name: 'public' }, { name: 'Sales' }])
    expect(metadata.listTables).not.toHaveBeenCalled()
  })

  it('requests tables per schema and details per table only when asked, and only once', async () => {
    const { store, metadata } = setup()
    await store.ensureSchemas('s1')
    await store.ensureTables('s1', 'public')
    await store.ensureTables('s1', 'public')
    await store.ensureDetails('s1', table('public', 'users'))
    await store.ensureDetails('s1', table('public', 'users'))

    expect(metadata.listTables).toHaveBeenCalledTimes(1)
    expect(metadata.listTables).toHaveBeenCalledWith({ sessionId: 's1', schema: 'public' })
    expect(metadata.describeTable).toHaveBeenCalledTimes(1)
    expect(
      store.sessions['s1']?.details[tableKey(table('public', 'users'))]?.data?.columns,
    ).toHaveLength(3)
    expect(store.sessions['s1']?.tables['Sales']).toBeUndefined()
  })

  it('does not fire a second request while the first is still in flight', async () => {
    const { store, metadata } = setup()
    const first = store.ensureSchemas('s1')
    const second = store.ensureSchemas('s1')
    expect(store.sessions['s1']?.schemas?.status).toBe('loading')
    await Promise.all([first, second])
    expect(metadata.listSchemas).toHaveBeenCalledTimes(1)
  })

  it('opens the only schema by default and loads its tables', async () => {
    const { store, metadata } = setup(SQLITE_CATALOG)
    await store.ensureSchemas('s1')
    await Promise.resolve()

    expect(store.sessions['s1']?.toggled[schemaKey('main')]).toBe(true)
    expect(metadata.listTables).toHaveBeenCalledWith({ sessionId: 's1', schema: 'main' })
  })

  it('respects an earlier decision to collapse the only schema', async () => {
    const { store, metadata } = setup(SQLITE_CATALOG)
    await store.ensureSchemas('s1')
    store.setExpanded('s1', schemaKey('main'), false)
    await store.refresh('s1')
    expect(store.sessions['s1']?.toggled[schemaKey('main')]).toBe(false)
    expect(metadata.listTables).toHaveBeenCalledTimes(2)
  })

  it('keeps sessions apart', async () => {
    const { store, metadata } = setup()
    await store.ensureSchemas('s1')
    await store.ensureSchemas('s2')
    expect(metadata.listSchemas).toHaveBeenCalledTimes(2)
    expect(Object.keys(store.sessions)).toEqual(['s1', 's2'])
  })
})

describe('errors and retry', () => {
  it('stores a safe error as is and retries it on the next ensure', async () => {
    const { store, metadata } = setup()
    metadata.listSchemas.mockResolvedValueOnce(ipcFail(TIMEOUT))
    await store.ensureSchemas('s1')

    expect(store.sessions['s1']?.schemas).toMatchObject({
      status: 'error',
      error: TIMEOUT,
      data: null,
    })
    expect(store.notice).toContain('The query timed out')

    await store.ensureSchemas('s1')
    expect(store.sessions['s1']?.schemas?.status).toBe('ready')
    expect(metadata.listSchemas).toHaveBeenCalledTimes(2)
  })

  it('retries a failed table listing and a failed description independently', async () => {
    const { store, metadata } = setup()
    metadata.listTables.mockResolvedValueOnce(ipcFail(TIMEOUT))
    metadata.describeTable.mockResolvedValueOnce(ipcFail(TIMEOUT))
    await store.ensureTables('s1', 'public')
    await store.ensureDetails('s1', table('public', 'users'))
    expect(store.sessions['s1']?.tables['public']?.status).toBe('error')
    expect(store.sessions['s1']?.details[tableKey(table('public', 'users'))]?.status).toBe('error')

    await store.ensureTables('s1', 'public')
    expect(store.sessions['s1']?.tables['public']?.status).toBe('ready')
    expect(store.sessions['s1']?.details[tableKey(table('public', 'users'))]?.status).toBe('error')
  })

  it('turns a rejected IPC call into a generic error without leaking its text', async () => {
    const { store, metadata } = setup()
    metadata.listSchemas.mockRejectedValueOnce(new Error('secret host db.internal:5432'))
    await store.ensureSchemas('s1')
    expect(JSON.stringify(store.sessions['s1'])).not.toContain('db.internal')
    expect(store.sessions['s1']?.schemas?.error?.code).toBe('internal_error')
  })

  it('rejects malformed responses instead of storing them', async () => {
    const { store, metadata } = setup()
    metadata.listSchemas.mockResolvedValueOnce(ipcOk([{ name: 1 }] as never))
    await store.ensureSchemas('s1')
    expect(store.sessions['s1']?.schemas?.status).toBe('error')
  })
})

describe('refresh', () => {
  it('reloads schemas, loaded table lists and expanded tables, dropping other details', async () => {
    const { store, metadata } = setup()
    await store.ensureSchemas('s1')
    await store.ensureTables('s1', 'public')
    await store.ensureDetails('s1', table('public', 'users'))
    await store.ensureDetails('s1', table('public', 'orders'))
    store.setExpanded('s1', tableKey(table('public', 'users')), true)

    await store.refresh('s1')

    expect(metadata.listSchemas).toHaveBeenCalledTimes(2)
    expect(metadata.listTables).toHaveBeenCalledTimes(2)
    expect(metadata.describeTable).toHaveBeenCalledTimes(3)
    expect(Object.keys(store.sessions['s1']!.details)).toEqual([tableKey(table('public', 'users'))])
    expect(store.notice).toBe('Esquema actualizado.')
  })

  it('shows the previous data while reloading and picks up the new one', async () => {
    const { store, metadata } = setup()
    await store.ensureSchemas('s1')
    const pending = deferred<ReturnType<typeof ipcOk<{ name: string }[]>>>()
    metadata.listSchemas.mockReturnValueOnce(pending.promise)

    const refreshing = store.refresh('s1')
    expect(store.sessions['s1']?.schemas).toMatchObject({ status: 'loading' })
    expect(store.sessions['s1']?.schemas?.data).toHaveLength(2)

    pending.resolve(ipcOk([{ name: 'public' }, { name: 'Sales' }, { name: 'audit' }]))
    await refreshing
    expect(store.sessions['s1']?.schemas?.data).toHaveLength(3)
  })

  it('forgets table lists of schemas that no longer exist', async () => {
    const { store, metadata } = setup()
    await store.ensureSchemas('s1')
    await store.ensureTables('s1', 'Sales')
    metadata.listSchemas.mockResolvedValueOnce(ipcOk([{ name: 'public' }]))
    await store.refresh('s1')
    expect(store.sessions['s1']?.tables['Sales']).toBeUndefined()
  })

  it('reports partial failures and keeps the error visible on the failed node only', async () => {
    const { store, metadata } = setup()
    await store.ensureSchemas('s1')
    await store.ensureTables('s1', 'public')
    metadata.listTables.mockResolvedValueOnce(ipcFail(TIMEOUT))
    await store.refresh('s1')

    expect(store.notice).toBe('El esquema se actualizó con errores.')
    expect(store.sessions['s1']?.schemas?.status).toBe('ready')
    expect(store.sessions['s1']?.tables['public']?.status).toBe('error')
  })

  it('ignores the response of a request superseded by a newer refresh', async () => {
    const { store, metadata } = setup()
    const slow = deferred<ReturnType<typeof ipcOk<{ name: string }[]>>>()
    metadata.listSchemas.mockReturnValueOnce(slow.promise)
    const first = store.ensureSchemas('s1')
    await store.refresh('s1')
    expect(store.sessions['s1']?.schemas?.data).toHaveLength(2)

    slow.resolve(ipcOk([{ name: 'stale' }]))
    await first
    expect(store.sessions['s1']?.schemas?.data).toEqual([{ name: 'public' }, { name: 'Sales' }])
  })

  it('does nothing for an unknown session', async () => {
    const { store, metadata } = setup()
    await store.refresh('missing')
    expect(metadata.listSchemas).not.toHaveBeenCalled()
  })
})

describe('session lifecycle', () => {
  it('drops the cache of sessions that are no longer open', async () => {
    const { store } = setup()
    await store.ensureSchemas('s1')
    await store.ensureSchemas('s2')
    store.retainSessions(new Set(['s2']))
    expect(Object.keys(store.sessions)).toEqual(['s2'])
  })

  it('ignores a response that arrives after its session was dropped', async () => {
    const { store, metadata } = setup()
    const pending = deferred<ReturnType<typeof ipcOk<{ name: string }[]>>>()
    metadata.listSchemas.mockReturnValueOnce(pending.promise)
    const loading = store.ensureSchemas('s1')
    store.dropSession('s1')
    pending.resolve(ipcOk([{ name: 'public' }]))
    await loading
    expect(store.sessions['s1']).toBeUndefined()
  })

  it('does not keep secrets or query results: only catalog metadata reaches the state', async () => {
    const { store } = setup()
    await store.ensureSchemas('s1')
    await store.ensureTables('s1', 'public')
    await store.ensureDetails('s1', table('public', 'users'))
    const serialised = JSON.stringify({ sessions: store.sessions, notice: store.notice })
    expect(serialised).not.toMatch(/password|secret|"rows"|"results"/i)
    expect(serialised).toContain('users_email_key')
  })
})
