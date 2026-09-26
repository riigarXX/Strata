import type { QueryEvent } from '@strata/contracts'
import { formatDuration, formatRows, formatStatements } from './presentation'

type EventOf<T extends QueryEvent['type']> = Extract<QueryEvent, { type: T }>

const at = (statementIndex: number | undefined): string =>
  statementIndex === undefined ? '' : ` en la sentencia n.º ${statementIndex + 1}`

/** Con `timing` en `false` (`\timing off`) el texto no lleva la duración. */
export function describeStatementDone(event: EventOf<'statement_done'>, timing = true): string {
  const outcome =
    event.rowsAffected !== null
      ? `${event.rowsAffected.toLocaleString('es-ES')} ${event.rowsAffected === 1 ? 'fila afectada' : 'filas afectadas'}`
      : event.rowsReturned === 0
        ? 'sin filas'
        : formatRows(event.rowsReturned)
  const took = timing ? ` · ${formatDuration(event.durationMs)}` : ''
  return `Sentencia n.º ${event.statementIndex + 1} · ${event.command} · ${outcome}${took}`
}

/**
 * Aviso cuando main recortó el resultado. Con `rowsReturned` por debajo de lo pedido, main aplicó un tope
 * propio: se explica el valor efectivo en lugar de dejar que parezca que se perdieron filas sin motivo.
 */
export function describeTruncation(
  event: EventOf<'statement_done'>,
  requestedMaxRows: number | null,
): string {
  const prefix = `Sentencia n.º ${event.statementIndex + 1}: resultado recortado a ${formatRows(event.rowsReturned)}`
  if (requestedMaxRows !== null && event.rowsReturned < requestedMaxRows) {
    return `${prefix}. La aplicación aplicó un tope inferior al pedido (${formatRows(requestedMaxRows)}).`
  }
  return `${prefix}, el máximo configurado.`
}

const NOTICE_TEXTS: Record<NonNullable<EventOf<'notice'>['code']>, string> = {
  transaction_lost: 'La sentencia no se pudo interrumpir: se ha revertido la transacción.',
}

export function describeNotice(event: EventOf<'notice'>): string {
  const text = event.code ? NOTICE_TEXTS[event.code] : event.message
  return `Aviso de la sentencia n.º ${event.statementIndex + 1}: ${text}`
}

export function describeDone(event: EventOf<'done'>, timing = true): string {
  const took = timing ? ` en ${formatDuration(event.durationMs)}` : ''
  return `Ejecución completada: ${formatStatements(event.statementCount)}${took}.`
}

/** Los mensajes de error llegan ya normalizados y redactados por main: se muestran sin añadirles datos. */
export function describeError(event: EventOf<'error'>): string {
  return `Error${at(event.statementIndex)}: ${event.error.message}`
}

export function describeCancelled(event: EventOf<'cancelled'>): string {
  return `Ejecución cancelada${at(event.statementIndex)}.`
}
