import { parentPort, workerData } from 'node:worker_threads'
import type { QueryEvent, RequestId, SessionId } from '@strata/contracts'
import type { DatabaseAdapter } from '../adapter'
import { normalizeUnknownError } from '../normalization'
import { createSqliteEngine } from './engine'
import type {
  PullResult,
  SqliteWorkerData,
  WorkerCallMethod,
  WorkerReply,
  WorkerRequest,
} from './worker-protocol'

// Entry point of the worker thread: it owns exactly one session, so terminating the thread is how the main thread abandons a statement that cannot be interrupted.
const port = parentPort
if (!port) {
  throw new Error('worker.ts must run inside a worker thread')
}

const data = (workerData ?? {}) as SqliteWorkerData
const engine: DatabaseAdapter = createSqliteEngine({
  ...(data.minimumVersion !== undefined && { minimumVersion: data.minimumVersion }),
  ...(data.sessionId !== undefined && { newSessionId: () => data.sessionId as SessionId }),
})

let sessionId: SessionId | undefined
const streams = new Map<RequestId, AsyncIterator<QueryEvent>>()

function currentTransaction(): WorkerReply['transaction'] {
  if (!sessionId) return 'none'
  try {
    return engine.transactionState(sessionId)
  } catch {
    return 'none'
  }
}

async function call(method: WorkerCallMethod, args: readonly unknown[]): Promise<unknown> {
  // The arguments cross the thread boundary already validated by the main thread; the engine re-checks what it depends on.
  const invoke = engine[method] as (...values: unknown[]) => Promise<unknown>
  const value = await invoke.apply(engine, [...args])
  if (method === 'connect') {
    sessionId = (value as { sessionId: SessionId }).sessionId
  }
  return value
}

async function run(request: WorkerRequest): Promise<unknown> {
  switch (request.op) {
    case 'call':
      return call(request.method, request.args)
    case 'open':
      streams.set(
        request.request.requestId,
        engine.execute(request.request)[Symbol.asyncIterator](),
      )
      return undefined
    case 'pull': {
      const stream = streams.get(request.requestId)
      if (!stream) return { done: true } satisfies PullResult
      const next = await stream.next()
      if (next.done) {
        streams.delete(request.requestId)
        return { done: true } satisfies PullResult
      }
      return { done: false, event: next.value } satisfies PullResult
    }
    case 'abort': {
      const stream = streams.get(request.requestId)
      await engine.cancel(request.requestId)
      streams.delete(request.requestId)
      // Queued behind an in-flight step, which is what lets the main thread tell "stopped" from "stuck".
      await stream?.return?.()
      return undefined
    }
  }
}

port.on('message', (request: WorkerRequest) => {
  void run(request).then(
    (value) =>
      port.postMessage({
        id: request.id,
        ok: true,
        value,
        transaction: currentTransaction(),
      } satisfies WorkerReply),
    (error: unknown) =>
      port.postMessage({
        id: request.id,
        ok: false,
        error: normalizeUnknownError(error),
        transaction: currentTransaction(),
      } satisfies WorkerReply),
  )
})
