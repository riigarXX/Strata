import type { HistoryPage, NormalizedError } from '@strata/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { HISTORY_PAGE_SIZE } from '../model/filters'
import { HISTORY_NOW, makeEntries, makeEntry, stubHistory } from '../testing/fake-history'
import { CLOCK_TICK_MS, SEARCH_DEBOUNCE_MS, useHistoryStore } from './history'

const STORAGE_ERROR: NormalizedError = {
  code: 'internal_error',
  message: 'Could not read the history',
  retryable: true,
}

let fake: ReturnType<typeof createFakeDb>

function setup(entries = makeEntries(3)) {
  fake = createFakeDb()
  installFakeDb(fake.db)
  const backend = stubHistory(fake, entries)
  setActivePinia(createPinia())
  return { store: useHistoryStore(), backend }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'db')
})

describe('loading', () => {
  it('starts idle and loads the first page, most recent first', async () => {
    const { store } = setup()
    expect(store.status).toBe('idle')

    await store.load()

    expect(store.status).toBe('ready')
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-1', 'entry-2', 'entry-3'])
    expect(store.hasMore).toBe(false)
    expect(fake.history.list).toHaveBeenCalledWith({ limit: HISTORY_PAGE_SIZE })
  })

  it('reports a failed load as an error with no stale entries and recovers on retry', async () => {
    const { store } = setup()
    await store.load()
    fake.history.list.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    await store.load()

    expect(store.status).toBe('error')
    expect(store.error).toEqual(STORAGE_ERROR)
    expect(store.entries).toEqual([])

    await store.load()
    expect(store.status).toBe('ready')
    expect(store.error).toBeNull()
    expect(store.entries).toHaveLength(3)
  })

  it('treats a malformed answer as an error instead of trusting it', async () => {
    const { store } = setup()
    fake.history.list.mockResolvedValueOnce(ipcOk({ entries: 'nope' } as never))
    await store.load()
    expect(store.status).toBe('error')
    expect(store.error?.code).toBe('internal_error')
  })

  it('ignores the answer of a load that a newer one has replaced', async () => {
    const { store } = setup()
    let release!: (page: HistoryPage) => void
    fake.history.list.mockImplementationOnce(
      () => new Promise((resolve) => (release = (page) => resolve(ipcOk(page)))),
    )
    const stale = store.load()
    await store.load()
    release({ entries: [makeEntry(99)], nextCursor: null })
    await stale

    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-1', 'entry-2', 'entry-3'])
  })
})

describe('pagination', () => {
  it('appends the next page with the cursor of the last entry until there are no more', async () => {
    const { store } = setup(makeEntries(HISTORY_PAGE_SIZE + 5))
    await store.load()
    expect(store.entries).toHaveLength(HISTORY_PAGE_SIZE)
    expect(store.hasMore).toBe(true)

    await store.loadMore()

    expect(store.entries).toHaveLength(HISTORY_PAGE_SIZE + 5)
    expect(store.entries.at(-1)!.id).toBe(`entry-${HISTORY_PAGE_SIZE + 5}`)
    expect(store.hasMore).toBe(false)
    const secondRequest = fake.history.list.mock.calls[1]![0]
    expect(secondRequest.cursor).toMatch(/^\d+\.entry-50$/)
  })

  it('does nothing without a next page, before the first load or while another page is loading', async () => {
    const { store } = setup(makeEntries(HISTORY_PAGE_SIZE + 5))
    await store.loadMore()
    expect(fake.history.list).not.toHaveBeenCalled()

    await store.load()
    const first = store.loadMore()
    const second = store.loadMore()
    await Promise.all([first, second])
    expect(fake.history.list).toHaveBeenCalledTimes(2)
    expect(store.entries).toHaveLength(HISTORY_PAGE_SIZE + 5)
  })

  it('keeps what was loaded when a page fails and can retry it', async () => {
    const { store } = setup(makeEntries(HISTORY_PAGE_SIZE + 5))
    await store.load()
    fake.history.list.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    await store.loadMore()

    expect(store.status).toBe('ready')
    expect(store.moreError).toEqual(STORAGE_ERROR)
    expect(store.entries).toHaveLength(HISTORY_PAGE_SIZE)
    expect(store.loadingMore).toBe(false)

    await store.loadMore()
    expect(store.moreError).toBeNull()
    expect(store.entries).toHaveLength(HISTORY_PAGE_SIZE + 5)
  })

  it('never lists an entry twice', async () => {
    const { store } = setup(makeEntries(HISTORY_PAGE_SIZE + 5))
    await store.load()
    fake.history.list.mockResolvedValueOnce(
      ipcOk({ entries: [makeEntry(1), makeEntry(200)], nextCursor: null }),
    )

    await store.loadMore()

    expect(store.entries.filter((entry) => entry.id === 'entry-1')).toHaveLength(1)
    expect(store.entries.some((entry) => entry.id === 'entry-200')).toBe(true)
  })

  it('drops a page that arrives after a reload', async () => {
    const { store } = setup(makeEntries(HISTORY_PAGE_SIZE + 5))
    await store.load()
    let release!: (page: HistoryPage) => void
    fake.history.list.mockImplementationOnce(
      () => new Promise((resolve) => (release = (page) => resolve(ipcOk(page)))),
    )
    const late = store.loadMore()

    await store.load()
    release({ entries: [makeEntry(300)], nextCursor: null })
    await late

    expect(store.entries.some((entry) => entry.id === 'entry-300')).toBe(false)
    expect(store.entries).toHaveLength(HISTORY_PAGE_SIZE)
    expect(store.loadingMore).toBe(false)
  })
})

