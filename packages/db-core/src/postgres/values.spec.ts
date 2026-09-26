import { describe, expect, it } from 'vitest'
import { MAX_CELL_BYTES } from '../result-limits'
import {
  describeColumns,
  toBoundedCell,
  toCellValue,
  unresolvedTypeOids,
  type DriverField,
} from './values'

const field = (name: string, dataTypeID: number, dataTypeModifier = -1): DriverField => ({
  name,
  dataTypeID,
  dataTypeModifier,
})

describe('describeColumns', () => {
  it('names built-in types the way PostgreSQL prints them and assigns a kind', () => {
    const columns = describeColumns([
      field('a', 23),
      field('b', 20),
      field('c', 1700),
      field('d', 25),
      field('e', 1184),
      field('f', 3802),
      field('g', 17),
      field('h', 16),
      field('i', 2950),
      field('j', 1007),
    ])
    expect(columns.map(({ dataType, kind }) => [dataType, kind])).toEqual([
      ['integer', 'number'],
      ['bigint', 'number'],
      ['numeric', 'number'],
      ['text', 'text'],
      ['timestamp with time zone', 'datetime'],
      ['jsonb', 'json'],
      ['bytea', 'binary'],
      ['boolean', 'boolean'],
      ['uuid', 'uuid'],
      ['integer[]', 'array'],
    ])
  })

  it('applies length, precision and scale modifiers', () => {
    const columns = describeColumns([
      field('a', 1043, 24),
      field('b', 1042, 9),
      field('c', 1700, ((10 << 16) | 2) + 4),
      field('d', 1114, 3),
      field('e', 1184, 6),
      field('f', 1083, 0),
      field('g', 1043, -1),
    ])
    expect(columns.map((column) => column.dataType)).toEqual([
      'character varying(20)',
      'character(5)',
      'numeric(10,2)',
      'timestamp(3) without time zone',
      'timestamp(6) with time zone',
      'time(0) without time zone',
      'character varying',
    ])
  })

  it('uses resolved names for user-defined types and "unknown" otherwise', () => {
    const resolved = new Map([[16500, 'public.mood']])
    const columns = describeColumns([field('a', 16500), field('b', 16501)], resolved)
    expect(columns).toEqual([
      { name: 'a', dataType: 'public.mood', kind: 'other' },
      { name: 'b', dataType: 'unknown', kind: 'other' },
    ])
  })

  it('classifies resolved array types, such as an array of a user-defined type, as arrays', () => {
    const resolved = new Map([
      [16501, 'public.mood[]'],
      [1041, 'inet[]'],
    ])
    const columns = describeColumns([field('a', 16501), field('b', 1041)], resolved)
    expect(columns.map(({ dataType, kind }) => [dataType, kind])).toEqual([
      ['public.mood[]', 'array'],
      ['inet[]', 'array'],
    ])
  })

  it('truncates names to the contract limit', () => {
    const [column] = describeColumns([field('x'.repeat(400), 23)])
    expect(column?.name).toHaveLength(256)
  })
})

describe('unresolvedTypeOids', () => {
  it('lists each non-built-in OID once, skipping the ones already resolved', () => {
    const fields = [field('a', 23), field('b', 16500), field('c', 16500), field('d', 16501)]
    expect(unresolvedTypeOids(fields, new Map([[16501, 'x']]))).toEqual([16500])
  })
})

