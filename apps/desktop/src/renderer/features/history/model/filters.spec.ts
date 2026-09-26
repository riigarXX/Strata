import { HISTORY_LIMITS } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { makeEntry } from '../testing/fake-history'
import {
  buildListRequest,
  dateRangeProblem,
  entryMatchesFilters,
  hasActiveFilters,
  HISTORY_PAGE_SIZE,
  NO_FILTERS,
} from './filters'

describe('buildListRequest', () => {
  it('asks only for the page size when there are no filters', () => {
    expect(buildListRequest(NO_FILTERS)).toEqual({ limit: HISTORY_PAGE_SIZE })
  })

  it('carries the active filters and the cursor, trimming the search text', () => {
    expect(
      buildListRequest(
        { ...NO_FILTERS, search: '  users  ', status: 'error', engine: 'sqlite', profileId: 'p-1' },
        '123.abc',
      ),
    ).toEqual({
      limit: HISTORY_PAGE_SIZE,
      search: 'users',
      status: 'error',
      engine: 'sqlite',
      profileId: 'p-1',
      cursor: '123.abc',
    })
  })

  it('omits a blank search and caps a long one to what the contract accepts', () => {
    expect(buildListRequest({ ...NO_FILTERS, search: '   ' })).not.toHaveProperty('search')
    const long = buildListRequest({ ...NO_FILTERS, search: 'x'.repeat(2_000) })
    expect(long.search).toHaveLength(HISTORY_LIMITS.searchMaxChars)
  })
})

describe('hasActiveFilters', () => {
  it('is false for the defaults and for a blank search, true for any other filter', () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false)
    expect(hasActiveFilters({ ...NO_FILTERS, search: '  ' })).toBe(false)
    expect(hasActiveFilters({ ...NO_FILTERS, search: 'a' })).toBe(true)
    expect(hasActiveFilters({ ...NO_FILTERS, status: 'ok' })).toBe(true)
    expect(hasActiveFilters({ ...NO_FILTERS, engine: 'postgres' })).toBe(true)
    expect(hasActiveFilters({ ...NO_FILTERS, profileId: 'p' })).toBe(true)
    expect(hasActiveFilters({ ...NO_FILTERS, from: '2026-09-01' })).toBe(true)
    expect(hasActiveFilters({ ...NO_FILTERS, to: '2026-09-30' })).toBe(true)
  })
})

describe('date filters', () => {
  // Las fechas son del día local del usuario: los límites se calculan con la misma zona horaria que la aplicación.
  const startOf = (year: number, month: number, day: number) =>
    new Date(year, month - 1, day, 0, 0, 0, 0).toISOString()
  const endOf = (year: number, month: number, day: number) =>
    new Date(year, month - 1, day, 23, 59, 59, 999).toISOString()

  it('turns «from» into the start of the local day and «to» into its last millisecond', () => {
    expect(buildListRequest({ ...NO_FILTERS, from: '2026-09-20', to: '2026-09-22' })).toMatchObject(
      {
        from: startOf(2026, 9, 20),
        to: endOf(2026, 9, 22),
      },
    )
  })

  it('accepts a single bound and the same day on both ends', () => {
    const only = buildListRequest({ ...NO_FILTERS, from: '2026-09-20' })
    expect(only).toHaveProperty('from')
    expect(only).not.toHaveProperty('to')
    expect(dateRangeProblem({ ...NO_FILTERS, from: '2026-09-20', to: '2026-09-20' })).toBeNull()
  })

  it('produces dates the contract accepts', async () => {
    const { HistoryListRequestSchema } = await import('@strata/contracts')
    const request = buildListRequest({ ...NO_FILTERS, from: '2026-01-01', to: '2026-12-31' })
    expect(HistoryListRequestSchema.safeParse(request).success).toBe(true)
  })

  it('skips a date that is not a real day instead of sending garbage', () => {
    for (const from of [
      '2026-02-31',
      '2026-13-01',
      '26-01-01',
      '010000-01-01',
      '1969-12-31',
      'x',
    ]) {
      expect(buildListRequest({ ...NO_FILTERS, from })).not.toHaveProperty('from')
    }
  })

  it('reports why a range cannot be requested', () => {
    expect(dateRangeProblem(NO_FILTERS)).toBeNull()
    expect(dateRangeProblem({ ...NO_FILTERS, from: '2026-02-31' })).toBe('invalid-from')
    expect(dateRangeProblem({ ...NO_FILTERS, to: 'mañana' })).toBe('invalid-to')
    expect(dateRangeProblem({ ...NO_FILTERS, from: '2026-09-21', to: '2026-09-20' })).toBe(
      'inverted',
    )
    expect(dateRangeProblem({ ...NO_FILTERS, from: '2026-09-20', to: '2026-09-21' })).toBeNull()
  })
})

describe('entryMatchesFilters', () => {
  const entry = makeEntry(1, {
    sql: 'SELECT * FROM Users',
    executedAt: new Date(2026, 8, 20, 12).toISOString(),
  })

  it('matches everything without filters', () => {
    expect(entryMatchesFilters(entry, NO_FILTERS)).toBe(true)
  })

  it('applies search (case-insensitive, trimmed), status, engine and profile', () => {
    expect(entryMatchesFilters(entry, { ...NO_FILTERS, search: '  users ' })).toBe(true)
    expect(entryMatchesFilters(entry, { ...NO_FILTERS, search: 'orders' })).toBe(false)
    expect(entryMatchesFilters(entry, { ...NO_FILTERS, status: 'error' })).toBe(false)
    expect(entryMatchesFilters(entry, { ...NO_FILTERS, status: 'ok' })).toBe(true)
    expect(entryMatchesFilters(entry, { ...NO_FILTERS, engine: 'sqlite' })).toBe(false)
    expect(entryMatchesFilters(entry, { ...NO_FILTERS, profileId: 'pg1' })).toBe(true)
    expect(entryMatchesFilters(entry, { ...NO_FILTERS, profileId: 'other' })).toBe(false)
  })

  it('applies the local day range with both ends inclusive', () => {
    const at = (h: number, m: number, s: number, ms: number) =>
      makeEntry(1, { executedAt: new Date(2026, 8, 20, h, m, s, ms).toISOString() })
    const day = { ...NO_FILTERS, from: '2026-09-20', to: '2026-09-20' }

    expect(entryMatchesFilters(at(0, 0, 0, 0), day)).toBe(true)
    expect(entryMatchesFilters(at(23, 59, 59, 999), day)).toBe(true)
    expect(
      entryMatchesFilters(
        makeEntry(1, { executedAt: new Date(2026, 8, 19, 23, 59, 59, 999).toISOString() }),
        day,
      ),
    ).toBe(false)
    expect(
      entryMatchesFilters(
        makeEntry(1, { executedAt: new Date(2026, 8, 21, 0, 0, 0, 0).toISOString() }),
        day,
      ),
    ).toBe(false)
  })
})
