import type { NormalizedError, TransactionState } from '@strata/contracts'
import type { ExecutionScope } from '../../query-editor'

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(2).replace('.', ',')} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes} min ${rest} s`
}

export function formatRows(count: number): string {
  return `${count.toLocaleString('es-ES')} ${count === 1 ? 'fila' : 'filas'}`
}

/** «1 fila recibida» / «5 filas recibidas»: el participio concuerda con el número. */
export function formatRowsAs(count: number, singular: string, plural: string): string {
  return `${formatRows(count)} ${count === 1 ? singular : plural}`
}

export function formatStatements(count: number): string {
  return `${count} ${count === 1 ? 'sentencia' : 'sentencias'}`
}

export const SCOPE_LABELS: Record<ExecutionScope, string> = {
  selection: 'la selección',
  document: 'el documento',
}

/**
 * Los rechazos previos al arranque llegan como `{ ok: false }` sin eventos. Se antepone una explicación en
 * castellano para los conocidos; el mensaje normalizado de main se muestra tal cual, sin añadirle datos.
 */
export function describeRejection(error: NormalizedError): string {
  switch (error.code) {
    case 'busy':
      return 'La sesión está ocupada con otra consulta. Espera a que termine o cancélala.'
    case 'no_session':
      return 'La sesión ya no está abierta. Vuelve a conectar e inténtalo de nuevo.'
    case 'read_only_violation':
      return `Conexión de solo lectura: ${error.message}`
    default:
      return error.message
  }
}

export const TRANSACTION_ACTION_LABELS = {
  begin: { doing: 'Iniciando transacción…', done: 'Transacción iniciada.' },
  commit: { doing: 'Confirmando transacción…', done: 'Transacción confirmada.' },
  rollback: { doing: 'Revirtiendo transacción…', done: 'Transacción revertida.' },
} as const

export type TransactionAction = keyof typeof TRANSACTION_ACTION_LABELS

/** Aviso fijo de la barra mientras la transacción está abortada; la política completa está en el ADR 0004. */
export function transactionHint(state: TransactionState | null): string | null {
  return state === 'aborted'
    ? 'Transacción abortada: solo puedes ejecutar ROLLBACK o pulsar «Revertir».'
    : null
}

/** Motivo con el que se rechaza, sin llegar al servidor, un texto que no cierra la transacción abortada. */
export const ABORTED_RUN_REJECTION =
  'No se puede ejecutar: la transacción está abortada y solo admite ROLLBACK. Escríbelo o pulsa «Revertir».'

export interface TransactionIndicator {
  state: TransactionState
  /** Parte de la etiqueta que se omite a la vista en anchos reducidos; el texto accesible sigue completo. */
  lead: string
  detail: string
}

const TRANSACTION_INDICATORS: Record<TransactionState, Omit<TransactionIndicator, 'state'>> = {
  none: { lead: 'Sin transacción', detail: '' },
  active: { lead: 'Transacción ', detail: 'activa' },
  aborted: { lead: 'Transacción ', detail: 'abortada' },
}

/** Etiqueta del estado de la transacción de la sesión; `null` sin sesión (no hay nada que indicar). */
export function describeTransaction(state: TransactionState | null): TransactionIndicator | null {
  return state === null ? null : { state, ...TRANSACTION_INDICATORS[state] }
}

export interface ExecutionStatusParts {
  /** Prefijo que se omite a la vista en anchos reducidos; vacío si el texto no lo tiene. */
  lead: string
  rest: string
}

/**
 * Separa el prefijo «Última ejecución» de los avisos del último resultado («Última ejecución completada (3 ms).»
 * → «completada (3 ms).») para que, en anchos reducidos, el estado y la duración se lean enteros. `lead + rest`
 * es siempre el texto original: el nombre accesible y el tooltip no pierden nada.
 */
export function splitExecutionStatus(text: string): ExecutionStatusParts {
  const match = /^((?:La )?última ejecución )(?=\S)/i.exec(text)
  const lead = match?.[1] ?? ''
  return { lead, rest: text.slice(lead.length) }
}
