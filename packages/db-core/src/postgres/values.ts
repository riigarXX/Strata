import type { CellValue, ColumnKind, ResultColumn } from '@strata/contracts'
import { limitHexDigits, limitText, MAX_CELL_BYTES, type Bounded } from '../result-limits'

const MAX_NAME_LENGTH = 256
const UNKNOWN_TYPE = 'unknown'

export interface DriverField {
  readonly name: string
  readonly dataTypeID: number
  readonly dataTypeModifier: number
}

interface TypeInfo {
  readonly name: string
  readonly kind: ColumnKind
}

const type = (name: string, kind: ColumnKind): TypeInfo => ({ name, kind })

// Built-in type OIDs are stable across versions, so the common ones are resolved without a round trip to pg_type.
const BUILTIN_TYPES: ReadonlyMap<number, TypeInfo> = new Map([
  [16, type('boolean', 'boolean')],
  [17, type('bytea', 'binary')],
  [18, type('"char"', 'text')],
  [19, type('name', 'text')],
  [20, type('bigint', 'number')],
  [21, type('smallint', 'number')],
  [23, type('integer', 'number')],
  [25, type('text', 'text')],
  [26, type('oid', 'number')],
  [114, type('json', 'json')],
  [142, type('xml', 'text')],
  [600, type('point', 'other')],
  [601, type('lseg', 'other')],
  [602, type('path', 'other')],
  [603, type('box', 'other')],
  [604, type('polygon', 'other')],
  [628, type('line', 'other')],
  [650, type('cidr', 'other')],
  [700, type('real', 'number')],
  [701, type('double precision', 'number')],
  [718, type('circle', 'other')],
  [774, type('macaddr8', 'other')],
  [790, type('money', 'other')],
  [829, type('macaddr', 'other')],
  [869, type('inet', 'other')],
  [1042, type('character', 'text')],
  [1043, type('character varying', 'text')],
  [1082, type('date', 'datetime')],
  [1083, type('time without time zone', 'datetime')],
  [1114, type('timestamp without time zone', 'datetime')],
  [1184, type('timestamp with time zone', 'datetime')],
  [1186, type('interval', 'datetime')],
  [1266, type('time with time zone', 'datetime')],
  [1560, type('bit', 'other')],
  [1562, type('bit varying', 'other')],
  [1700, type('numeric', 'number')],
  [2205, type('regclass', 'other')],
  [2278, type('void', 'other')],
  [2950, type('uuid', 'uuid')],
  [3220, type('pg_lsn', 'other')],
  [3614, type('tsvector', 'other')],
  [3615, type('tsquery', 'other')],
  [3802, type('jsonb', 'json')],
  [3904, type('int4range', 'other')],
  [3906, type('numrange', 'other')],
  [3908, type('tsrange', 'other')],
  [3910, type('tstzrange', 'other')],
  [3912, type('daterange', 'other')],
  [3926, type('int8range', 'other')],
  [4072, type('jsonpath', 'other')],
])

// Array type OID -> element type OID.
const BUILTIN_ARRAYS: ReadonlyMap<number, number> = new Map([
  [199, 114],
  [1000, 16],
  [1001, 17],
  [1005, 21],
  [1007, 23],
  [1009, 25],
  [1014, 1042],
  [1015, 1043],
  [1016, 20],
  [1021, 700],
  [1022, 701],
  [1028, 26],
  [1115, 1114],
  [1182, 1082],
  [1183, 1083],
  [1185, 1184],
  [1231, 1700],
  [2951, 2950],
  [3807, 3802],
])

const BYTEA = 17
const NUMERIC = 1700
const VARCHAR = 1043
const BPCHAR = 1042
const TIME_TYPES: ReadonlySet<number> = new Set([1083, 1114, 1184, 1266])
const FLOAT_TYPES: ReadonlySet<number> = new Set([700, 701])
const SMALL_INTEGER_TYPES: ReadonlySet<number> = new Set([21, 23, 26])

// Only what format_type would print between parentheses; -1 means the column has no modifier.
function withModifier(oid: number, name: string, typmod: number): string {
  if (typmod < 0) return name
  if ((oid === VARCHAR || oid === BPCHAR) && typmod >= 4) {
    return `${name}(${typmod - 4})`
  }
  if (oid === NUMERIC && typmod >= 4) {
    const packed = typmod - 4
    return `${name}(${(packed >> 16) & 0xffff},${packed & 0xffff})`
  }
  if (TIME_TYPES.has(oid)) {
    return name.replace(/^(timestamp|time)/, `$1(${typmod})`)
  }
  return name
}