describe('search and filters', () => {
  it('debounces the search: the text updates at once, one request goes out after the pause', async () => {
    const { store } = setup(makeEntries(3))
    await store.load()
    fake.history.list.mockClear()

    store.setSearch('s')
    store.setSearch('se')
    store.setSearch('select 2')
    expect(store.filters.search).toBe('select 2')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1)
    expect(fake.history.list).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(fake.history.list).toHaveBeenCalledTimes(1)
    expect(fake.history.list).toHaveBeenCalledWith({ limit: HISTORY_PAGE_SIZE, search: 'select 2' })
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-2'])
    expect(store.filtered).toBe(true)
  })

  it('an explicit load skips the pending debounce', async () => {
    const { store } = setup()
    store.setSearch('select 1')
    await store.load()
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2)
    expect(fake.history.list).toHaveBeenCalledTimes(1)
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-1'])
  })

  it('filters by status, engine and connection at once and reloads from the first page', async () => {
    const { store } = setup([
      makeEntry(1, { status: 'error', errorCode: 'syntax_error' }),
      makeEntry(2, { engine: 'sqlite', profileId: 'sq1', profileName: 'Local' }),
      makeEntry(3, { status: 'cancelled' }),
      makeEntry(4),
    ])
    await store.setStatus('error')
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-1'])

    await store.setStatus(null)
    await store.setEngine('sqlite')
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-2'])

    await store.setEngine(null)
    await store.setProfile('pg1')
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-1', 'entry-3', 'entry-4'])
    expect(fake.history.list).toHaveBeenLastCalledWith({
      limit: HISTORY_PAGE_SIZE,
      profileId: 'pg1',
    })

    await store.setStatus('cancelled')
    expect(fake.history.list).toHaveBeenLastCalledWith({
      limit: HISTORY_PAGE_SIZE,
      status: 'cancelled',
      profileId: 'pg1',
    })
  })

  it('carries the active filters into the next page', async () => {
    const { store } = setup(makeEntries(HISTORY_PAGE_SIZE + 5, { status: 'error' }))
    await store.setStatus('error')
    await store.loadMore()
    expect(fake.history.list.mock.calls.at(-1)![0]).toMatchObject({ status: 'error' })
    expect(store.entries).toHaveLength(HISTORY_PAGE_SIZE + 5)
  })

  it('resets the filters and cancels a pending search without reloading', async () => {
    const { store } = setup()
    store.setSearch('x')
    await store.setStatus('ok')
    store.setSearch('y')
    store.resetFilters()
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2)

    expect(store.filters).toEqual({
      search: '',
      status: null,
      engine: null,
      profileId: null,
      from: '',
      to: '',
    })
    expect(store.filtered).toBe(false)
    expect(fake.history.list).toHaveBeenCalledTimes(1)
  })
})