describe('toCellValue', () => {
  it('maps null to null whatever the type', () => {
    for (const oid of [16, 20, 23, 25, 1184, 17]) {
      expect(toCellValue(null, oid)).toBeNull()
    }
  })

  it('reads booleans', () => {
    expect(toCellValue('t', 16)).toBe(true)
    expect(toCellValue('f', 16)).toBe(false)
  })

  it('converts small integers and floats to numbers', () => {
    expect(toCellValue('-7', 21)).toBe(-7)
    expect(toCellValue('2147483647', 23)).toBe(2147483647)
    expect(toCellValue('4294967295', 26)).toBe(4294967295)
    expect(toCellValue('1.5', 701)).toBe(1.5)
    expect(toCellValue('0.1', 700)).toBe(0.1)
    expect(toCellValue('1e+20', 701)).toBe(1e20)
  })

  it('keeps non-finite floats as strings', () => {
    expect(toCellValue('NaN', 701)).toBe('NaN')
    expect(toCellValue('Infinity', 701)).toBe('Infinity')
    expect(toCellValue('-Infinity', 700)).toBe('-Infinity')
  })

  it('keeps bigint and numeric exact by leaving them as strings', () => {
    expect(toCellValue('9223372036854775807', 20)).toBe('9223372036854775807')
    expect(toCellValue('-9007199254740993', 20)).toBe('-9007199254740993')
    expect(toCellValue('12345678901234567890.123456789', 1700)).toBe(
      '12345678901234567890.123456789',
    )
    expect(toCellValue('NaN', 1700)).toBe('NaN')
  })

  it('writes timestamps as ISO 8601', () => {
    expect(toCellValue('2024-01-15 10:30:00', 1114)).toBe('2024-01-15T10:30:00')
    expect(toCellValue('2024-01-15 10:30:00.123456', 1114)).toBe('2024-01-15T10:30:00.123456')
    expect(toCellValue('2024-01-15 10:30:00+00', 1184)).toBe('2024-01-15T10:30:00+00:00')
    expect(toCellValue('2024-01-15 10:30:00.5-03:30', 1184)).toBe('2024-01-15T10:30:00.5-03:30')
    expect(toCellValue('2024-01-15 10:30:00+05:30:15', 1184)).toBe('2024-01-15T10:30:00+05:30:15')
  })

  it('leaves timestamps it cannot read exactly as the server wrote them', () => {
    expect(toCellValue('infinity', 1184)).toBe('infinity')
    expect(toCellValue('-infinity', 1114)).toBe('-infinity')
    expect(toCellValue('0044-03-15 12:00:00+00 BC', 1184)).toBe('0044-03-15 12:00:00+00 BC')
    expect(toCellValue('15/01/2024 10:30:00', 1114)).toBe('15/01/2024 10:30:00')
  })

  it('leaves dates, times and intervals as text', () => {
    expect(toCellValue('2024-01-15', 1082)).toBe('2024-01-15')
    expect(toCellValue('10:30:00', 1083)).toBe('10:30:00')
    expect(toCellValue('1 day 02:03:04', 1186)).toBe('1 day 02:03:04')
  })

  it('writes bytea as 0x-prefixed hex, like the SQLite adapter', () => {
    expect(toCellValue('\\xdeadbeef', 17)).toBe('0xdeadbeef')
    expect(toCellValue('\\x', 17)).toBe('0x')
  })

  it('keeps json, uuid, arrays and unknown types as the server text', () => {
    expect(toCellValue('{"a": [1, 2]}', 3802)).toBe('{"a": [1, 2]}')
    expect(toCellValue('{1,2,3}', 1007)).toBe('{1,2,3}')
    expect(toCellValue('happy', 16500)).toBe('happy')
  })

  it('only returns values the contracts accept and structured clone carries', () => {
    const samples: [string, number][] = [
      ['t', 16],
      ['9223372036854775807', 20],
      ['1.5', 701],
      ['2024-01-15 10:30:00+00', 1184],
      ['\\xff', 17],
    ]
    for (const [text, oid] of samples) {
      const value = toCellValue(text, oid)
      expect(['boolean', 'number', 'string']).toContain(typeof value)
      expect(structuredClone(value)).toBe(value)
    }
  })
})

describe('toBoundedCell', () => {
  it('converts like toCellValue and reports nothing cut for ordinary values', () => {
    const samples: [string | null, number][] = [
      [null, 25],
      ['t', 16],
      ['42', 23],
      ['9223372036854775807', 20],
      ['2024-01-15 10:30:00+00', 1184],
      ['\\xdeadbeef', 17],
      ['\\x', 17],
      ['{"a": 1}', 3802],
      ['', 25],
    ]
    for (const [text, oid] of samples) {
      const bounded = toBoundedCell(text, oid)
      expect(bounded.value).toEqual(toCellValue(text, oid))
      expect(bounded.originalBytes).toBeUndefined()
    }
  })

  it('cuts text, json and arrays at the byte limit and reports their original size', () => {
    for (const oid of [25, 1043, 114, 3802, 1009]) {
      const bounded = toBoundedCell('x'.repeat(1001), oid, 1000)
      expect(bounded).toEqual({ value: 'x'.repeat(1000), originalBytes: 1001 })
      expect(toBoundedCell('x'.repeat(1000), oid, 1000).originalBytes).toBeUndefined()
    }
  })

  it('cuts multibyte text on a character boundary', () => {
    const bounded = toBoundedCell('日'.repeat(1000), 25, 100)
    expect(bounded.value).toBe('日'.repeat(33))
    expect(bounded.originalBytes).toBe(3000)
  })

  it('cuts bytea on whole bytes of its 0x<hex> form', () => {
    const hex = 'ab'.repeat(600)
    const bounded = toBoundedCell(`\\x${hex}`, 17, 1000)
    expect(bounded).toEqual({ value: `0x${'ab'.repeat(499)}`, originalBytes: 600 })
    expect(toBoundedCell(`\\x${'ab'.repeat(499)}`, 17, 1000)).toEqual({
      value: `0x${'ab'.repeat(499)}`,
      originalBytes: undefined,
    })
  })

  it('treats bytea in the escape format as text', () => {
    expect(toBoundedCell('a\\\\000b'.repeat(10), 17, 20)).toMatchObject({ originalBytes: 70 })
  })

  it('caps a huge value with the default limit, without changing the head', () => {
    const huge = 'abc'.repeat(3_000_000)
    const bounded = toBoundedCell(huge, 25)
    expect(bounded.originalBytes).toBe(9_000_000)
    expect(bounded.value).toBe(huge.slice(0, MAX_CELL_BYTES))

    const hugeBytea = toBoundedCell(`\\x${'0f'.repeat(4_000_000)}`, 17)
    expect(hugeBytea.originalBytes).toBe(4_000_000)
    expect(Buffer.byteLength(hugeBytea.value as string)).toBe(MAX_CELL_BYTES)
  })
})
