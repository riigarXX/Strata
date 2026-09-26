import type { HistoryEntry, HistoryStatus } from '@strata/contracts'
import type { DateRangeProblem } from './filters'

// El estado siempre se comunica con texto; el glifo de refuerzo lo aporta el CSS desde los tokens
// (`status.glyph.*`) en un elemento aria-hidden.
export const HISTORY_STATUS_LABELS: Record<HistoryStatus, string> = {
  ok: 'Correcta',
  error: 'Con error',
  cancelled: 'Cancelada',
}

const PREVIEW_MAX_CHARS = 160
// Solo se mira el arranque del texto: una consulta de 20 000 caracteres no debe procesarse entera para una fila.
const PREVIEW_SCAN_CHARS = PREVIEW_MAX_CHARS * 4

/** Una sola línea con los espacios colapsados y cortada con «…»: lo que cabe en una fila de la lista. */
export function previewSql(sql: string, maxChars: number = PREVIEW_MAX_CHARS): string {
  const scanned = sql.length > PREVIEW_SCAN_CHARS ? sql.slice(0, PREVIEW_SCAN_CHARS) : sql
  const collapsed = scanned.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars && scanned === sql) return collapsed
  return `${collapsed.slice(0, maxChars).trimEnd()}…`
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const RELATIVE_LIMIT_DAYS = 7

const ABSOLUTE = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' })

export function formatAbsoluteDate(iso: string): string {
  return ABSOLUTE.format(new Date(iso))
}

/** «hace 5 min», «hace 3 h», «hace 2 días»; pasada una semana solo tiene sentido la fecha (cadena vacía). */
export function formatRelativeDate(iso: string, now: number): string {
  const elapsed = now - new Date(iso).getTime()
  if (elapsed < MINUTE_MS) return 'hace un momento'
  if (elapsed < HOUR_MS) return `hace ${Math.floor(elapsed / MINUTE_MS)} min`
  if (elapsed < DAY_MS) return `hace ${Math.floor(elapsed / HOUR_MS)} h`
  const days = Math.floor(elapsed / DAY_MS)
  if (days < RELATIVE_LIMIT_DAYS) return `hace ${days} ${days === 1 ? 'día' : 'días'}`
  return ''
}

export const DATE_PROBLEM_MESSAGES: Record<DateRangeProblem, string> = {
  'invalid-from': 'La fecha «Desde» no es válida.',
  'invalid-to': 'La fecha «Hasta» no es válida.',
  inverted: 'La fecha «Desde» no puede ser posterior a «Hasta».',
}

export function describeCleared(deleted: number): string {
  if (deleted === 0) return 'El historial ya estaba vacío'
  return `Historial vaciado: ${deleted} ${deleted === 1 ? 'consulta eliminada' : 'consultas eliminadas'}`
}

export type ExclusionResult = 'excluded' | 'gone' | 'error'

/** Anuncio (y mensaje) del resultado de «quitar del historial» la consulta recién ejecutada. */
export function describeExclusion(result: ExclusionResult, detail = ''): string {
  if (result === 'excluded') return 'Consulta quitada del historial'
  if (result === 'gone') return 'La consulta ya no estaba en el historial'
  return `No se pudo quitar la consulta del historial. ${detail}`.trim()
}

export function describeCount(count: number, more: boolean): string {
  const text = `${count} ${count === 1 ? 'consulta' : 'consultas'}`
  return more ? `${text}; hay más por cargar` : text
}

/** Etiqueta accesible del botón de borrar: dice qué consulta se va a eliminar, no solo «Borrar». */
export function deleteLabel(entry: HistoryEntry): string {
  return `Borrar del historial: ${previewSql(entry.sql, 60)}`
}
