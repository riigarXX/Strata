import type { CellValue, ResultColumn } from '@strata/contracts'
import { truncatedBytes, type ResultSetView } from '../../execution/model/result-buffers'
import type { CellRange } from './selection'

/**
 * Tope de una copia: el portapapeles y el pegado en una hoja de cálculo no aguantan más, y una celda
 * truncada puede pesar 256 KiB. Al alcanzarlo se copia lo que cupo y se avisa.
 */
export const COPY_LIMITS = { maxCells: 1_000_000, maxChars: 32_000_000 } as const

const NEEDS_QUOTES = /[\t\r\n"]/

/**
 * Campo TSV: se entrecomilla (y las comillas se duplican) si contiene tabulador, salto de línea o comillas,
 * como hacen Excel y Google Sheets al copiar, para que se peguen en una sola celda.
 */
export function escapeTsvField(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** `NULL` se copia como campo vacío (lo que esperan las hojas de cálculo); el resto, tal como es. */
export function copyText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

export interface CopySource {
  columns: readonly ResultColumn[]
  rows: ResultSetView['rows']
  truncatedIndex: ResultSetView['truncatedIndex']
  /** Fila de origen que corresponde a la posición `index` de lo que se ve (con filtro no coinciden). */
  sourceRow: (index: number) => number
}

export interface CopyOptions {
  headers: boolean
  limits?: { maxCells: number; maxChars: number }
  /** Tiempo por tanda antes de ceder el hilo. */
  budgetMs?: number
  yieldToMain?: () => Promise<void>
  now?: () => number
}

export interface CopyResult {
  text: string
  rows: number
  cols: number
  /** Celdas copiadas que main había cortado: el portapapeles lleva el valor truncado. */
  truncatedCells: number
  /** Se paró en el tope: `rows` es menos de lo seleccionado. */
  capped: boolean
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export async function buildTsv(
  source: CopySource,
  range: CellRange,
  options: CopyOptions,
): Promise<CopyResult> {
  const limits = options.limits ?? COPY_LIMITS
  const budgetMs = options.budgetMs ?? 8
  const yieldToMain = options.yieldToMain ?? defaultYield
  const now = options.now ?? (() => performance.now())

  const cols = range.colEnd - range.colStart + 1
  const lines: string[] = []
  let chars = 0
  if (options.headers) {
    const header = source.columns
      .slice(range.colStart, range.colEnd + 1)
      .map((column) => escapeTsvField(column.name))
      .join('\t')
    lines.push(header)
    chars += header.length + 1
  }

  let rowsCopied = 0
  let truncatedCells = 0
  let capped = false
  let deadline = now() + budgetMs
  for (let index = range.rowStart; index <= range.rowEnd; index += 1) {
    if ((rowsCopied + 1) * cols > limits.maxCells || chars >= limits.maxChars) {
      capped = true
      break
    }
    const sourceRow = source.sourceRow(index)
    const values = source.rows[sourceRow]
    if (!values) break
    const fields: string[] = []
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      fields.push(escapeTsvField(copyText(values[col] ?? null)))
      if (truncatedBytes(source, sourceRow, col) !== null) truncatedCells += 1
    }
    const line = fields.join('\t')
    lines.push(line)
    chars += line.length + 1
    rowsCopied += 1
    if (now() >= deadline) {
      await yieldToMain()
      deadline = now() + budgetMs
    }
  }
  return { text: lines.join('\n'), rows: rowsCopied, cols, truncatedCells, capped }
}

export function describeCopy(result: CopyResult, requestedRows: number, headers: boolean): string {
  const rows = `${result.rows.toLocaleString('es-ES')} ${result.rows === 1 ? 'fila' : 'filas'}`
  const cols = `${result.cols.toLocaleString('es-ES')} ${result.cols === 1 ? 'columna' : 'columnas'}`
  const parts = [`Copiadas ${rows} × ${cols}${headers ? ' con cabeceras' : ''}.`]
  if (result.capped) {
    parts.push(
      `Copia limitada por el tope de tamaño: se copiaron ${result.rows.toLocaleString('es-ES')} de ${requestedRows.toLocaleString('es-ES')} filas seleccionadas.`,
    )
  }
  if (result.truncatedCells > 0) {
    const n = result.truncatedCells.toLocaleString('es-ES')
    parts.push(
      result.truncatedCells === 1
        ? `${n} celda truncada se copió cortada.`
        : `${n} celdas truncadas se copiaron cortadas.`,
    )
  }
  return parts.join(' ')
}
