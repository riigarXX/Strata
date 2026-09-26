import type { CellValue } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { normalizeQuery, RowFilter, rowMatches } from './row-filter'

const rows = (count: number): CellValue[][] =>
  Array.from({ length: count }, (_, index) => [
    index,
    `Name-${index}`,
    index % 7 === 0 ? null : 'x',
  ])

function scanAll(
  filter: RowFilter,
  data: readonly (readonly CellValue[])[],
  budgetMs = 1_000,
): void {
  while (!filter.isComplete(data.length)) filter.step(data, budgetMs)
}

describe('rowMatches', () => {
  it('matches a substring in any column without regard to case', () => {
    expect(rowMatches([1, 'Hello World'], 'lo wo')).toBe(true)
    expect(rowMatches([1, 'Hello'], 'HELLO'.toLowerCase())).toBe(true)
    expect(rowMatches([1, 'Hello'], 'bye')).toBe(false)
  })

  it('matches numbers and booleans through their text and never matches NULL', () => {
    expect(rowMatches([12345], '234')).toBe(true)
    expect(rowMatches([true], 'tru')).toBe(true)
    expect(rowMatches([null, 'a'], 'null')).toBe(false)
  })

  it('handles unicode and multiline values', () => {
    expect(rowMatches(['Ñandú ÁÉ'], 'ñandú')).toBe(true)
    expect(rowMatches(['line1\nline2'], 'line1\nline2')).toBe(true)
  })

  it('normalises the query', () => {
    expect(normalizeQuery('  AbC ')).toBe('abc')
    expect(normalizeQuery('   ')).toBe('')
  })
})

describe('RowFilter', () => {
  it('returns ascending row indexes', () => {
    const data = rows(100)
    const filter = new RowFilter('name-4')
    scanAll(filter, data)
    expect(filter.matches).toEqual([4, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49])
  })

  it('gives the same result whatever the batch size', () => {
    const data = rows(5_000)
    const whole = new RowFilter('9')
    scanAll(whole, data)
    const batched = new RowFilter('9')
    let clock = 0
    // Reloj que avanza 1 ms por consulta: fuerza tandas de 256 filas.
    const now = () => (clock += 1)
    while (!batched.isComplete(data.length)) batched.step(data, 1, now)
    expect(batched.matches).toEqual(whole.matches)
  })

  it('stops at the budget and resumes where it left off', () => {
    const data = rows(10_000)
    const filter = new RowFilter('name-')
    const first = filter.step(data, 0, () => 0)
    expect(first).toBeLessThan(data.length)
    expect(filter.scanned).toBe(first)
    expect(filter.isComplete(data.length)).toBe(false)
    scanAll(filter, data)
    expect(filter.matches).toHaveLength(10_000)
  })

  it('only reads the new rows when the data grows (append-only)', () => {
    const data = rows(1_000)
    const filter = new RowFilter('99')
    scanAll(filter, data)
    const before = [...filter.matches]
    data.push(...rows(2_000).slice(1_000))
    expect(filter.isComplete(data.length)).toBe(false)
    const reviewed = filter.step(data, 1_000)
    expect(reviewed).toBe(1_000)
    expect(filter.matches.slice(0, before.length)).toEqual(before)
    expect(filter.matches).toContain(1_990)
  })

  it('an empty result is complete and matches nothing', () => {
    const filter = new RowFilter('zzz')
    scanAll(filter, rows(50))
    expect(filter.matches).toEqual([])
  })

  it('filters 100 000 rows x 10 columns in bounded batches within a sane total time', () => {
    const data = Array.from({ length: 100_000 }, (_, index): CellValue[] =>
      Array.from({ length: 10 }, (_, col) => (col === 3 ? `value ${index} ${col}` : index + col)),
    )
    const filter = new RowFilter('VALUE 99999')
    let batches = 0
    const started = performance.now()
    while (!filter.isComplete(data.length)) {
      const before = performance.now()
      filter.step(data, 8)
      expect(performance.now() - before).toBeLessThan(100)
      batches += 1
    }
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(filter.matches).toEqual([99_999])
    expect(batches).toBeGreaterThan(0)
  })
})
