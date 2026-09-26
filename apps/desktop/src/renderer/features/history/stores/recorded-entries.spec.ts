import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { makeEntry } from '../testing/fake-history'
import { useRecordedEntriesStore } from './recorded-entries'

function setup() {
  const fake = createFakeDb()
  installFakeDb(fake.db)
  setActivePinia(createPinia())
  return { fake, store: useRecordedEntriesStore() }
}

const added = (requestId: string | undefined, id: string) =>
  ({
    type: 'added',
    entry: makeEntry(1, { id }),
    ...(requestId === undefined ? {} : { requestId }),
  }) as const

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
})

describe('recorded entries', () => {
  it('remembers which entry each run left, and nothing for a run that left none', () => {
    const { store } = setup()

    store.applyChange(added('r1', 'e1'))
    store.applyChange(added(undefined, 'e2'))

    expect(store.stateOf('r1')).toBe('recorded')
    expect(store.stateOf('r2')).toBeUndefined()
    expect(store.stateOf(null)).toBeUndefined()
  })

  it('keeps only ids: the SQL of the entry is never stored', () => {
    const { store } = setup()

    store.applyChange(added('r1', 'e1'))

    expect(JSON.stringify(store.$state)).not.toContain('select')
  })

  it('marks an entry as removed when main reports it deleted, cleared, and ignores purges', () => {
    const { store } = setup()
    store.applyChange(added('r1', 'e1'))
    store.applyChange(added('r2', 'e2'))
    store.applyChange(added('r3', 'e3'))

    store.applyChange({ type: 'removed', id: 'e1' })
    store.applyChange({ type: 'purged' })
    expect([store.stateOf('r1'), store.stateOf('r2'), store.stateOf('r3')]).toEqual([
      'removed',
      'recorded',
      'recorded',
    ])

    store.applyChange({ type: 'cleared' })
    expect([store.stateOf('r2'), store.stateOf('r3')]).toEqual(['removed', 'removed'])
  })

  it('excludes by deleting exactly that entry in main', async () => {
    const { store, fake } = setup()
    fake.history.delete.mockResolvedValueOnce(ipcOk({ deleted: 1 }))
    store.applyChange(added('r1', 'e1'))

    expect(await store.exclude('r1')).toEqual({ outcome: 'excluded' })

    expect(fake.history.delete).toHaveBeenCalledExactlyOnceWith({ id: 'e1' })
    expect(store.stateOf('r1')).toBe('removed')
  })

  it('reports an entry main no longer had as gone', async () => {
    const { store, fake } = setup()
    fake.history.delete.mockResolvedValueOnce(ipcOk({ deleted: 0 }))
    store.applyChange(added('r1', 'e1'))

    expect(await store.exclude('r1')).toEqual({ outcome: 'gone' })
    expect(store.stateOf('r1')).toBe('removed')
  })

  it('keeps the entry as recorded and returns the error when main fails', async () => {
    const { store, fake } = setup()
    const error = { code: 'internal_error', message: 'boom', retryable: true } as const
    fake.history.delete.mockResolvedValueOnce(ipcFail(error))
    store.applyChange(added('r1', 'e1'))

    expect(await store.exclude('r1')).toEqual({ outcome: 'error', error })
    expect(store.stateOf('r1')).toBe('recorded')
    expect(store.isExcluding('r1')).toBe(false)
  })

  it('does not send a second delete while one is in flight, nor for a run without entry', async () => {
    const { store, fake } = setup()
    fake.history.delete.mockImplementationOnce(async () => ipcOk({ deleted: 1 }))
    store.applyChange(added('r1', 'e1'))

    const first = store.exclude('r1')
    expect(store.isExcluding('r1')).toBe(true)
    expect(await store.exclude('r1')).toEqual({ outcome: 'gone' })
    await first
    expect(await store.exclude('nunca')).toEqual({ outcome: 'gone' })

    expect(fake.history.delete).toHaveBeenCalledTimes(1)
  })

  it('remembers a bounded number of runs, dropping the oldest', () => {
    const { store } = setup()

    for (let index = 0; index < 150; index++) store.applyChange(added(`r${index}`, `e${index}`))

    expect(store.stateOf('r0')).toBeUndefined()
    expect(store.stateOf('r49')).toBeUndefined()
    expect(store.stateOf('r50')).toBe('recorded')
    expect(store.stateOf('r149')).toBe('recorded')
  })
})
