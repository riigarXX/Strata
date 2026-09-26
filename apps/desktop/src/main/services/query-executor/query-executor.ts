import type {
  CancelResult,
  ChunkAck,
  HistoryEntry,
  QueryEvent,
  QueryRequest,
  RequestId,
  SessionId,
  TransactionState,
} from '@strata/contracts'
import {
  AdapterError,
  createNormalizedError,
  redactSensitive,
  type RedactionContext,
} from '@strata/db-core'
import type { SessionRuntime } from '../connection-manager'
import {
  managerError,
  redactNormalizedError,
  toNormalizedError,
} from '../connection-manager/errors'
import { QUERY_LIMITS, resolveQueryLimits, type ResolvedLimits } from './limits'
import { assertPureReadAllowed, assertReadOnlyAllowed } from './read-only-guard'

/** Destino de los eventos de una ejecución: el `webContents` que la pidió (o un doble en los tests). */
export interface QueryEventSink {
  /** Identidad del solicitante: solo él puede cancelar o confirmar chunks de esta ejecución. */
  readonly owner: object
  send(event: QueryEvent): void
  isAlive(): boolean
  /** El solicitante se destruyó, se recargó o su proceso murió. Devuelve la función de desuscripción. */
  onGone(listener: () => void): () => void
}

/**
 * Destino de las ejecuciones terminadas (ADR 0005). `record` no espera ni lanza: el historial nunca puede
 * hacer fallar ni retrasar una consulta. El ejecutor no decide si el historial está activo, solo si la
 * petición pidió no guardarse.
 */
export interface QueryHistoryRecorder {
  /** `requestId` identifica la ejecución: no se guarda, solo permite al renderer asociar la entrada a su consulta. */
  record(entry: Omit<HistoryEntry, 'id'>, context: { requestId: string }): void
}

export interface QueryExecutor {
  /**
   * Valida y arranca la ejecución; el resultado llega como `QueryEvent` al `sink`, con exactamente un evento
   * terminal. Los rechazos previos al arranque (`no_session`, `busy`, `read_only_violation`...) se lanzan como
   * `AdapterError` y no emiten eventos.
   */
  execute(request: QueryRequest, sink: QueryEventSink): void
  cancel(requestId: RequestId, owner: object): Promise<CancelResult>
  ack(ack: ChunkAck, owner: object): void
  /** Cancela la ejecución en curso de la sesión (si la hay) y espera a que termine, con un tope. */
  cancelSession(sessionId: SessionId): Promise<void>
}

export interface QueryExecutorDependencies {
  getSessionRuntime(sessionId: SessionId): SessionRuntime | undefined
  chunkWindow?: number
  ackTimeoutMs?: number
  cancelGraceMs?: number
  /** Sin recorder no se registra nada. */
  history?: QueryHistoryRecorder
  /** Reloj en milisegundos desde la época; inyectable en los tests. */
  now?: () => number
}

type CancelReason = 'requested' | 'stalled' | 'disconnected' | 'renderer_gone'

interface Run {
  readonly request: QueryRequest
  readonly runtime: SessionRuntime
  readonly sink: QueryEventSink
  readonly unacked: Set<string>
  readonly startedAt: number
  /** Filas devueltas o afectadas por las sentencias ya terminadas; `undefined` si aún no ha terminado ninguna. */
  rowCount: number | undefined
  cancelReason: CancelReason | undefined
  // El adapter solo conoce la petición desde la primera lectura del iterable.
  started: boolean
  wake: (() => void) | undefined
  readonly finished: Promise<void>
  finish: () => void
}

const ackKey = (statementIndex: number, chunkIndex: number): string =>
  `${statementIndex}:${chunkIndex}`

const isTerminal = (event: QueryEvent): boolean =>
  event.type === 'done' || event.type === 'error' || event.type === 'cancelled'

function redactEvent(event: QueryEvent, redaction: RedactionContext): QueryEvent {
  if (event.type === 'error') {
    return { ...event, error: redactNormalizedError(event.error, redaction) }
  }
  if (event.type === 'notice') {
    return { ...event, message: redactSensitive(event.message, redaction) }
  }
  return event
}

