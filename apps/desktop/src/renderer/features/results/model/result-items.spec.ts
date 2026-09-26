import { describe, expect, it } from 'vitest'
import type { ResultSetView } from '../../execution/model/result-buffers'
import type { StatementSummary } from '../../execution/stores/execution'
import { buildResultItems, defaultItem } from './result-items'

const set = (statementIndex: number): ResultSetView => ({
  statementIndex,
  columns: [],
  rows: [],
  rowsReceived: 0,
  truncated: [],
  truncatedIndex: new Map(),
})

const summary = (statementIndex: number, rowsAffected: number | null = null): StatementSummary => ({
  statementIndex,
  command: 'SELECT',
  rowsReturned: 0,
  rowsAffected,
  durationMs: 3,
  truncated: false,
})

describe('buildResultItems', () => {
  it('merges sets and summaries by statement in order', () => {
    const items = buildResultItems([set(2), set(0)], [summary(0), summary(1, 4), summary(2)])
    expect(
      items.map((item) => [item.statementIndex, item.set !== null, item.summary !== null]),
    ).toEqual([
      [0, true, true],
      [1, false, true],
      [2, true, true],
    ])
  })

  it('keeps a set that is still running without a summary', () => {
    const [item] = buildResultItems([set(0)], [])
    expect(item!.summary).toBeNull()
    expect(item!.set).not.toBeNull()
  })

  it('lists summaries whose rows were evicted', () => {
    const items = buildResultItems([set(3)], [summary(0), summary(3)])
    expect(items.map((item) => item.statementIndex)).toEqual([0, 3])
    expect(items[0]!.set).toBeNull()
  })
})

describe('defaultItem', () => {
  it('prefers the last statement that returned a result set', () => {
    const items = buildResultItems([set(1)], [summary(0, 2), summary(1), summary(2, 5)])
    expect(defaultItem(items)?.statementIndex).toBe(1)
  })

  it('falls back to the last statement, or nothing', () => {
    expect(defaultItem(buildResultItems([], [summary(0, 1), summary(1, 2)]))?.statementIndex).toBe(
      1,
    )
    expect(defaultItem([])).toBeNull()
  })
})
