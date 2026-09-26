import type {
  NormalizedError,
  QueryEvent,
  QueryRequest,
  RequestId,
  SessionId,
  TransactionState,
} from '@strata/contracts'

export interface SqliteWorkerData {
  readonly minimumVersion?: string
  // Set when a worker replaces one that had to be terminated: the session keeps the id the caller already holds.
  readonly sessionId?: SessionId
}

export type WorkerCallMethod =
  | 'testConnection'
  | 'connect'
  | 'disconnect'
  | 'listSchemas'
  | 'listTables'
  | 'describeTable'
  | 'begin'
  | 'commit'
  | 'rollback'

// One request, one reply, matched by id. A query is a stream driven by the main thread: `open` creates it, each `pull` asks for the next event (so the worker never runs ahead of the consumer), and `abort` cancels and closes it.
export type WorkerRequest =
  | {
      readonly id: number
      readonly op: 'call'
      readonly method: WorkerCallMethod
      readonly args: readonly unknown[]
    }
  | { readonly id: number; readonly op: 'open'; readonly request: QueryRequest }
  | { readonly id: number; readonly op: 'pull'; readonly requestId: RequestId }
  | { readonly id: number; readonly op: 'abort'; readonly requestId: RequestId }

export type PullResult =
  { readonly done: true } | { readonly done: false; readonly event: QueryEvent }

// `transaction` rides on every reply so the synchronous transactionState() of the adapter never needs a round trip.
export type WorkerReply =
  | {
      readonly id: number
      readonly ok: true
      readonly value: unknown
      readonly transaction: TransactionState
    }
  | {
      readonly id: number
      readonly ok: false
      readonly error: NormalizedError
      readonly transaction: TransactionState
    }
