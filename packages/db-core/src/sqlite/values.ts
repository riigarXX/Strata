import type { CellValue, ColumnKind, ResultColumn } from '@strata/contracts'
import { limitBytes, limitText, MAX_CELL_BYTES, type Bounded } from '../result-limits'

const MAX_NAME_LENGTH = 256

export interface DriverColumn {
  readonly name: string
  readonly type: string | null
}

// Follows SQLite's own type-affinity rules, plus the common conventions (BOOLEAN, DATETIME, JSON) it stores as INTEGER/TEXT.
export function kindFromDeclaredType(declaredType: string): ColumnKind {
  const type = declaredType.toUpperCase()
  if (type.includes('BOOL')) return 'boolean'
  if (type.includes('UUID') || type.includes('GUID')) return 'uuid'
  if (type.includes('JSON')) return 'json'
  if (type.includes('DATE') || type.includes('TIME')) return 'datetime'
  if (type.includes('INT')) return 'number'
  if (/CHAR|CLOB|TEXT/.test(type)) return 'text'
  if (type.includes('BLOB')) return 'binary'
  if (/REAL|FLOA|DOUB|NUM|DEC/.test(type)) return 'number'
  return 'other'
}

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

// Expression columns have no declared type, so their storage class is read from the first non-null value.
function inferFromValue(value: unknown): { dataType: string; kind: ColumnKind } {
  if (typeof value === 'bigint') return { dataType: 'INTEGER', kind: 'number' }
  if (typeof value === 'number') return { dataType: 'REAL', kind: 'number' }
  if (typeof value === 'string') return { dataType: 'TEXT', kind: 'text' }
  if (isBinary(value)) return { dataType: 'BLOB', kind: 'binary' }
  return { dataType: 'ANY', kind: 'other' }
}

export function describeColumns(
  driverColumns: readonly DriverColumn[],
  firstRows: readonly (readonly unknown[])[],
): ResultColumn[] {
  return driverColumns.map((column, index) => {
    const name = column.name.slice(0, MAX_NAME_LENGTH)
    const declared = column.type?.trim()
    if (declared) {
      return {
        name,
        dataType: declared.slice(0, MAX_NAME_LENGTH),
        kind: kindFromDeclaredType(declared),
      }
    }
    const sample = firstRows.map((row) => row[index]).find((value) => value !== null)
    return { name, ...inferFromValue(sample) }
  })
}

// Applied to each raw value as soon as its row is read, so at most one oversized row is alive at a time and the pending chunk holds only capped values.
// Everything but text and blobs (numbers, bigints, null) is tiny by nature.
export function boundDriverValue(
  value: unknown,
  maxBytes: number = MAX_CELL_BYTES,
): Bounded<unknown> {
  if (typeof value === 'string') return limitText(value, maxBytes)
  if (isBinary(value)) return limitBytes(value, maxBytes)
  return { value }
}

// Rows are read with safeIntegers so 64-bit integers are exact; only those beyond 2^53 travel as strings.
export function toCellValue(value: unknown, kind: ColumnKind): CellValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') {
    if (kind === 'boolean' && (value === 0n || value === 1n)) return value === 1n
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return value
  if (isBinary(value)) return `0x${Buffer.from(value).toString('hex')}`
  return String(value)
}
