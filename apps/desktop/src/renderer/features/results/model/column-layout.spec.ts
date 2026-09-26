import type { ResultColumn } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import {
  clampWidth,
  initialColumnWidth,
  isRightAligned,
  layoutColumns,
  MAX_COLUMN_WIDTH,
  MAX_INITIAL_WIDTH,
  MIN_COLUMN_WIDTH,
  rowNumberWidth,
  SAMPLE_ROWS,
} from './column-layout'

const col = (
  name: string,
  kind: ResultColumn['kind'] = 'text',
  dataType = 'text',
): ResultColumn => ({ name, dataType, kind })

describe('column layout', () => {
  it('aligns only numbers to the right', () => {
    expect(isRightAligned('number')).toBe(true)
    expect(isRightAligned('text')).toBe(false)
    expect(isRightAligned('datetime')).toBe(false)
  })

  it('sizes a column from its header when there are no rows', () => {
    const short = initialColumnWidth(col('id'), 0, [])
    expect(short).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH)
    expect(initialColumnWidth(col('a_rather_long_column_name'), 0, [])).toBeGreaterThan(short)
    // Nombre y tipo se muestran juntos: 'id' + 'integer' necesita más que 'id' + 'text'.
    expect(initialColumnWidth(col('id', 'number', 'integer'), 0, [])).toBeGreaterThan(short)
  })

  it('grows with the content of the sample and never past the initial maximum', () => {
    const narrow = initialColumnWidth(col('c'), 0, [['ab']])
    const wide = initialColumnWidth(col('c'), 0, [['a'.repeat(30)]])
    expect(wide).toBeGreaterThan(narrow)
    expect(initialColumnWidth(col('c'), 0, [['a'.repeat(5_000)]])).toBe(MAX_INITIAL_WIDTH)
  })

  it('only samples the first rows, so a huge result costs a bounded amount', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => [
      index < SAMPLE_ROWS ? 'a' : 'a'.repeat(200),
    ])
    expect(initialColumnWidth(col('c'), 0, rows)).toBeLessThan(MAX_INITIAL_WIDTH)
  })

  it('counts NULL as four characters', () => {
    expect(initialColumnWidth(col('c'), 0, [[null]])).toBe(initialColumnWidth(col('c'), 0, []))
  })

  it('clamps manual widths', () => {
    expect(clampWidth(3)).toBe(MIN_COLUMN_WIDTH)
    expect(clampWidth(99_999)).toBe(MAX_COLUMN_WIDTH)
    expect(clampWidth(100.4)).toBe(100)
  })

  it('makes the row-number column wide enough for the digits', () => {
    expect(rowNumberWidth(0)).toBe(48)
    expect(rowNumberWidth(100_000)).toBeGreaterThan(rowNumberWidth(100))
  })

  it('computes cumulative offsets', () => {
    expect(layoutColumns([100, 50, 200])).toEqual({ starts: [0, 100, 150], total: 350 })
    expect(layoutColumns([])).toEqual({ starts: [], total: 0 })
  })
})
