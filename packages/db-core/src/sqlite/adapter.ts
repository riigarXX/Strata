import { Worker } from 'node:worker_threads'
import type {
  CancelResult,
  QueryEvent,
  QueryRequest,
  RequestId,
  SchemaInfo,
  Session,
  SessionId,
  TableDetails,
  TableInfo,
  TableRef,
  TestConnectionResult,
  TransactionResult,
  TransactionState,
} from '@strata/contracts'
import type { AdapterCapabilities, DatabaseAdapter, ResolvedConnectionProfile } from '../adapter'
import {
  AdapterError,
  createNormalizedError,
  DEFAULT_ERROR_MESSAGES,
  normalizeUnknownError,
} from '../normalization'
import type {
  PullResult,
  SqliteWorkerData,
  WorkerCallMethod,
  WorkerReply,
  WorkerRequest,
} from './worker-protocol'

export { isSupportedSqliteVersion, SQLITE_MINIMUM_VERSION } from './engine'

export interface SqliteAdapterOptions {
  // Compiled JavaScript of ./worker.ts. The desktop build produces it (electron-vite `?modulePath`); tests bundle it with esbuild.
  readonly workerPath: string
  readonly minimumVersion?: string
  // How long a worker gets to stop by itself after cancel or timeout before it is terminated and replaced.
  readonly abortGraceMs?: number
  // Same, but for a session with an open transaction: replacing the worker rolls it back, so it is worth waiting for a step that is merely slow.
  readonly transactionAbortGraceMs?: number
}

const DEFAULT_ABORT_GRACE_MS = 150
const DEFAULT_TRANSACTION_ABORT_GRACE_MS = 5000

// better-sqlite3 runs in a worker thread: cancel and timeout are acted on by the main thread at once, and a statement that cannot be interrupted is abandoned by terminating its thread.
const CAPABILITIES: AdapterCapabilities = {
  cancellation: true,
  cancellationMode: 'immediate',
  schemas: false,
  explain: false,
  transactions: true,
  readOnlyMode: true,
}

const TRANSACTION_LOST_MESSAGE =
  'The statement could not be interrupted: the transaction was rolled back'

const noSession = (): AdapterError =>
  new AdapterError(createNormalizedError('no_session', DEFAULT_ERROR_MESSAGES.no_session))

const workerLost = (): AdapterError =>
  new AdapterError(
    createNormalizedError('internal_error', 'The SQLite worker stopped unexpectedly'),
  )

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Request/reply over the worker's message port. Every reply also refreshes the cached transaction state.
class WorkerClient {
  transaction: TransactionState = 'none'
  private readonly worker: Worker
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  private nextId = 1
  private closed = false

  constructor(workerPath: string, data: SqliteWorkerData) {
    this.worker = new Worker(workerPath, { workerData: data })
    // A worker must never keep the app alive on its own, least of all one abandoned mid-statement.
    this.worker.unref()
    this.worker.on('message', (reply: WorkerReply) => {
      const entry = this.pending.get(reply.id)
      if (!entry) return
      this.pending.delete(reply.id)
      this.transaction = reply.transaction
      if (reply.ok) entry.resolve(reply.value)
      else entry.reject(new AdapterError(reply.error))
    })
    this.worker.on('error', () => this.fail())
    this.worker.on('exit', () => this.fail())
  }

  get isClosed(): boolean {
    return this.closed
  }

