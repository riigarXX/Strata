import { describe, expect, it } from 'vitest'
import { columnWindow, rowWindow, scrollToReveal } from './virtual-window'

const base = { viewportHeight: 280, rowHeight: 28, rowCount: 100_000, overscan: 10 }

describe('rowWindow', () => {
  it('starts at the top with overscan only below', () => {
    expect(rowWindow({ ...base, scrollTop: 0 })).toEqual({ start: 0, end: 20 })
  })

  it('adds overscan on both sides in the middle', () => {
    // 2800 px = fila 100; visibles 100..110.
    expect(rowWindow({ ...base, scrollTop: 2800 })).toEqual({ start: 90, end: 120 })
  })

  it('includes a partially visible row at each edge', () => {
    expect(rowWindow({ ...base, scrollTop: 14, overscan: 0 })).toEqual({ start: 0, end: 11 })
  })

  it('clamps at the end of the data', () => {
    const scrollTop = 100_000 * 28 - 280
    expect(rowWindow({ ...base, scrollTop })).toEqual({ start: 99_980, end: 100_000 })
    expect(rowWindow({ ...base, scrollTop: 10 ** 9 })).toEqual({ start: 100_000, end: 100_000 })
  })

  it('returns an empty window without rows and tolerates degenerate input', () => {
    expect(rowWindow({ ...base, scrollTop: 0, rowCount: 0 })).toEqual({ start: 0, end: 0 })
    expect(rowWindow({ ...base, scrollTop: -50, rowCount: 5 })).toEqual({ start: 0, end: 5 })
    expect(rowWindow({ ...base, scrollTop: 0, rowHeight: 0 })).toEqual({ start: 0, end: 0 })
    expect(rowWindow({ ...base, scrollTop: 0, viewportHeight: -1, overscan: 0 })).toEqual({
      start: 0,
      end: 0,
    })
  })

  it('never exceeds a few dozen rows however large the data set is', () => {
    for (const scrollTop of [0, 1234, 2_000_000, 2_799_720]) {
      const { start, end } = rowWindow({ ...base, scrollTop })
      expect(end - start).toBeLessThanOrEqual(40)
    }
  })

  it('computes 100 000 windows well within a frame budget', () => {
    const started = performance.now()
    for (let index = 0; index < 100_000; index += 1) {
      rowWindow({ ...base, scrollTop: index * 28 })
    }
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('columnWindow', () => {
  const widths = Array.from({ length: 50 }, () => 100)
  const starts = widths.map((_, index) => index * 100)
  const total = 5000

  it('covers the visible columns plus the overscan', () => {
    expect(columnWindow(starts, total, 0, 300, 0)).toEqual({ start: 0, end: 3 })
    expect(columnWindow(starts, total, 1000, 300, 100)).toEqual({ start: 9, end: 14 })
  })

  it('clamps to the last column and returns something for tiny viewports', () => {
    expect(columnWindow(starts, total, 4900, 300, 0)).toEqual({ start: 49, end: 50 })
    expect(columnWindow(starts, total, 0, 0, 0).end).toBeGreaterThan(0)
  })

  it('is empty without columns', () => {
    expect(columnWindow([], 0, 0, 300, 100)).toEqual({ start: 0, end: 0 })
  })

  it('handles a negative offset (the row-number column still covers the first columns)', () => {
    expect(columnWindow(starts, total, -60, 300, 0)).toEqual({ start: 0, end: 3 })
  })
})

describe('scrollToReveal', () => {
  const item = (itemStart: number) => ({
    current: 100,
    viewport: 200,
    itemStart,
    itemEnd: itemStart + 28,
    leadingInset: 0,
  })

  it('does not move when the item is already visible', () => {
    expect(scrollToReveal(item(150))).toBe(100)
  })

  it('scrolls up to an item above and down to one below', () => {
    expect(scrollToReveal(item(56))).toBe(56)
    expect(scrollToReveal(item(400))).toBe(228)
  })

  it('accounts for the space covered by fixed elements', () => {
    expect(scrollToReveal({ ...item(90), leadingInset: 30 })).toBe(60)
  })

  it('never returns a negative offset', () => {
    expect(scrollToReveal({ ...item(0), current: 50, leadingInset: 20 })).toBe(0)
  })
})
