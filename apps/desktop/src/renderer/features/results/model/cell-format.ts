import type { CellValue } from '@strata/contracts'

export const NULL_LABEL = 'NULL'
/** Una celda puede llegar a 256 KiB: en el DOM de la fila solo se pone el principio, el valor entero va en el detalle. */
export const DISPLAY_MAX_CHARS = 300

const LINE_BREAKS = /\r\n|[\r\n]/g
const TAB = /\t/g

/** Texto de una celda en su fila: una sola línea, acotado, con `NULL` como texto propio. */
export function displayText(value: CellValue): string {
  if (value === null) return NULL_LABEL
  const text = typeof value === 'string' ? value : String(value)
  const head = text.length > DISPLAY_MAX_CHARS ? text.slice(0, DISPLAY_MAX_CHARS) : text
  const flat = head.replace(LINE_BREAKS, '↵').replace(TAB, '⇥')
  return text.length > DISPLAY_MAX_CHARS ? `${flat}…` : flat
}

/** Valor completo tal como llegó, para la línea de detalle. */
export function fullText(value: CellValue): string {
  return value === null ? NULL_LABEL : String(value)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toLocaleString('es-ES', { maximumFractionDigits: 1 })} ${units[unit]}`
}

export function truncationNotice(originalBytes: number): string {
  return `Valor truncado: el original ocupa ${formatBytes(originalBytes)} y solo se conserva el principio.`
}
