import { describe, expect, it } from 'vitest'
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  HISTORY_LIMITS,
  HistoryChangeSchema,
  HistoryEntrySchema,
  HistoryListRequestSchema,
  HistoryPageSchema,
} from './history'

const entry = {
  id: 'h1',
  sql: 'select 1',
  engine: 'sqlite',
  profileId: 'p1',
  profileName: 'Local',
  executedAt: '2026-09-20T10:00:00.000Z',
  durationMs: 12,
  status: 'ok',
}

describe('HistoryEntrySchema', () => {
  it('accepts a minimal entry and one with row count and error code', () => {
    expect(HistoryEntrySchema.safeParse(entry).success).toBe(true)
    expect(
      HistoryEntrySchema.safeParse({
        ...entry,
        status: 'error',
        rowCount: 0,
        errorCode: 'syntax_error',
      }).success,
    ).toBe(true)
  })

  it.each([
    ['results', { rows: [[1]] }],
    ['a password', { password: 'x' }],
    ['an error message', { errorMessage: 'boom' }],
    ['an unknown status', { status: 'running' }],
    ['an unknown error code', { errorCode: 'driver_specific' }],
    ['a non-ISO date', { executedAt: 'yesterday' }],
    ['a negative duration', { durationMs: -1 }],
    ['a fractional row count', { rowCount: 1.5 }],
    ['sql beyond the cap plus the marker', { sql: 'x'.repeat(HISTORY_LIMITS.maxSqlChars + 300) }],
  ])('rejects %s', (_name, patch) => {
    expect(HistoryEntrySchema.safeParse({ ...entry, ...patch }).success).toBe(false)
  })
})

describe('HistoryListRequestSchema', () => {
  it('accepts an empty request and every filter', () => {
    expect(HistoryListRequestSchema.safeParse({}).success).toBe(true)
    expect(
      HistoryListRequestSchema.safeParse({
        search: 'select',
        engine: 'postgres',
        status: 'cancelled',
        profileId: 'p1',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-12-31T23:59:59.999Z',
        cursor: encodeHistoryCursor({ time: 1_800_000_000_000, id: 'h1' }),
        limit: HISTORY_LIMITS.pageSize.max,
      }).success,
    ).toBe(true)
  })

  it.each([
    ['limit above 200', { limit: 201 }],
    ['limit zero', { limit: 0 }],
    ['fractional limit', { limit: 1.5 }],
    ['malformed cursor', { cursor: 'not-a-cursor' }],
    ['unknown engine', { engine: 'mysql' }],
    ['unknown status', { status: 'done' }],
    ['non-ISO from', { from: '2026-01-01' }],
    ['huge search', { search: 'x'.repeat(HISTORY_LIMITS.searchMaxChars + 1) }],
    ['unknown key', { orderBy: 'asc' }],
  ])('rejects %s', (_name, patch) => {
    expect(HistoryListRequestSchema.safeParse(patch).success).toBe(false)
  })
})

describe('history cursor', () => {
  it('round-trips a position, including ids with dots', () => {
    const position = { time: 1_790_000_000_123, id: 'a.b-c' }
    expect(decodeHistoryCursor(encodeHistoryCursor(position))).toEqual(position)
  })

  it('rejects text that is not a cursor', () => {
    for (const bad of ['', 'abc', '.id', '12.', '-5.id', '1x.id']) {
      expect(decodeHistoryCursor(bad)).toBeUndefined()
    }
  })
})

describe('HistoryPageSchema', () => {
  it('accepts a page with and without a next cursor', () => {
    expect(HistoryPageSchema.safeParse({ entries: [entry], nextCursor: null }).success).toBe(true)
    expect(
      HistoryPageSchema.safeParse({
        entries: [],
        nextCursor: encodeHistoryCursor({ time: 1, id: 'x' }),
      }).success,
    ).toBe(true)
  })

  it('rejects a page with more entries than the maximum page size', () => {
    const entries = Array.from({ length: HISTORY_LIMITS.pageSize.max + 1 }, () => entry)
    expect(HistoryPageSchema.safeParse({ entries, nextCursor: null }).success).toBe(false)
  })
})

describe('HistoryChangeSchema', () => {
  it.each([
    [{ type: 'added', entry, requestId: 'r1' }],
    [{ type: 'added', entry }],
    [{ type: 'removed', id: 'h1' }],
    [{ type: 'cleared' }],
    [{ type: 'purged' }],
  ])('accepts %j', (change) => {
    expect(HistoryChangeSchema.safeParse(change).success).toBe(true)
  })

  it.each([
    ['an unknown type', { type: 'reset' }],
    ['no type', {}],
    ['an added change without entry', { type: 'added', requestId: 'r1' }],
    ['an added change with an invalid entry', { type: 'added', entry: { ...entry, status: 'x' } }],
    ['an added change with extra fields', { type: 'added', entry, sql: 'select 2' }],
    ['a removed change without id', { type: 'removed' }],
    ['a removed change with an empty id', { type: 'removed', id: '' }],
    ['a cleared change with a payload', { type: 'cleared', ids: ['h1'] }],
    ['a non-object', 'purged'],
  ])('rejects %s', (_name, change) => {
    expect(HistoryChangeSchema.safeParse(change).success).toBe(false)
  })
})