export function isKnownType(oid: number): boolean {
  return BUILTIN_TYPES.has(oid) || BUILTIN_ARRAYS.has(oid)
}

function describeType(
  oid: number,
  typmod: number,
  resolved: ReadonlyMap<number, string>,
): { dataType: string; kind: ColumnKind } {
  const builtin = BUILTIN_TYPES.get(oid)
  if (builtin) {
    return { dataType: withModifier(oid, builtin.name, typmod), kind: builtin.kind }
  }
  const element = BUILTIN_ARRAYS.get(oid)
  const elementName = element === undefined ? undefined : BUILTIN_TYPES.get(element)?.name
  if (elementName !== undefined) {
    return { dataType: `${elementName}[]`, kind: 'array' }
  }
  // Enums, extension and user-defined types have no fixed OID: their names come from pg_type (see resolveTypeNames).
  const name = resolved.get(oid)
  if (name === undefined) return { dataType: UNKNOWN_TYPE, kind: 'other' }
  // format_type prints every array type, whatever its element, with a trailing [].
  return { dataType: name, kind: name.endsWith('[]') ? 'array' : 'other' }
}

export function describeColumns(
  fields: readonly DriverField[],
  resolved: ReadonlyMap<number, string> = new Map(),
): ResultColumn[] {
  return fields.map((field) => {
    const { dataType, kind } = describeType(field.dataTypeID, field.dataTypeModifier, resolved)
    return {
      name: field.name.slice(0, MAX_NAME_LENGTH),
      dataType: dataType.slice(0, MAX_NAME_LENGTH),
      kind,
    }
  })
}

// Non-builtin OIDs of a result set that still need a name.
export function unresolvedTypeOids(
  fields: readonly DriverField[],
  resolved: ReadonlyMap<number, string>,
): number[] {
  const missing = new Set<number>()
  for (const { dataTypeID } of fields) {
    if (!isKnownType(dataTypeID) && !resolved.has(dataTypeID)) {
      missing.add(dataTypeID)
    }
  }
  return [...missing]
}

// 2024-01-15 10:30:00.123456+00 -> 2024-01-15T10:30:00.123456+00:00. Anything else (BC dates, infinity, other DateStyle) is kept as the server wrote it.
const TIMESTAMP_TEXT =
  /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:([+-]\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?$/

function toIsoTimestamp(text: string): string {
  const match = TIMESTAMP_TEXT.exec(text)
  if (!match) return text
  const [, date, time, hours, minutes, seconds] = match
  if (hours === undefined) return `${date}T${time}`
  return `${date}T${time}${hours}:${minutes ?? '00'}${seconds === undefined ? '' : `:${seconds}`}`
}

// Rows are read as text so every value can be converted here, in one place:
//  - boolean, small integers and floats become JS primitives;
//  - bigint and numeric stay strings (a double cannot hold them exactly);
//  - timestamps become ISO 8601 strings, bytea becomes 0x<hex> (as in the SQLite adapter), json stays as its text;
//  - everything else (uuid, arrays, ranges, interval, enums...) is the server's own text representation.
export function toCellValue(value: string | null, oid: number): CellValue {
  if (value === null) return null
  if (oid === 16) return value === 't'
  if (SMALL_INTEGER_TYPES.has(oid)) return Number(value)
  if (FLOAT_TYPES.has(oid)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  if (oid === BYTEA) return value.startsWith('\\x') ? `0x${value.slice(2)}` : value
  if (oid === 1114 || oid === 1184) return toIsoTimestamp(value)
  return value
}

// The server text is capped before it is converted, so a huge value is never copied whole into its 0x<hex> form.
// bytea is cut on its hex digits (two per byte); everything else, json and arrays included, is cut as UTF-8 text.
export function toBoundedCell(
  value: string | null,
  oid: number,
  maxBytes: number = MAX_CELL_BYTES,
): Bounded<CellValue> {
  if (value === null) return { value: null }
  if (oid === BYTEA && value.startsWith('\\x')) {
    const { value: digits, originalBytes } = limitHexDigits(value.slice(2), maxBytes)
    return { value: `0x${digits}`, originalBytes }
  }
  const { value: text, originalBytes } = limitText(value, maxBytes)
  return { value: toCellValue(text, oid), originalBytes }
}