  request<T>(message: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> {
    if (this.closed) return Promise.reject(workerLost())
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.worker.postMessage({ ...message, id })
    })
  }

  call<T>(method: WorkerCallMethod, ...args: unknown[]): Promise<T> {
    return this.request<T>({ op: 'call', method, args })
  }

  // Does not wait for the thread: a step inside SQLite cannot be stopped, so the thread ends whenever that step returns.
  terminate(): void {
    if (this.closed) return
    this.fail()
    void this.worker.terminate()
  }

  private fail(): void {
    this.closed = true
    for (const entry of this.pending.values()) entry.reject(workerLost())
    this.pending.clear()
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

interface ActiveRun {
  cancelRequested: boolean
  readonly cancelled: Deferred<void>
}

interface SqliteSession {
  readonly sessionId: SessionId
  readonly profile: ResolvedConnectionProfile
  client: WorkerClient
  activeRun: ActiveRun | undefined
}

export function createSqliteAdapter(options: SqliteAdapterOptions): DatabaseAdapter {
  const graceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS
  const transactionGraceMs = Math.max(
    graceMs,
    options.transactionAbortGraceMs ?? DEFAULT_TRANSACTION_ABORT_GRACE_MS,
  )
  const sessions = new Map<SessionId, SqliteSession>()
  const runs = new Map<RequestId, ActiveRun>()

  const spawn = (sessionId?: SessionId): WorkerClient =>
    new WorkerClient(options.workerPath, {
      ...(options.minimumVersion !== undefined && { minimumVersion: options.minimumVersion }),
      ...(sessionId !== undefined && { sessionId }),
    })

  function requireSession(sessionId: SessionId): SqliteSession {
    const session = sessions.get(sessionId)
    if (!session) throw noSession()
    return session
  }

  async function inSession<T>(
    sessionId: SessionId,
    method: WorkerCallMethod,
    ...args: unknown[]
  ): Promise<T> {
    const session = requireSession(sessionId)
    return session.client.call<T>(method, sessionId, ...args)
  }

  // Replaces a worker stuck in a step: same session id, fresh connection. An open transaction does not survive it, exactly as if the statement had been rolled back.
  async function replaceWorker(session: SqliteSession): Promise<void> {
    session.client.terminate()
    const client = spawn(session.sessionId)
    session.client = client
    try {
      await client.call('connect', session.profile)
    } catch {
      client.terminate()
      sessions.delete(session.sessionId)
    }
  }

  // Waits for the worker to acknowledge the abort. A worker inside a step that never returns in time is abandoned; that costs the open transaction, so the result says whether it happened.
  async function stopWorker(
    session: SqliteSession,
    requestId: RequestId,
  ): Promise<{ readonly transactionLost: boolean }> {
    const client = session.client
    const inTransaction = client.transaction !== 'none'
    const timer = deferred<'stuck'>()
    const handle = setTimeout(
      () => timer.resolve('stuck'),
      inTransaction ? transactionGraceMs : graceMs,
    )
    const acknowledged = client.request({ op: 'abort', requestId }).then(
      () => 'stopped' as const,
      () => 'stopped' as const,
    )
    const outcome = await Promise.race([acknowledged, timer.promise])
    clearTimeout(handle)
    if (outcome === 'stuck') {
      await replaceWorker(session)
      return { transactionLost: inTransaction }
    }
    return { transactionLost: false }
  }

  // Cancelling never closes a transaction (ADR 0004) unless the statement cannot be interrupted; then the user is told.
  async function* stopAndReport(
    session: SqliteSession,
    requestId: RequestId,
    statementIndex: number,
  ): AsyncGenerator<QueryEvent, void> {
    const { transactionLost } = await stopWorker(session, requestId)
    if (transactionLost) {
      yield {
        type: 'notice',
        requestId,
        statementIndex,
        level: 'warning',
        message: TRANSACTION_LOST_MESSAGE,
        code: 'transaction_lost',
      }
    }
  }

  async function* execute(request: QueryRequest): AsyncGenerator<QueryEvent, void> {
    const { requestId } = request
    const rejected = (error: AdapterError): QueryEvent => ({
      type: 'error',
      requestId,
      error: error.normalized,
    })

    const session = sessions.get(request.sessionId)
    if (!session) {
      yield rejected(noSession())
      return
    }
    if (session.activeRun || runs.has(requestId)) {
      yield rejected(
        new AdapterError(
          createNormalizedError('busy', 'A query is already running on this session'),
        ),
      )
      return
    }

    const run: ActiveRun = { cancelRequested: false, cancelled: deferred<void>() }
    session.activeRun = run
    runs.set(requestId, run)
    const startedAt = performance.now()
    const deadline = request.timeoutMs === undefined ? undefined : startedAt + request.timeoutMs
    const client = session.client
    let statementIndex = 0
    let finished = false

    const timeoutEvent = (): QueryEvent => ({
      type: 'error',
      requestId,
      statementIndex,
      error: createNormalizedError(
        'timeout',
        `The query exceeded the time limit of ${request.timeoutMs} ms`,
      ),
    })

    try {
      await client.request({ op: 'open', request })
      for (;;) {
        if (run.cancelRequested) {
          yield* stopAndReport(session, requestId, statementIndex)
          finished = true
          yield { type: 'cancelled', requestId, statementIndex }
          return
        }
        const timer = deferred<'timeout'>()
        const handle =
          deadline === undefined
            ? undefined
            : setTimeout(() => timer.resolve('timeout'), Math.max(0, deadline - performance.now()))
        const pull = client.request<PullResult>({ op: 'pull', requestId })
        // The pull may still be in flight when the race is lost; its late reply (or rejection) is ignored.
        pull.catch(() => undefined)
        const outcome = await Promise.race([
          run.cancelled.promise.then(() => 'cancelled' as const),
          timer.promise,
          pull,
        ])
        if (handle) clearTimeout(handle)

        if (outcome === 'cancelled' || outcome === 'timeout') {
          yield* stopAndReport(session, requestId, statementIndex)
          finished = true
          yield outcome === 'cancelled'
            ? { type: 'cancelled', requestId, statementIndex }
            : timeoutEvent()
          return
        }
        if (outcome.done) {
          finished = true
          return
        }
        if (outcome.event.type === 'statement_done') {
          statementIndex++
        }
        yield outcome.event
      }
    } catch (error) {
      finished = true
      yield {
        type: 'error',
        requestId,
        statementIndex,
        error: normalizeUnknownError(error),
      }
    } finally {
      // The consumer stopped early: the worker must not keep producing for nobody.
      if (!finished && !client.isClosed) {
        await stopWorker(session, requestId)
      }
      session.activeRun = undefined
      runs.delete(requestId)
    }
  }

  return {
    engine: 'sqlite',
    capabilities: CAPABILITIES,

    async testConnection(profile: ResolvedConnectionProfile): Promise<TestConnectionResult> {
      // A short-lived worker keeps the driver out of the main thread even for a one-off open.
      const client = spawn()
      try {
        return await client.call<TestConnectionResult>('testConnection', profile)
      } catch (error) {
        return { ok: false, error: normalizeUnknownError(error) }
      } finally {
        client.terminate()
      }
    },

    async connect(profile: ResolvedConnectionProfile): Promise<Session> {
      const client = spawn()
      try {
        const session = await client.call<Session>('connect', profile)
        sessions.set(session.sessionId, {
          sessionId: session.sessionId,
          profile,
          client,
          activeRun: undefined,
        })
        return session
      } catch (error) {
        client.terminate()
        throw error instanceof AdapterError ? error : new AdapterError(normalizeUnknownError(error))
      }
    },

    async disconnect(sessionId: SessionId): Promise<void> {
      const session = sessions.get(sessionId)
      if (!session) return
      sessions.delete(sessionId)
      const { activeRun, client } = session
      if (activeRun) {
        activeRun.cancelRequested = true
        activeRun.cancelled.resolve()
      }
      const closing = client.call<void>('disconnect', sessionId).catch(() => undefined)
      const timer = deferred<void>()
      const handle = setTimeout(() => timer.resolve(), graceMs)
      await Promise.race([closing, timer.promise])
      clearTimeout(handle)
      client.terminate()
    },

    execute,

    cancel(requestId: RequestId): Promise<CancelResult> {
      const run = runs.get(requestId)
      if (!run) {
        return Promise.resolve({ requestId, outcome: 'not_running' })
      }
      run.cancelRequested = true
      run.cancelled.resolve()
      return Promise.resolve({ requestId, outcome: 'requested' })
    },

    listSchemas: (sessionId): Promise<SchemaInfo[]> => inSession(sessionId, 'listSchemas'),
    listTables: (sessionId, schema): Promise<TableInfo[]> =>
      inSession(sessionId, 'listTables', schema),
    describeTable: (sessionId, table: TableRef): Promise<TableDetails> =>
      inSession(sessionId, 'describeTable', table),

    begin: (sessionId): Promise<TransactionResult> => inSession(sessionId, 'begin'),
    commit: (sessionId): Promise<TransactionResult> => inSession(sessionId, 'commit'),
    rollback: (sessionId): Promise<TransactionResult> => inSession(sessionId, 'rollback'),

    transactionState(sessionId: SessionId): TransactionState {
      return requireSession(sessionId).client.transaction
    },
  }
}
