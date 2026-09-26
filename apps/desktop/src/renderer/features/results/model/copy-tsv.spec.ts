import type { CellValue, ResultColumn } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildTsv,
  copyText,
  COPY_LIMITS,
  describeCopy,
  escapeTsvField,
  type CopySource,
} from './copy-tsv'

const columns: ResultColumn[] = [
  { name: 'id', dataType: 'integer', kind: 'number' },
  { name: 'note', dataType: 'text', kind: 'text' },
  { name: 'flag', dataType: 'boolean', kind: 'boolean' },
]

function sourceOf(
  rows: CellValue[][],
  truncated: [row: number, column: number, bytes: number][] = [],
  sourceRow: (index: number) => number = (index) => index,
): CopySource {
  return {
    columns,
    rows,
    truncatedIndex: new Map(
      truncated.map(([row, column, bytes]) => [row * columns.length + column, bytes]),
    ),
    sourceRow,
  }
}

const all = (rows: number) => ({ rowStart: 0, rowEnd: rows - 1, colStart: 0, colEnd: 2 })
const immediate = { yieldToMain: () => Promise.resolve() }

describe('escapeTsvField', () => {
  it('leaves plain text alone', () => {
    expect(escapeTsvField('hello world')).toBe('hello world')
    expect(escapeTsvField('')).toBe('')
  })

  it.each([
    ['a\tb', '"a\tb"'],
    ['a\nb', '"a\nb"'],
    ['a\r\nb', '"a\r\nb"'],
    ['say "hi"', '"say ""hi"""'],
    ['"', '""""'],
  ])('quotes %j', (input, expected) => {
    expect(escapeTsvField(input)).toBe(expected)
  })

  it('keeps unicode and emoji intact', () => {
    expect(escapeTsvField('ñandú 日本語 🚀')).toBe('ñandú 日本語 🚀')
  })
})

describe('copyText', () => {
  it('copies NULL as an empty field and the rest as text', () => {
    expect(copyText(null)).toBe('')
    expect(copyText(0)).toBe('0')
    expect(copyText(false)).toBe('false')
    expect(copyText('')).toBe('')
  })
})

