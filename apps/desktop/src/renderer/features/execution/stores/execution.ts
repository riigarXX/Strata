import {
  QueryRequestSchema,
  type NormalizedError,
  type QueryEvent,
  type QueryRequest,
  type SessionId,
  type TransactionState,
} from '@strata/contracts'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useConnectionsStore } from '../../connections'
import { usePreferencesStore } from '../../preferences'
import type { ExecutionScope } from '../../query-editor'
import { useQueryApi } from '../api/use-query-api'
import {
  describeCancelled,
  describeDone,
  describeError,
  describeNotice,
  describeStatementDone,
  describeTruncation,
} from '../model/event-messages'
import {
  describeRejection,
  TRANSACTION_ACTION_LABELS,
  type TransactionAction,
} from '../model/presentation'
import { useResultBuffers } from '../model/result-buffers'

export type ExecutionStatus = 'idle' | 'running' | 'cancelling'
export type ExecutionOutcome = 'done' | 'error' | 'cancelled'
export type MessageKind =
  'notice' | 'warning' | 'statement' | 'success' | 'error' | 'cancelled' | 'transaction'

export interface ExecutionMessage {
  id: number
  kind: MessageKind
  text: string
  /** Mismo mensaje sin la duración, para cuando `\timing` está desactivado; solo si `text` la lleva. */
  untimedText?: string
}

/** Resumen de una sentencia terminada: lo que el grid muestra de las que no devuelven filas (o cuyas filas se descartaron). */
export interface StatementSummary {
  statementIndex: number
  command: string
  rowsReturned: number
  rowsAffected: number | null
  durationMs: number
  truncated: boolean
}

/**
 * Metadatos de la ejecución de una pestaña. Las filas NO están aquí sino en el búfer de
 * `useResultBuffers()`, y el SQL ni siquiera se copia: Pinia no guarda resultados ni secretos.
 */
export interface TabExecution {
  status: ExecutionStatus
  /** Petición en curso; vuelve a `null` al terminar. */
  requestId: string | null
  /** Última petición aceptada de la pestaña, también tras terminar: permite asociarle su entrada del historial. */
  lastRequestId: string | null
  sessionId: SessionId | null
  scope: ExecutionScope | null
  /** Límites que se pidieron en la última ejecución (main puede recortarlos). */
  limits: { timeoutSeconds: number; maxRows: number } | null
  outcome: ExecutionOutcome | null
  statementsDone: number
  statementCount: number | null
  /** Últimas `MAX_STATEMENT_SUMMARIES` sentencias terminadas, en orden. */
  statements: StatementSummary[]
  rowsReceived: number
  truncated: boolean
  durationMs: number | null
  /** Último error normalizado (evento `error` o rechazo previo al arranque) y su texto para mostrar. */
  error: NormalizedError | null
  errorSummary: string | null
  transactionBusy: TransactionAction | null
  messages: ExecutionMessage[]
  droppedMessages: number
}

/** Tope del registro de mensajes de una pestaña: un script con miles de sentencias no lo hace crecer sin límite. */
export const MAX_MESSAGES = 500
/** Igual que los mensajes, el resumen por sentencia no crece sin límite con un script de miles de sentencias. */
export const MAX_STATEMENT_SUMMARIES = 200
/** Si tras pedir la cancelación main no reconoce la petición y no llega evento terminal, se da por terminada. */
export const STALE_CANCEL_MS = 2000

function freshState(): TabExecution {
  return {
    status: 'idle',
    requestId: null,
    lastRequestId: null,
    sessionId: null,
    scope: null,
    limits: null,
    outcome: null,
    statementsDone: 0,
    statementCount: null,
    statements: [],
    rowsReceived: 0,
    truncated: false,
    durationMs: null,
    error: null,
    errorSummary: null,
    transactionBusy: null,
    messages: [],
    droppedMessages: 0,
  }
}

const IDLE: TabExecution = Object.freeze(freshState())

export interface RunInput {
  sessionId: SessionId
  sql: string
  scope: ExecutionScope
  /** `false` excluye esta ejecución del historial (ADR 0005); por defecto se guarda. */
  saveToHistory?: boolean
  /** Ejecución de pura lectura (ADR 0012): main la restringe aunque el perfil no sea de solo lectura. Solo puede endurecer. */
  enforceReadOnly?: boolean
}