describe('discarding', () => {
  it('forgets the entries and ignores a page that was still in flight', async () => {
    const { store } = setup()
    await store.load()
    let release!: (page: HistoryPage) => void
    fake.history.list.mockImplementationOnce(
      () => new Promise((resolve) => (release = (page) => resolve(ipcOk(page)))),
    )
    const pending = store.load()

    store.discard()
    release({ entries: makeEntries(2), nextCursor: null })
    await pending

    expect(store.entries).toEqual([])
    expect(store.status).toBe('idle')
    expect(store.hasMore).toBe(false)
  })
})

describe('deleting', () => {
  it('deletes one entry in main and drops it from the list', async () => {
    const { store, backend } = setup()
    await store.load()

    expect(await store.remove('entry-2')).toBe(true)

    expect(fake.history.delete).toHaveBeenCalledWith({ id: 'entry-2' })
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-1', 'entry-3'])
    expect(backend.entries()).toHaveLength(2)
  })

  it('keeps the entry and reports the error when main cannot delete it', async () => {
    const { store } = setup()
    await store.load()
    fake.history.delete.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    expect(await store.remove('entry-2')).toBe(false)

    expect(store.actionError).toEqual(STORAGE_ERROR)
    expect(store.entries).toHaveLength(3)

    expect(await store.remove('entry-2')).toBe(true)
    expect(store.actionError).toBeNull()
  })

  it('reloads when a delete empties the page but main still has more entries', async () => {
    const { store } = setup(makeEntries(HISTORY_PAGE_SIZE + 5))
    await store.load()
    for (const entry of store.entries.slice(0, -1)) await store.remove(entry.id)
    fake.history.list.mockClear()

    await store.remove(store.entries[0]!.id)

    expect(fake.history.list).toHaveBeenCalledTimes(1)
    expect(store.entries.length).toBeGreaterThan(0)
  })
})

describe('clearing', () => {
  it('empties the whole history, not only what the filters show, and returns how many went', async () => {
    const { store, backend } = setup(makeEntries(4))
    await store.setSearch('select 1')
    await store.load()
    expect(store.entries).toHaveLength(1)

    const result = await store.clear()

    expect(result).toEqual({ ok: true, data: { deleted: 4 } })
    expect(store.entries).toEqual([])
    expect(store.status).toBe('ready')
    expect(store.hasMore).toBe(false)
    expect(backend.entries()).toEqual([])
    expect(store.clearing).toBe(false)
  })

  it('leaves the list alone and returns the error when main fails', async () => {
    const { store } = setup()
    await store.load()
    fake.history.clear.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    expect(await store.clear()).toEqual({ ok: false, error: STORAGE_ERROR })

    expect(store.entries).toHaveLength(3)
    expect(store.clearing).toBe(false)
  })

  it('refuses a second clear while one is running', async () => {
    const { store } = setup()
    await store.load()
    const first = store.clear()
    const second = await store.clear()
    await first

    expect(second).toMatchObject({ ok: false, error: { code: 'busy' } })
    expect(fake.history.clear).toHaveBeenCalledTimes(1)
  })
})

