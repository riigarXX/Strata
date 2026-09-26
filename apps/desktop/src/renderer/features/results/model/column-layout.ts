import type { CellValue, ColumnKind, ResultColumn } from '@strata/contracts'

/** Ancho aproximado de un carácter de la fuente mono de datos, en px. */
export const CHAR_WIDTH = 8
export const MIN_COLUMN_WIDTH = 64
export const MAX_INITIAL_WIDTH = 360
export const MAX_COLUMN_WIDTH = 1200
const CELL_PADDING = 24
/** Filas que se muestrean para dimensionar las columnas: acotado, no recorre 100 000 filas. */
export const SAMPLE_ROWS = 100

const RIGHT_ALIGNED: ReadonlySet<ColumnKind> = new Set(['number'])

export function isRightAligned(kind: ColumnKind): boolean {
  return RIGHT_ALIGNED.has(kind)
}

export const KIND_LABELS: Record<ColumnKind, string> = {
  number: 'número',
  text: 'texto',
  boolean: 'booleano',
  datetime: 'fecha/hora',
  uuid: 'uuid',
  binary: 'binario',
  json: 'json',
  array: 'array',
  other: 'otro',
}

export function clampWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)))
}

/** Ancho de una columna según lo más largo entre su cabecera (nombre y tipo) y una muestra de sus valores. */
export function initialColumnWidth(
  column: ResultColumn,
  columnIndex: number,
  rows: readonly (readonly CellValue[])[],
): number {
  // La cabecera muestra el nombre y, a su lado, el tipo.
  let longest = column.name.length + column.dataType.length + 2
  const sample = Math.min(rows.length, SAMPLE_ROWS)
  for (let index = 0; index < sample; index += 1) {
    const value = rows[index]![columnIndex]
    const length = value === null || value === undefined ? 4 : String(value).length
    if (length > longest) longest = length
  }
  return Math.min(MAX_INITIAL_WIDTH, clampWidth(longest * CHAR_WIDTH + CELL_PADDING))
}

export function rowNumberWidth(rowCount: number): number {
  const digits = String(Math.max(rowCount, 1)).length
  return Math.max(48, digits * CHAR_WIDTH + CELL_PADDING)
}

export interface ColumnLayout {
  /** Desplazamiento izquierdo de cada columna, contado desde el borde de la columna de número de fila. */
  starts: number[]
  /** Ancho de todas las columnas de datos. */
  total: number
}

export function layoutColumns(widths: readonly number[]): ColumnLayout {
  const starts: number[] = []
  let total = 0
  for (const width of widths) {
    starts.push(total)
    total += width
  }
  return { starts, total }
}
