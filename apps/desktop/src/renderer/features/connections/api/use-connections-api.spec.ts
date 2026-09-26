import { afterEach, describe, expect, it } from 'vitest'
import { createFakeDb, installFakeDb } from '../testing/fake-db'
import { useConnectionsApi } from './use-connections-api'

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
})

describe('useConnectionsApi', () => {
  it('passes successful results through', async () => {
    const { db } = createFakeDb()
    installFakeDb(db)

    await expect(useConnectionsApi().list()).resolves.toEqual({ ok: true, data: [] })
  })

  it('exposes normalized errors instead of throwing', async () => {
    const { db } = createFakeDb()
    installFakeDb(db)

    const result = await useConnectionsApi().connect({ profileId: 'p1' })

    expect(result).toMatchObject({ ok: false, error: { code: 'connection_failed' } })
  })

  it('turns a rejected IPC call into an internal error without leaking its text', async () => {
    const { db, connections } = createFakeDb()
    connections.list.mockRejectedValue(new Error('secret host db.internal'))
    installFakeDb(db)

    const result = await useConnectionsApi().list()

    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
    expect(JSON.stringify(result)).not.toContain('db.internal')
  })

  it('does not throw when window.db is missing', async () => {
    const result = await useConnectionsApi().list()

    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  })

  it('rejects malformed envelopes and payloads', async () => {
    const { db, connections } = createFakeDb()
    installFakeDb(db)
    const api = useConnectionsApi()

    connections.list.mockResolvedValue('nope' as never)
    expect(await api.list()).toMatchObject({ ok: false, error: { code: 'internal_error' } })

    connections.list.mockResolvedValue({ ok: true, data: [{ id: 1 }] } as never)
    expect(await api.list()).toMatchObject({ ok: false, error: { code: 'internal_error' } })

    connections.list.mockResolvedValue({ ok: false, error: { code: 'nope' } } as never)
    expect(await api.list()).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  })
})
