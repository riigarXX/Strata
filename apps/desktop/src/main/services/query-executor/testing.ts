import type {
  CancelResult,
  QueryEvent,
  QueryRequest,
  RequestId,
  Session,
  TransactionState,
} from '@strata/contracts'
import type { DatabaseAdapter } from '@strata/db-core'
import type { SessionRuntime } from '../connection-manager'
import { createFakeAdapter } from '../connection-manager/testing'
import type { QueryEventSink } from './query-executor'

// Dobles compartidos por los tests del ejecutor de consultas y de los handlers IPC.

export interface StreamingAdapterOptions {
  /** Chunks que emite antes de `done`. */
  chunks?: number
  /** Tras este chunk el iterable se queda esperando (como una lectura en vuelo en PostgreSQL) hasta que se cancele. */
  hangAfterChunk?: number
  transaction?: TransactionState
  /** Evento terminal en lugar de `done` (error del motor). */
  failWith?: Extract<QueryEvent, { type: 'error' }>['error']
  /** El iterable lanza en la lectura número N (0 = la primera). */
  throwAtRead?: number
  /** El iterable termina sin evento terminal tras el último chunk. */
  endWithoutTerminal?: boolean
}

export interface StreamingAdapter extends DatabaseAdapter {
  readonly executed: QueryRequest[]
  readonly cancelled: RequestId[]
  /** Chunks entregados a quien consume el iterable. */
  pulled: number
  /** Iterables abiertos y aún sin cerrar; debe volver a 0 cuando termina una ejecución. */
  open: number
  transaction: TransactionState
}

export function createStreamingAdapter(options: StreamingAdapterOptions = {}): StreamingAdapter {
  const base = createFakeAdapter('sqlite')
  const cancelledIds = new Set<RequestId>()
  let release: (() => void) | undefined

  const adapter: StreamingAdapter = {
    ...base,
    capabilities: { ...base.capabilities, cancellation: true, transactions: true },
    executed: [],
    cancelled: [],
    pulled: 0,
    open: 0,
    transaction: options.transaction ?? 'none',

    async *execute(request) {
      const { requestId } = request
      adapter.executed.push(request)
      adapter.open++
      try {
        const total = options.chunks ?? 3
        for (let index = 0; index < total; index++) {
          if (options.throwAtRead === index) throw new Error('driver exploded near secret-host')
          if (cancelledIds.has(requestId)) {
            yield { type: 'cancelled', requestId, statementIndex: 0 }
            return
          }
          if (options.hangAfterChunk === index) {
            await new Promise<void>((resolve) => {
              release = resolve
            })
            if (cancelledIds.has(requestId)) {
              yield { type: 'cancelled', requestId, statementIndex: 0 }
              return
            }
          }
          adapter.pulled++
          yield {
            type: 'chunk',
            requestId,
            statementIndex: 0,
            chunkIndex: index,
            columns: [{ name: 'n', dataType: 'integer', kind: 'number' }],
            rows: Array.from({ length: request.chunkSize ?? 1 }, (_, row) => [index * 1000 + row]),
          }
        }
        if (options.endWithoutTerminal) return
        yield {
          type: 'statement_done',
          requestId,
          statementIndex: 0,
          command: 'SELECT',
          rowsReturned: total,
          rowsAffected: null,
          durationMs: 1,
          truncated: false,
        }
        yield options.failWith
          ? { type: 'error', requestId, statementIndex: 0, error: options.failWith }
          : {
              type: 'done',
              requestId,
              statementCount: 1,
              durationMs: 2,
              transaction: adapter.transaction,
            }
      } finally {
        adapter.open--
      }
    },

    async cancel(requestId): Promise<CancelResult> {
      adapter.cancelled.push(requestId)
      cancelledIds.add(requestId)
      release?.()
      return { requestId, outcome: 'requested' }
    },

    transactionState: () => adapter.transaction,
    begin: async (sessionId) => ({ sessionId, transaction: 'active' }),
    commit: async (sessionId) => ({ sessionId, transaction: 'none' }),
    rollback: async (sessionId) => ({ sessionId, transaction: 'none' }),
  }
  return adapter
}

export const REDACTION = { host: 'db.internal.example', user: 'analyst', secrets: ['s3cr3t-pw'] }

export function createSessionRuntime(
  adapter: DatabaseAdapter,
  overrides: Partial<Session> = {},
): SessionRuntime {
  return {
    session: {
      sessionId: 'session-1',
      profileId: 'profile-1',
      engine: 'sqlite',
      serverVersion: '3.46.0',
      readOnly: false,
      transaction: 'none',
      ...overrides,
    },
    profileName: 'Local profile',
    adapter,
    redaction: REDACTION,
  }
}

export interface FakeSink extends QueryEventSink {
  readonly events: QueryEvent[]
  alive: boolean
  goneListeners: number
  /** Simula la destrucción o recarga del solicitante. */
  disappear(): void
  ofType<T extends QueryEvent['type']>(type: T): Extract<QueryEvent, { type: T }>[]
}

export function createFakeSink(owner: object = {}): FakeSink {
  const listeners = new Set<() => void>()
  const sink: FakeSink = {
    owner,
    events: [],
    alive: true,
    get goneListeners() {
      return listeners.size
    },
    isAlive: () => sink.alive,
    send(event) {
      if (sink.alive) sink.events.push(event)
    },
    onGone(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    disappear() {
      sink.alive = false
      for (const listener of [...listeners]) listener()
    },
    ofType: (type) => sink.events.filter((event): event is never => event.type === type) as never,
  }
  return sink
}

/** Cede el turno hasta que `condition` se cumpla (con temporizadores reales). */
export async function until(condition: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (condition()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('condition not met')
}