export const useExecutionStore = defineStore('execution', () => {
  const api = useQueryApi()
  const connections = useConnectionsStore()
  const preferences = usePreferencesStore()
  const buffers = useResultBuffers()

  const byTab = ref<Record<string, TabExecution>>({})

  // Contabilidad interna que no es estado de UI: quién es dueño de cada petición y sus temporizadores.
  const owners = new Map<string, string>()
  const startedAt = new Map<string, number>()
  const starting = new Map<string, Promise<unknown>>()
  const staleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let messageCounter = 0

  function stateOf(tabId: string): TabExecution {
    return byTab.value[tabId] ?? IDLE
  }

  function ensure(tabId: string): TabExecution {
    byTab.value[tabId] ??= freshState()
    return byTab.value[tabId]
  }

  function pushMessage(tabId: string, kind: MessageKind, text: string, untimedText?: string): void {
    const entry = ensure(tabId)
    messageCounter += 1
    entry.messages.push(
      untimedText === undefined
        ? { id: messageCounter, kind, text }
        : { id: messageCounter, kind, text, untimedText },
    )
    const overflow = entry.messages.length - MAX_MESSAGES
    if (overflow > 0) {
      entry.messages.splice(0, overflow)
      entry.droppedMessages += overflow
    }
  }

  /** ¿Otra pestaña está ejecutando en esta sesión? Main solo admite una ejecución activa por sesión. */
  function isSessionBusy(sessionId: SessionId, exceptTabId: string): boolean {
    return Object.entries(byTab.value).some(
      ([tabId, entry]) =>
        tabId !== exceptTabId && entry.sessionId === sessionId && entry.requestId !== null,
    )
  }

  function release(requestId: string): void {
    const timer = staleTimers.get(requestId)
    if (timer !== undefined) clearTimeout(timer)
    staleTimers.delete(requestId)
    owners.delete(requestId)
    starting.delete(requestId)
  }

  interface Outcome {
    outcome: ExecutionOutcome
    durationMs?: number
    error?: NormalizedError
    errorSummary?: string
    statementCount?: number
    transaction?: TransactionState | undefined
  }

  // Cierra la ejecución de la pestaña: vuelve a `idle` con todo lo necesario para corregir y reejecutar.
  function finish(tabId: string, requestId: string, details: Outcome): void {
    const started = startedAt.get(requestId)
    startedAt.delete(requestId)
    release(requestId)
    const entry = ensure(tabId)
    entry.status = 'idle'
    entry.requestId = null
    entry.outcome = details.outcome
    entry.durationMs =
      details.durationMs ?? (started === undefined ? null : performance.now() - started)
    entry.error = details.error ?? null
    entry.errorSummary = details.errorSummary ?? null
    if (details.statementCount !== undefined) entry.statementCount = details.statementCount
    if (details.transaction !== undefined && entry.sessionId !== null) {
      connections.applyTransaction(entry.sessionId, details.transaction)
    }
  }

  function reject(tabId: string, sessionId: SessionId, error: NormalizedError): void {
    buffers.discard(tabId)
    const summary = describeRejection(error)
    byTab.value[tabId] = {
      ...freshState(),
      sessionId,
      outcome: 'error',
      error,
      errorSummary: summary,
    }
    pushMessage(tabId, 'error', summary)
  }

  async function run(
    tabId: string,
    { sessionId, sql, scope, saveToHistory = true, enforceReadOnly = false }: RunInput,
  ): Promise<void> {
    if (stateOf(tabId).status !== 'idle') return

    const limits = {
      timeoutSeconds: preferences.timeoutSeconds,
      maxRows: preferences.maxRows,
    }
    const request: QueryRequest = {
      requestId: crypto.randomUUID(),
      sessionId,
      sql,
      timeoutMs: limits.timeoutSeconds * 1000,
      maxRows: limits.maxRows,
      // Solo se envía el opt-out: omitido significa «guardar» (salvo que main tenga el historial desactivado).
      ...(saveToHistory ? {} : { saveToHistory: false }),
      ...(enforceReadOnly ? { enforceReadOnly: true as const } : {}),
    }
    if (!QueryRequestSchema.safeParse(request).success) {
      reject(tabId, sessionId, {
        code: 'validation_failed',
        message:
          sql.trim() === ''
            ? 'No hay SQL que ejecutar.'
            : 'La consulta es demasiado larga para enviarla.',
        retryable: false,
      })
      return
    }

    const { requestId } = request
    // Se registra antes de enviar: los eventos pueden llegar antes de que se resuelva `execute`.
    owners.set(requestId, tabId)
    startedAt.set(requestId, performance.now())
    buffers.begin(tabId, limits.maxRows)
    byTab.value[tabId] = {
      ...freshState(),
      status: 'running',
      requestId,
      lastRequestId: requestId,
      sessionId,
      scope,
      limits,
    }

    const pending = api.execute(request)
    starting.set(requestId, pending)
    const result = await pending
    starting.delete(requestId)
    if (!result.ok && owners.get(requestId) === tabId) {
      startedAt.delete(requestId)
      release(requestId)
      reject(tabId, sessionId, result.error)
    }
  }

  async function cancel(tabId: string): Promise<void> {
    const entry = stateOf(tabId)
    const { requestId } = entry
    if (entry.status !== 'running' || requestId === null) return
    ensure(tabId).status = 'cancelling'

    // Si `execute` aún no ha respondido, main puede no conocer la petición todavía.
    await starting.get(requestId)
    if (owners.get(requestId) !== tabId) return
    const result = await api.cancel({ requestId })
    if (owners.get(requestId) !== tabId) return
    if (result.ok && result.data.outcome === 'requested') return

    // Main no la reconoce: o ya terminó (su evento terminal viaja delante) o se perdió. Se espera un poco y se cierra.
    staleTimers.set(
      requestId,
      setTimeout(() => {
        staleTimers.delete(requestId)
        if (owners.get(requestId) !== tabId) return
        pushMessage(tabId, 'cancelled', 'Ejecución cancelada.')
        finish(tabId, requestId, { outcome: 'cancelled' })
      }, STALE_CANCEL_MS),
    )
  }

  function applyEvent(event: QueryEvent): void {
    const tabId = owners.get(event.requestId)
    if (tabId === undefined) return
    const entry = ensure(tabId)

    switch (event.type) {
      case 'chunk':
        buffers.append(tabId, event)
        entry.rowsReceived += event.rows.length
        void api.ack({
          requestId: event.requestId,
          statementIndex: event.statementIndex,
          chunkIndex: event.chunkIndex,
        })
        return
      case 'notice':
        pushMessage(tabId, event.level === 'warning' ? 'warning' : 'notice', describeNotice(event))
        return
      case 'statement_done':
        entry.statementsDone += 1
        entry.statements.push({
          statementIndex: event.statementIndex,
          command: event.command,
          rowsReturned: event.rowsReturned,
          rowsAffected: event.rowsAffected,
          durationMs: event.durationMs,
          truncated: event.truncated,
        })
        if (entry.statements.length > MAX_STATEMENT_SUMMARIES) entry.statements.shift()
        pushMessage(
          tabId,
          'statement',
          describeStatementDone(event),
          describeStatementDone(event, false),
        )
        if (event.truncated) {
          entry.truncated = true
          pushMessage(tabId, 'warning', describeTruncation(event, entry.limits?.maxRows ?? null))
        }
        return
      case 'done':
        pushMessage(tabId, 'success', describeDone(event), describeDone(event, false))
        finish(tabId, event.requestId, {
          outcome: 'done',
          durationMs: event.durationMs,
          statementCount: event.statementCount,
          transaction: event.transaction,
        })
        return
      case 'error':
        pushMessage(tabId, 'error', describeError(event))
        finish(tabId, event.requestId, {
          outcome: 'error',
          error: event.error,
          errorSummary: event.error.message,
          transaction: event.transaction,
        })
        return
      case 'cancelled':
        pushMessage(tabId, 'cancelled', describeCancelled(event))
        finish(tabId, event.requestId, { outcome: 'cancelled', transaction: event.transaction })
        return
    }
  }

  async function runTransaction(
    tabId: string,
    sessionId: SessionId,
    action: TransactionAction,
  ): Promise<void> {
    const entry = ensure(tabId)
    if (entry.status !== 'idle' || entry.transactionBusy !== null) return
    entry.sessionId = sessionId
    entry.transactionBusy = action

    const result = await api.transactions[action]({ sessionId })
    const current = byTab.value[tabId]
    if (!current) return
    current.transactionBusy = null
    if (result.ok) {
      connections.applyTransaction(result.data.sessionId, result.data.transaction)
      current.error = null
      current.errorSummary = null
      pushMessage(tabId, 'transaction', TRANSACTION_ACTION_LABELS[action].done)
    } else {
      const summary = describeRejection(result.error)
      current.error = result.error
      current.errorSummary = summary
      pushMessage(tabId, 'error', summary)
    }
  }

  function interrupt(tabId: string, entry: TabExecution, reason: string): void {
    const { requestId } = entry
    if (requestId === null) return
    const error: NormalizedError = { code: 'no_session', message: reason, retryable: false }
    pushMessage(tabId, 'error', reason)
    finish(tabId, requestId, { outcome: 'error', error, errorSummary: reason })
  }

  /** La sesión ya no existe: las ejecuciones que dependían de ella no recibirán evento terminal. */
  function sessionClosed(sessionId: SessionId): void {
    for (const [tabId, entry] of Object.entries(byTab.value)) {
      if (entry.sessionId === sessionId) {
        interrupt(tabId, entry, 'La sesión se cerró durante la ejecución.')
      }
    }
  }

  /** Se dejó de escuchar los eventos: nada cerraría ya las ejecuciones en curso. */
  function abandonAll(): void {
    for (const [tabId, entry] of Object.entries(byTab.value)) {
      if (entry.requestId !== null) {
        void api.cancel({ requestId: entry.requestId })
        interrupt(tabId, entry, 'La ejecución se interrumpió.')
      }
    }
  }

  /** `\clear`: vacía mensajes y resultados de la pestaña. No hace nada mientras ejecuta o hay una operación en curso. */
  function clearTab(tabId: string): boolean {
    const entry = byTab.value[tabId]
    if (entry && (entry.status !== 'idle' || entry.transactionBusy !== null)) return false
    buffers.discard(tabId)
    delete byTab.value[tabId]
    return true
  }

  function forgetTab(tabId: string): void {
    const entry = byTab.value[tabId]
    if (entry?.requestId) {
      void api.cancel({ requestId: entry.requestId })
      startedAt.delete(entry.requestId)
      release(entry.requestId)
    }
    buffers.discard(tabId)
    delete byTab.value[tabId]
  }

  return {
    byTab,
    stateOf,
    isSessionBusy,
    run,
    cancel,
    applyEvent,
    runTransaction,
    sessionClosed,
    abandonAll,
    clearTab,
    forgetTab,
  }
})