export function createQueryExecutor({
  getSessionRuntime,
  chunkWindow = QUERY_LIMITS.chunkWindow,
  ackTimeoutMs = QUERY_LIMITS.ackTimeoutMs,
  cancelGraceMs = QUERY_LIMITS.cancelGraceMs,
  history,
  now = Date.now,
}: QueryExecutorDependencies): QueryExecutor {
  const runsByRequest = new Map<RequestId, Run>()
  const runsBySession = new Map<SessionId, Run>()

  function transactionOf({ adapter, session }: SessionRuntime): TransactionState | undefined {
    try {
      return adapter.transactionState(session.sessionId)
    } catch {
      return undefined
    }
  }

  async function requestCancel(run: Run, reason: CancelReason): Promise<void> {
    if (run.cancelReason !== undefined) return
    run.cancelReason = reason
    run.wake?.()
    if (!run.started) return
    try {
      await run.runtime.adapter.cancel(run.request.requestId)
    } catch {
      // Sin señal al motor la cancelación sigue siendo cooperativa: el iterable la observa al reanudarse.
    }
  }

  // Espera crédito de ventana; devuelve al llegar un ack, una cancelación o el vencimiento del plazo de confirmación.
  async function waitForCredit(run: Run): Promise<void> {
    while (run.unacked.size >= chunkWindow && run.cancelReason === undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          void requestCancel(run, 'stalled')
        }, ackTimeoutMs)
        run.wake = () => {
          clearTimeout(timer)
          run.wake = undefined
          resolve()
        }
      })
    }
  }

  function withTransaction(runtime: SessionRuntime): { transaction?: TransactionState } {
    const transaction = transactionOf(runtime)
    return transaction === undefined ? {} : { transaction }
  }

  // Un solo evento terminal por ejecución, con el estado de transacción que el adapter reporta en ese momento.
  // `undefined`: el solicitante ya no existe y nadie lo recibiría.
  function terminalEvent(run: Run, event: QueryEvent): QueryEvent | undefined {
    if (run.cancelReason === 'renderer_gone') return undefined
    const { requestId } = run.request
    if (run.cancelReason === 'stalled' && event.type === 'cancelled') {
      return {
        type: 'error',
        requestId,
        ...(event.statementIndex === undefined ? {} : { statementIndex: event.statementIndex }),
        error: createNormalizedError(
          'timeout',
          'The results were not acknowledged in time and the query was cancelled',
          { retryable: false },
        ),
        ...withTransaction(run.runtime),
      }
    }
    if (event.type === 'error' || event.type === 'cancelled') {
      return { ...event, ...withTransaction(run.runtime) }
    }
    return event
  }

  function failure(run: Run, reason: unknown): QueryEvent {
    return {
      type: 'error',
      requestId: run.request.requestId,
      error: redactNormalizedError(toNormalizedError(reason), run.runtime.redaction),
    }
  }

  // Consume el iterable del adapter respetando la ventana de crédito y devuelve el evento terminal a enviar.
  async function drive(run: Run, limits: ResolvedLimits): Promise<QueryEvent | undefined> {
    const { request, runtime, sink } = run
    const { requestId } = request
    if (run.cancelReason !== undefined) {
      return terminalEvent(run, { type: 'cancelled', requestId })
    }

    let iterator: AsyncIterator<QueryEvent> | undefined
    try {
      run.started = true
      iterator = runtime.adapter.execute({ ...request, ...limits })[Symbol.asyncIterator]()

      for (;;) {
        await waitForCredit(run)
        const step = await iterator.next()
        if (step.done) {
          return terminalEvent(
            run,
            failure(
              run,
              new AdapterError(
                createNormalizedError('internal_error', 'The query ended without a result'),
              ),
            ),
          )
        }
        const event = redactEvent(step.value, runtime.redaction)
        if (event.type === 'statement_done') {
          run.rowCount = (run.rowCount ?? 0) + (event.rowsAffected ?? event.rowsReturned)
        }
        if (isTerminal(event)) return terminalEvent(run, event)

        // Tras cancelar solo interesa el evento terminal: lo que el adapter aún emita ya no sirve al renderer.
        if (run.cancelReason !== undefined) continue
        if (!sink.isAlive()) {
          void requestCancel(run, 'renderer_gone')
          continue
        }
        if (event.type === 'chunk') {
          run.unacked.add(ackKey(event.statementIndex, event.chunkIndex))
        }
        sink.send(event)
      }
    } catch (reason) {
      await runtime.adapter.cancel(requestId).catch(() => undefined)
      return terminalEvent(run, failure(run, reason))
    } finally {
      // El generador del adapter sigue suspendido en su último `yield`: su `finally` (cursor, sesión ocupada) solo corre al cerrarlo.
      await iterator?.return?.(undefined).catch(() => undefined)
    }
  }

  // Una entrada por petición con el SQL enviado y metadatos: nunca filas ni mensajes de error (ADR 0005).
  // `terminal` indefinido es un solicitante desaparecido, que cuenta como cancelación.
  function recordHistory(run: Run, terminal: QueryEvent | undefined): void {
    if (!history || run.request.saveToHistory === false) return
    const { session } = run.runtime
    const status =
      terminal?.type === 'done' ? 'ok' : terminal?.type === 'error' ? 'error' : 'cancelled'
    try {
      history.record(
        {
          sql: run.request.sql,
          engine: session.engine,
          profileId: session.profileId,
          profileName: run.runtime.profileName,
          executedAt: new Date(run.startedAt).toISOString(),
          durationMs:
            terminal?.type === 'done' ? terminal.durationMs : Math.max(0, now() - run.startedAt),
          status,
          ...(run.rowCount === undefined ? {} : { rowCount: run.rowCount }),
          ...(terminal?.type === 'error' ? { errorCode: terminal.error.code } : {}),
        },
        { requestId: run.request.requestId },
      )
    } catch {
      // Un recorder defectuoso no puede impedir que el solicitante reciba su evento terminal.
    }
  }

  async function pump(run: Run, limits: ResolvedLimits): Promise<void> {
    const terminal = await drive(run, limits)
    // Primero se libera la sesión y después se avisa: quien reciba el evento terminal ya puede ejecutar de nuevo.
    release(run)
    recordHistory(run, terminal)
    if (terminal && run.sink.isAlive()) run.sink.send(terminal)
  }

  function release(run: Run): void {
    runsByRequest.delete(run.request.requestId)
    if (runsBySession.get(run.request.sessionId) === run) {
      runsBySession.delete(run.request.sessionId)
    }
    run.finish()
  }

  return {
    execute(request, sink) {
      const runtime = getSessionRuntime(request.sessionId)
      if (!runtime) throw managerError('no_session', 'The session does not exist or was closed')
      if (runsBySession.has(request.sessionId)) {
        throw managerError('busy', 'A query is already running on this session')
      }
      if (runsByRequest.has(request.requestId)) {
        throw managerError('validation_failed', 'The request id is already in use')
      }
      // Read-only lo fija main desde el perfil (`Session.readOnly`), nunca la petición.
      if (runtime.session.readOnly) {
        assertReadOnlyAllowed(runtime.session.engine, request.sql)
      }
      // La petición solo puede endurecer la política, nunca relajarla (ADR 0012).
      if (request.enforceReadOnly === true) {
        assertPureReadAllowed(runtime.session.engine, request.sql)
      }

      const limits = resolveQueryLimits(request)
      let finish!: () => void
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const run: Run = {
        request,
        runtime,
        sink,
        unacked: new Set(),
        startedAt: now(),
        rowCount: undefined,
        cancelReason: undefined,
        started: false,
        wake: undefined,
        finished,
        finish,
      }
      runsByRequest.set(request.requestId, run)
      runsBySession.set(request.sessionId, run)

      const stopWatching = sink.onGone(() => {
        void requestCancel(run, 'renderer_gone')
      })
      void finished.then(stopWatching)

      // Tras el turno actual, para que la respuesta de arranque llegue al renderer antes que el primer evento.
      setImmediate(() => {
        void pump(run, limits).catch(() => release(run))
      })
    },

    async cancel(requestId, owner) {
      const run = runsByRequest.get(requestId)
      if (!run || run.sink.owner !== owner) return { requestId, outcome: 'not_running' }
      await requestCancel(run, 'requested')
      return { requestId, outcome: 'requested' }
    },

    ack({ requestId, statementIndex, chunkIndex }, owner) {
      const run = runsByRequest.get(requestId)
      if (!run || run.sink.owner !== owner) return
      // Solo cuenta un chunk realmente enviado: repetir o inventar acks no amplía la ventana.
      if (run.unacked.delete(ackKey(statementIndex, chunkIndex))) run.wake?.()
    },

    async cancelSession(sessionId) {
      const run = runsBySession.get(sessionId)
      if (!run) return
      await requestCancel(run, 'disconnected')
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        run.finished,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, cancelGraceMs)
        }),
      ])
      clearTimeout(timer)
    },
  }
}