describe('buildTsv', () => {
  it('builds rows separated by newlines and columns by tabs', async () => {
    const result = await buildTsv(
      sourceOf([
        [1, 'a', true],
        [2, 'b', false],
      ]),
      all(2),
      {
        headers: false,
        ...immediate,
      },
    )
    expect(result.text).toBe('1\ta\ttrue\n2\tb\tfalse')
    expect(result).toMatchObject({ rows: 2, cols: 3, truncatedCells: 0, capped: false })
  })

  it('adds the header row only when asked, with escaped names', async () => {
    const quoted: CopySource = {
      ...sourceOf([[1, 'a', true]]),
      columns: [{ ...columns[0]!, name: 'a\tb' }, columns[1]!, columns[2]!],
    }
    const withHeaders = await buildTsv(quoted, all(1), { headers: true, ...immediate })
    expect(withHeaders.text).toBe('"a\tb"\tnote\tflag\n1\ta\ttrue')
    const without = await buildTsv(quoted, all(1), { headers: false, ...immediate })
    expect(without.text).toBe('1\ta\ttrue')
  })

  it('escapes hard cases so each value stays in a single cell', async () => {
    const rows: CellValue[][] = [
      [1, 'tab\there', null],
      [2, 'line1\nline2', true],
      [3, 'she said "no"', false],
      [4, 'ñandú 🚀', null],
    ]
    const { text } = await buildTsv(sourceOf(rows), all(4), { headers: false, ...immediate })
    expect(text).toBe(
      [
        '1\t"tab\there"\t',
        '2\t"line1\nline2"\ttrue',
        '3\t"she said ""no"""\tfalse',
        '4\tñandú 🚀\t',
      ].join('\n'),
    )
  })

  it('copies a rectangular sub-range', async () => {
    const rows = Array.from({ length: 10 }, (_, index): CellValue[] => [
      index,
      `n${index}`,
      index % 2 === 0,
    ])
    const { text } = await buildTsv(
      sourceOf(rows),
      { rowStart: 2, rowEnd: 3, colStart: 1, colEnd: 2 },
      { headers: false, ...immediate },
    )
    expect(text).toBe('n2\ttrue\nn3\tfalse')
  })

  it('follows the filtered mapping of visible rows to source rows', async () => {
    const rows = Array.from({ length: 10 }, (_, index): CellValue[] => [index, `n${index}`, true])
    const matches = [7, 3]
    const { text } = await buildTsv(
      sourceOf(rows, [], (index) => matches[index]!),
      all(2),
      { headers: false, ...immediate },
    )
    expect(text).toBe('7\tn7\ttrue\n3\tn3\ttrue')
  })

  it('reports truncated cells that were copied cut', async () => {
    const rows: CellValue[][] = [
      [1, 'x'.repeat(5), true],
      [2, 'y', false],
    ]
    const result = await buildTsv(sourceOf(rows, [[0, 1, 500_000]]), all(2), {
      headers: false,
      ...immediate,
    })
    expect(result.truncatedCells).toBe(1)
    expect(describeCopy(result, 2, false)).toContain('1 celda truncada se copió cortada')
  })

  it('stops at the cell cap and says so', async () => {
    const rows = Array.from({ length: 100 }, (_, index): CellValue[] => [index, 'a', true])
    const result = await buildTsv(sourceOf(rows), all(100), {
      headers: false,
      limits: { maxCells: 30, maxChars: 1_000_000 },
      ...immediate,
    })
    expect(result.rows).toBe(10)
    expect(result.capped).toBe(true)
    expect(describeCopy(result, 100, false)).toContain('Copia limitada')
  })

  it('stops at the character cap even with few cells', async () => {
    const rows = Array.from({ length: 50 }, (): CellValue[] => [1, 'z'.repeat(1_000), true])
    const result = await buildTsv(sourceOf(rows), all(50), {
      headers: false,
      limits: { maxCells: 1_000_000, maxChars: 5_000 },
      ...immediate,
    })
    expect(result.capped).toBe(true)
    expect(result.rows).toBeLessThan(50)
    expect(result.text.length).toBeLessThan(10_000)
  })

  it('yields to the event loop on long copies instead of blocking', async () => {
    const rows = Array.from({ length: 20_000 }, (_, index): CellValue[] => [
      index,
      `value ${index}`,
      true,
    ])
    let yields = 0
    let clock = 0
    const result = await buildTsv(sourceOf(rows), all(20_000), {
      headers: false,
      budgetMs: 8,
      now: () => (clock += 1),
      yieldToMain: () => {
        yields += 1
        return Promise.resolve()
      },
    })
    expect(yields).toBeGreaterThan(100)
    expect(result.rows).toBe(20_000)
  })

  it('copies 100 000 rows x 10 columns within a time budget', async () => {
    const wide: ResultColumn[] = Array.from({ length: 10 }, (_, index) => ({
      name: `c${index}`,
      dataType: 'text',
      kind: 'text' as const,
    }))
    const rows = Array.from({ length: 100_000 }, (_, index): CellValue[] =>
      Array.from({ length: 10 }, (_, col) => (col % 3 === 0 ? index : `text ${index}-${col}`)),
    )
    const source: CopySource = {
      columns: wide,
      rows,
      truncatedIndex: new Map(),
      sourceRow: (index) => index,
    }
    const started = performance.now()
    const result = await buildTsv(
      source,
      { rowStart: 0, rowEnd: 99_999, colStart: 0, colEnd: 9 },
      { headers: true, ...immediate },
    )
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(result.rows).toBe(100_000)
    expect(result.capped).toBe(false)
    expect(result.text.split('\n')).toHaveLength(100_001)
    expect(COPY_LIMITS.maxCells).toBeGreaterThanOrEqual(1_000_000)
  })
})