describe('date filters', () => {
  const day = (offset: number) => {
    const date = new Date(2026, 8, 20 + offset)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  // Una entrada por día local, al mediodía: la 1 es del día 20, la 2 del 19, la 3 del 18…
  const perDay = () =>
    Array.from({ length: 5 }, (_, index) =>
      makeEntry(index + 1, { executedAt: new Date(2026, 8, 20 - index, 12).toISOString() }),
    )

  it('sends the local-day bounds and reloads from the first page', async () => {
    const { store } = setup(perDay())
    await store.load()

    await store.setFrom(day(-2))
    await store.setTo(day(-1))

    expect(fake.history.list.mock.calls.at(-1)![0]).toEqual({
      limit: HISTORY_PAGE_SIZE,
      from: new Date(2026, 8, 18, 0, 0, 0, 0).toISOString(),
      to: new Date(2026, 8, 19, 23, 59, 59, 999).toISOString(),
    })
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-2', 'entry-3'])
    expect(store.filtered).toBe(true)
  })

  it('carries the range into the next page', async () => {
    const { store } = setup(
      makeEntries(HISTORY_PAGE_SIZE + 5, {
        executedAt: new Date(2026, 8, 20, 12).toISOString(),
      }).map((entry, index) => ({
        ...entry,
        executedAt: new Date(2026, 8, 20, 12, 0, 0, HISTORY_PAGE_SIZE + 5 - index).toISOString(),
      })),
    )
    await store.setFrom(day(0))
    await store.loadMore()

    expect(fake.history.list.mock.calls.at(-1)![0]).toMatchObject({
      from: new Date(2026, 8, 20, 0, 0, 0, 0).toISOString(),
      cursor: expect.any(String),
    })
    expect(store.entries).toHaveLength(HISTORY_PAGE_SIZE + 5)
  })

  it('does not ask main for an inverted range and explains why', async () => {
    const { store } = setup(perDay())
    await store.load()
    fake.history.list.mockClear()

    await store.setFrom(day(0))
    await store.setTo(day(-3))

    expect(store.dateProblem).toBe('inverted')
    expect(fake.history.list).toHaveBeenCalledTimes(1)
    expect(store.status).toBe('ready')

    await store.setTo(day(0))
    expect(store.dateProblem).toBeNull()
    expect(fake.history.list).toHaveBeenCalledTimes(2)
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-1'])
  })

  it('an in-flight page does not survive an invalid range', async () => {
    const { store } = setup(perDay())
    let release!: (page: HistoryPage) => void
    fake.history.list.mockImplementationOnce(
      () => new Promise((resolve) => (release = (page) => resolve(ipcOk(page)))),
    )
    const pending = store.load()
    store.filters.from = day(0)
    store.filters.to = day(-1)
    await store.load()
    release({ entries: [makeEntry(9)], nextCursor: null })
    await pending

    expect(store.entries).toEqual([])
    expect(store.status).toBe('ready')
  })

  it('is cleared by resetFilters', async () => {
    const { store } = setup(perDay())
    await store.setFrom(day(-1))
    store.resetFilters()

    expect(store.filters.from).toBe('')
    expect(store.filtered).toBe(false)
  })
})

describe('live changes', () => {
  async function open(entries = makeEntries(3)) {
    const ctx = setup(entries)
    await ctx.store.load()
    return ctx
  }
  const fresh = (id: number, overrides = {}) =>
    makeEntry(id, {
      id: `new-${id}`,
      executedAt: new Date(HISTORY_NOW + id).toISOString(),
      ...overrides,
    })

  it('inserts an added entry at the top without touching the rest', async () => {
    const { store } = await open()
    const before = [...store.entries]

    store.applyChange({ type: 'added', entry: fresh(1) })

    expect(store.entries.map((entry) => entry.id)).toEqual(['new-1', ...before.map((e) => e.id)])
    expect(store.entries.slice(1)).toEqual(before)
    expect(store.arrivals).toBe(1)
    expect(fake.history.list).toHaveBeenCalledTimes(1)
  })

  it('keeps the order when an older execution finishes later', async () => {
    const { store } = await open()

    store.applyChange({
      type: 'added',
      entry: makeEntry(9, {
        id: 'between',
        executedAt: makeEntry(2).executedAt.replace(/\d\d\.\d{3}Z$/, '30.000Z'),
      }),
    })

    expect(store.entries.map((entry) => entry.id)).toEqual([
      'entry-1',
      'between',
      'entry-2',
      'entry-3',
    ])
  })

  it('ignores an entry it already has, and one that does not match the search or filters', async () => {
    const { store } = await open()

    store.applyChange({ type: 'added', entry: store.entries[0]! })
    store.filters.search = 'orders'
    store.applyChange({ type: 'added', entry: fresh(1) })
    store.filters.search = ''
    store.filters.status = 'error'
    store.applyChange({ type: 'added', entry: fresh(2) })

    expect(store.entries).toHaveLength(3)
    expect(store.arrivals).toBe(0)
  })

  it('inserts an entry that matches the active search and the date range', async () => {
    const { store } = await open()
    store.filters.search = 'USERS'
    store.filters.from = '2000-01-01'

    store.applyChange({ type: 'added', entry: fresh(1) })

    expect(store.entries[0]?.id).toBe('new-1')
  })

  it('leaves an entry older than everything loaded for the next page when there is more', async () => {
    const { store } = await open(makeEntries(HISTORY_PAGE_SIZE + 5))
    expect(store.hasMore).toBe(true)

    store.applyChange({
      type: 'added',
      entry: makeEntry(9999, { id: 'ancient', executedAt: '2000-01-01T00:00:00.000Z' }),
    })

    expect(store.entries.some((entry) => entry.id === 'ancient')).toBe(false)
  })

  it('does nothing while the panel is closed: no SQL is kept in memory', async () => {
    const { store } = setup()

    store.applyChange({ type: 'added', entry: fresh(1) })
    store.applyChange({ type: 'cleared' })
    await store.load()
    store.discard()
    store.applyChange({ type: 'added', entry: fresh(2) })

    expect(store.entries).toEqual([])
    expect(store.status).toBe('idle')
  })

  it('drops a removed entry and reloads when that empties the page but there are more', async () => {
    const { store } = await open()
    store.applyChange({ type: 'removed', id: 'entry-2' })
    expect(store.entries.map((entry) => entry.id)).toEqual(['entry-1', 'entry-3'])

    store.applyChange({ type: 'removed', id: 'nunca-estuvo' })
    expect(store.entries).toHaveLength(2)

    const more = await open(makeEntries(HISTORY_PAGE_SIZE + 5))
    for (const entry of more.store.entries.slice(1)) {
      more.store.applyChange({ type: 'removed', id: entry.id })
    }
    fake.history.list.mockClear()
    more.store.applyChange({ type: 'removed', id: more.store.entries[0]!.id })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.history.list).toHaveBeenCalledTimes(1)
  })

  it('empties the list on a cleared change', async () => {
    const { store } = await open()

    store.applyChange({ type: 'cleared' })

    expect(store.entries).toEqual([])
    expect(store.status).toBe('ready')
    expect(store.hasMore).toBe(false)
  })

  it('reloads the first page with the same filters after a purge', async () => {
    const { store, backend } = await open()
    await store.setStatus('ok')
    backend
      .entries()
      .slice(1)
      .forEach((entry) => void store.remove(entry.id))
    fake.history.list.mockClear()

    store.applyChange({ type: 'purged' })
    await vi.advanceTimersByTimeAsync(0)

    expect(fake.history.list).toHaveBeenCalledExactlyOnceWith({
      limit: HISTORY_PAGE_SIZE,
      status: 'ok',
    })
  })

  it('reloads once more when a change arrives while the list is loading', async () => {
    const { store, backend } = setup()
    let release!: (page: HistoryPage) => void
    fake.history.list.mockImplementationOnce(
      () => new Promise((resolve) => (release = (page) => resolve(ipcOk(page)))),
    )
    const loading = store.load()

    backend.add(fresh(1))
    store.applyChange({ type: 'added', entry: fresh(1) })
    release({ entries: [], nextCursor: null })
    await loading
    await vi.advanceTimersByTimeAsync(0)

    expect(store.entries[0]?.id).toBe('new-1')
    expect(fake.history.list).toHaveBeenCalledTimes(2)
  })

  it('ignores changes after a failed load', async () => {
    const { store } = setup()
    fake.history.list.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))
    await store.load()

    store.applyChange({ type: 'added', entry: fresh(1) })

    expect(store.status).toBe('error')
    expect(store.entries).toEqual([])
  })
})

describe('relative-date clock', () => {
  it('refreshes `now` on every tick while running and stops when the list is discarded', async () => {
    const { store } = setup()
    await store.load()
    const first = store.now

    store.startClock()
    await vi.advanceTimersByTimeAsync(CLOCK_TICK_MS)
    const second = store.now
    await vi.advanceTimersByTimeAsync(CLOCK_TICK_MS)

    expect(second).toBeGreaterThan(first)
    expect(store.now).toBeGreaterThan(second)

    store.discard()
    const stopped = store.now
    await vi.advanceTimersByTimeAsync(CLOCK_TICK_MS * 3)

    expect(store.now).toBe(stopped)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never stacks timers when started twice', async () => {
    const { store } = setup()

    store.startClock()
    store.startClock()

    expect(vi.getTimerCount()).toBe(1)
    store.discard()
  })
})
