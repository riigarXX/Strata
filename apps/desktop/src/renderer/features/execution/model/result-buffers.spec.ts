import { effectScope, nextTick, watch } from 'vue'
import { describe, expect, it } from 'vitest'
import { ResultBuffers, truncatedBytes } from './result-buffers'

const columns = [{ name: 'n', dataType: 'integer', kind: 'number' as const }]
const rowsOf = (from: number, count: number) =>
  Array.from({ length: count }, (_, offset) => [from + offset])

describe('ResultBuffers', () => {
  it('returns an empty snapshot for unknown tabs', () => {
    const snapshot = new ResultBuffers().snapshot('tab-1')
    expect(snapshot.sets).toEqual([])
    expect(snapshot.version).toBe(0)
  })

  it('accumulates chunks of a statement and counts what was received', () => {
    const buffers = new ResultBuffers()
    buffers.begin('tab-1', 100)
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(0, 3) })
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(3, 2) })

    const snapshot = buffers.snapshot('tab-1')
    expect(snapshot.sets).toHaveLength(1)
    expect(snapshot.sets[0]!.rows).toHaveLength(5)
    expect(snapshot.sets[0]!.rowsReceived).toBe(5)
    expect(snapshot.rowsReceived).toBe(5)
  })

  it('never stores more than maxRows and keeps counting the dropped rows', () => {
    const buffers = new ResultBuffers()
    buffers.begin('tab-1', 4)
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(0, 3) })
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(3, 3) })
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(6, 3) })

    const [set] = buffers.snapshot('tab-1').sets
    expect(set!.rows).toEqual([[0], [1], [2], [3]])
    expect(set!.rowsReceived).toBe(9)
    expect(buffers.snapshot('tab-1').rowsReceived).toBe(9)
  })

  it('evicts the oldest result sets so the latest one always fits', () => {
    const buffers = new ResultBuffers()
    buffers.begin('tab-1', 5)
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(0, 3) })
    buffers.append('tab-1', { statementIndex: 1, columns, rows: rowsOf(10, 2) })
    buffers.append('tab-1', { statementIndex: 2, columns, rows: rowsOf(20, 4) })

    const snapshot = buffers.snapshot('tab-1')
    expect(snapshot.sets.map((set) => set.statementIndex)).toEqual([2])
    expect(snapshot.sets[0]!.rows).toHaveLength(4)
    expect(snapshot.evictedSets).toBe(2)
  })

  it('keeps earlier sets while they still fit', () => {
    const buffers = new ResultBuffers()
    buffers.begin('tab-1', 10)
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(0, 3) })
    buffers.append('tab-1', { statementIndex: 1, columns, rows: rowsOf(10, 3) })
    expect(buffers.snapshot('tab-1').sets.map((set) => set.statementIndex)).toEqual([0, 1])
  })

  it('drops the previous run when a new one begins, and ignores chunks without a begun run', () => {
    const buffers = new ResultBuffers()
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(0, 1) })
    expect(buffers.snapshot('tab-1').sets).toEqual([])

    buffers.begin('tab-1', 10)
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(0, 2) })
    buffers.begin('tab-1', 10)
    expect(buffers.snapshot('tab-1').sets).toEqual([])
    expect(buffers.snapshot('tab-1').rowsReceived).toBe(0)
  })

  it('keeps the tabs isolated and forgets a discarded tab', () => {
    const buffers = new ResultBuffers()
    buffers.begin('tab-1', 10)
    buffers.begin('tab-2', 10)
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(0, 2) })
    expect(buffers.snapshot('tab-2').sets).toEqual([])
    buffers.discard('tab-1')
    expect(buffers.snapshot('tab-1').sets).toEqual([])
  })

  it('keeps the truncated marks with absolute row indexes across chunks', () => {
    const buffers = new ResultBuffers()
    buffers.begin('tab-1', 100)
    buffers.append('tab-1', {
      statementIndex: 0,
      columns,
      rows: rowsOf(0, 3),
      truncated: [{ row: 1, column: 0, originalBytes: 500_000 }],
    })
    buffers.append('tab-1', {
      statementIndex: 0,
      columns,
      rows: rowsOf(3, 4),
      truncated: [
        { row: 0, column: 0, originalBytes: 300_000 },
        { row: 3, column: 0, originalBytes: 262_145 },
      ],
    })

    const [set] = buffers.snapshot('tab-1').sets
    expect(set!.truncated).toEqual([
      { row: 1, column: 0, originalBytes: 500_000 },
      { row: 3, column: 0, originalBytes: 300_000 },
      { row: 6, column: 0, originalBytes: 262_145 },
    ])
    expect(truncatedBytes(set!, 3, 0)).toBe(300_000)
    expect(truncatedBytes(set!, 2, 0)).toBeNull()
  })

  it('keeps the marks of each result set apart and does not store marks for rows over the limit', () => {
    const buffers = new ResultBuffers()
    buffers.begin('tab-1', 4)
    buffers.append('tab-1', {
      statementIndex: 0,
      columns,
      rows: rowsOf(0, 6),
      truncated: [
        { row: 2, column: 0, originalBytes: 300_000 },
        { row: 5, column: 0, originalBytes: 400_000 },
      ],
    })
    const [set] = buffers.snapshot('tab-1').sets
    expect(set!.rows).toHaveLength(4)
    expect(set!.truncated).toEqual([{ row: 2, column: 0, originalBytes: 300_000 }])
  })

  it('gives every run its own generation and drops the marks with the run', () => {
    const buffers = new ResultBuffers()
    buffers.begin('tab-1', 10)
    const first = buffers.snapshot('tab-1').generation
    buffers.append('tab-1', {
      statementIndex: 0,
      columns,
      rows: rowsOf(0, 1),
      truncated: [{ row: 0, column: 0, originalBytes: 300_000 }],
    })
    buffers.begin('tab-1', 10)
    expect(buffers.snapshot('tab-1').generation).toBeGreaterThan(first)
    expect(buffers.snapshot('tab-1').sets).toEqual([])
  })

  it('makes the snapshot reactive through its version', async () => {
    const buffers = new ResultBuffers()
    const seen: number[] = []
    const scope = effectScope()
    scope.run(() =>
      watch(
        () => buffers.snapshot('tab-1').version,
        (version) => seen.push(version),
      ),
    )
    buffers.begin('tab-1', 10)
    await nextTick()
    buffers.append('tab-1', { statementIndex: 0, columns, rows: rowsOf(0, 1) })
    await nextTick()
    buffers.discard('tab-1')
    await nextTick()
    scope.stop()
    expect(seen).toHaveLength(3)
    expect(seen[0]).toBeLessThan(seen[1]!)
    expect(seen[2]).toBe(0)
  })
})
