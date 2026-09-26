import { afterEach, describe, expect, it } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { makeEntry } from '../testing/fake-history'
import { useHistoryApi } from './use-history-api'

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
})

describe('useHistoryApi', () => {
  it('passes each request through and returns the validated answer', async () => {
    const fake = createFakeDb()
    installFakeDb(fake.db)
    fake.history.list.mockResolvedValueOnce(ipcOk({ entries: [makeEntry(1)], nextCursor: null }))
    fake.history.delete.mockResolvedValueOnce(ipcOk({ deleted: 1 }))
    fake.history.clear.mockResolvedValueOnce(ipcOk({ deleted: 4 }))
    const api = useHistoryApi()

    expect(await api.list({ search: 'x' })).toEqual({
      ok: true,
      data: { entries: [makeEntry(1)], nextCursor: null },
    })
    expect(fake.history.list).toHaveBeenCalledWith({ search: 'x' })
    expect(await api.delete({ id: 'entry-1' })).toEqual({ ok: true, data: { deleted: 1 } })
    expect(fake.history.delete).toHaveBeenCalledWith({ id: 'entry-1' })
    expect(await api.clear()).toEqual({ ok: true, data: { deleted: 4 } })
  })

  it('turns an exception, a missing bridge or a malformed answer into a normalised error', async () => {
    const fake = createFakeDb()
    installFakeDb(fake.db)
    fake.history.list.mockRejectedValueOnce(new Error('sender rejected'))
    expect(await useHistoryApi().list({})).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    })

    fake.history.clear.mockResolvedValueOnce(ipcOk({ deleted: -1 }))
    expect(await useHistoryApi().clear()).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    })

    fake.history.list.mockResolvedValueOnce(ipcOk({ entries: [{ id: 'x' }] } as never))
    expect(await useHistoryApi().list({})).toMatchObject({ ok: false })

    Reflect.deleteProperty(window, 'db')
    expect(await useHistoryApi().list({})).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    })
  })
})

describe('useHistoryApi.onChange', () => {
  it('delivers valid changes and drops what does not follow the contract', () => {
    const fake = createFakeDb()
    installFakeDb(fake.db)
    const seen: unknown[] = []
    useHistoryApi().onChange((change) => seen.push(change))

    fake.emitHistoryChange({ type: 'added', entry: makeEntry(1), requestId: 'r1' })
    fake.emitHistoryChange({ type: 'removed', id: 'entry-1' })
    fake.emitHistoryChange({ type: 'cleared' })
    fake.emitHistoryChange({ type: 'purged' })
    fake.emitHistoryChange({ type: 'added', entry: { id: 'x' } } as never)
    fake.emitHistoryChange({ type: 'removed' } as never)
    fake.emitHistoryChange({ type: 'unknown' } as never)
    fake.emitHistoryChange('purged' as never)

    expect(seen).toEqual([
      { type: 'added', entry: makeEntry(1), requestId: 'r1' },
      { type: 'removed', id: 'entry-1' },
      { type: 'cleared' },
      { type: 'purged' },
    ])
  })

  it('returns the unsubscribe function of the bridge', () => {
    const fake = createFakeDb()
    installFakeDb(fake.db)
    const seen: unknown[] = []

    const unsubscribe = useHistoryApi().onChange((change) => seen.push(change))
    expect(fake.historyListenerCount()).toBe(1)
    unsubscribe()
    fake.emitHistoryChange({ type: 'cleared' })

    expect(fake.historyListenerCount()).toBe(0)
    expect(seen).toEqual([])
  })
})
