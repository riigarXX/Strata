import type {
  CellValue,
  QueryEvent,
  RequestId,
  ResultColumn,
  TransactionState,
} from '@strata/contracts'
import type { Client, QueryResult } from 'pg'
import Cursor from 'pg-cursor'
import { createNormalizedError, redactSensitive } from '../normalization'
import { boundRow, ChunkBuffer, nextReadSize } from '../result-limits'
import { isCancellation, toAdapterError, type PostgresRedactionContext } from './errors'
import { splitPostgresStatements, type SqlStatement } from './statement-splitter'
import { describeColumns, toBoundedCell, unresolvedTypeOids } from './values'

const DEFAULT_CHUNK_SIZE = 500
const MAX_NOTICE_LENGTH = 2000
const MAX_COMMAND_LENGTH = 64
const AFFECTED_ROWS_COMMANDS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'COPY',
])
// The extended protocol used for cursors has no way to carry a COPY stream, so it is refused up front instead of hanging.
const COPY_TO_CLIENT = /^\s*COPY\b[\s\S]*\b(?:FROM\s+STDIN|TO\s+STDOUT)\b/i

// Every column is read as text and converted in values.ts, so the driver's own parsers are bypassed.
const TEXT_TYPES = { getTypeParser: () => (value: string) => value }

export interface ServerNotice {
  readonly severity?: string
  readonly code?: string
  readonly message?: string
}

// Shared with the adapter so cancel, timeout and disconnect can reach a request that is suspended between chunks.
export interface ExecutionRun {
  cancelRequested: boolean
  timedOut: boolean
  // True only while a Execute is in flight at the server: that is the only moment a cancel signal has something to interrupt.
  reading: boolean
  readonly notices: ServerNotice[]
  readonly signals: Set<Promise<void>>
}

export function createExecutionRun(): ExecutionRun {
  return {
    cancelRequested: false,
    timedOut: false,
    reading: false,
    notices: [],
    signals: new Set(),
  }
}

// The signal goes through a second connection (pg_cancel_backend); a failure to send it leaves cancellation cooperative.
export function interruptRun(run: ExecutionRun, signalBackend: () => Promise<void>): Promise<void> {
  if (!run.reading) {
    return Promise.resolve()
  }
  const signal = signalBackend().catch(() => undefined)
  run.signals.add(signal)
  void signal.finally(() => run.signals.delete(signal))
  return signal
}

export interface ExecutionInput {
  readonly requestId: RequestId
  readonly client: Client
  // Read once the last statement has finished: pg refreshes it on every ReadyForQuery.
  readonly transactionState: () => TransactionState
  readonly run: ExecutionRun
  readonly sql: string
  readonly context: PostgresRedactionContext
  readonly timeoutMs?: number
  readonly maxRows?: number
  readonly chunkSize?: number
  readonly signalBackend: () => Promise<void>
  // Fills `typeNames` with the pg_type name of each OID that is not a built-in.
  readonly typeNames: Map<number, string>
  readonly resolveTypeNames: (oids: number[]) => Promise<void>
}

type Interruption = 'cancelled' | 'timed_out'
type StatementOutcome = 'completed' | Interruption

interface ReadBatch {
  readonly rows: (string | null)[][]
  readonly result: QueryResult
}

function readBatch(cursor: Cursor<(string | null)[]>, size: number): Promise<ReadBatch> {
  return new Promise((resolve, reject) => {
    cursor.read(size, (error, rows, result) => {
      if (error) reject(error)
      else resolve({ rows, result })
    })
  })
}

function* drainNotices(input: ExecutionInput, statementIndex: number): Generator<QueryEvent> {
  const { requestId, run, context } = input
  for (const notice of run.notices.splice(0)) {
    const isWarning = notice.severity === 'WARNING' || notice.code?.startsWith('01') === true
    yield {
      type: 'notice',
      requestId,
      statementIndex,
      level: isWarning ? 'warning' : 'info',
      message: redactSensitive(notice.message ?? '', context).slice(0, MAX_NOTICE_LENGTH),
    }
  }
}

function interrupted(input: ExecutionInput): Interruption | undefined {
  if (input.run.cancelRequested) return 'cancelled'
  if (input.run.timedOut) return 'timed_out'
  return undefined
}

async function* runStatement(
  input: ExecutionInput,
  statement: SqlStatement,
  statementIndex: number,
): AsyncGenerator<QueryEvent, StatementOutcome> {
  const { requestId, client, run } = input
  const startedAt = performance.now()
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE

  const cursor = client.query(
    new Cursor<(string | null)[]>(statement.text, undefined, {
      rowMode: 'array',
      types: TEXT_TYPES,
    }),
  )
  // Until the server reports the end of the result the portal stays open and must be closed explicitly.
  let portalOpen = true
  let columns: ResultColumn[] | undefined
  let typeOids: number[] = []
  let chunkIndex = 0
  let rowsReturned = 0
  let truncated: boolean
  let tag: QueryResult | undefined
  let largestRawRow: number | undefined
  const pending = new ChunkBuffer<CellValue>(chunkSize)

  const takeChunk = (columnsOfChunk: ResultColumn[]): QueryEvent => {
    const { rows, truncated: truncatedCells } = pending.take()
    return {
      type: 'chunk',
      requestId,
      statementIndex,
      chunkIndex: chunkIndex++,
      columns: columnsOfChunk,
      rows,
      ...(truncatedCells && { truncated: truncatedCells }),
    }
  }

  try {
    for (;;) {
      const outcome = interrupted(input)
      if (outcome) return outcome

      // One row more than allowed is requested to learn whether the result was cut short.
      const limit = input.maxRows === undefined ? Infinity : input.maxRows - rowsReturned
      const size = Math.min(nextReadSize(chunkSize - pending.length, largestRawRow), limit + 1)

      run.reading = true
      let batch: ReadBatch
      try {
        batch = await readBatch(cursor, size)
      } catch (error) {
        portalOpen = false
        throw error
      } finally {
        run.reading = false
      }

      const finished = batch.rows.length < size
      if (finished) {
        portalOpen = false
        tag = batch.result
      }
      const rows = batch.rows.length > limit ? batch.rows.slice(0, limit) : batch.rows
      truncated = batch.rows.length > limit
      const fields = batch.result.fields

      if (columns === undefined && (rows.length > 0 || fields.length > 0)) {
        const missing = unresolvedTypeOids(fields, input.typeNames)
        if (missing.length > 0) {
          await input.resolveTypeNames(missing)
        }
        columns = describeColumns(fields, input.typeNames)
        typeOids = fields.map((field) => field.dataTypeID)
      }

      const chunkColumns = columns
      largestRawRow = 0
      // Rows only arrive together with their columns, so this guard just narrows the type.
      if (chunkColumns !== undefined) {
        for (const raw of rows) {
          let rawBytes = 0
          const row = boundRow(raw, (value, column) => {
            rawBytes += value?.length ?? 0
            return toBoundedCell(value, typeOids[column] ?? 0)
          })
          largestRawRow = Math.max(largestRawRow, rawBytes)

          if (!pending.accepts(row)) {
            yield takeChunk(chunkColumns)
          }
          pending.push(row)
          if (pending.isFull) {
            yield takeChunk(chunkColumns)
          }
        }
      }
      rowsReturned += rows.length

      const ended = finished || truncated
      if (ended && chunkColumns !== undefined && (pending.length > 0 || chunkIndex === 0)) {
        yield takeChunk(chunkColumns)
      }
      yield* drainNotices(input, statementIndex)

      if (ended) break
    }
  } finally {
    if (portalOpen) {
      await cursor.close().catch(() => undefined)
    }
  }

  if (truncated) {
    yield {
      type: 'notice',
      requestId,
      statementIndex,
      level: 'warning',
      message: `The result was limited to ${rowsReturned} rows`,
    }
  }

  const returnedRows = columns !== undefined
  // CREATE TABLE AS and SELECT INTO report a "SELECT n" tag although they return no rows: the statement's own keyword is clearer.
  const tagCommand = tag?.command ?? undefined
  const command =
    tagCommand === undefined || (tagCommand === 'SELECT' && !returnedRows)
      ? statement.command
      : tagCommand
  // For a statement that returns rows the server's tag counts only the rows of the last read, so the rows streamed are the exact count (RETURNING yields one per affected row).
  const rowCount = returnedRows ? rowsReturned : (tag?.rowCount ?? null)
  const affects =
    rowCount !== null &&
    !truncated &&
    (AFFECTED_ROWS_COMMANDS.has(command) || (tagCommand === 'SELECT' && !returnedRows))

  yield {
    type: 'statement_done',
    requestId,
    statementIndex,
    command: command.slice(0, MAX_COMMAND_LENGTH),
    rowsReturned,
    rowsAffected: affects ? rowCount : null,
    durationMs: performance.now() - startedAt,
    truncated,
  }
  return 'completed'
}

// pg only learns the transaction status when the server sends ReadyForQuery, which after an error or a cancel arrives later than the rejection.
// An empty query waits for that message and is legal even inside an aborted transaction.
export async function awaitReadyForQuery(client: Client): Promise<void> {
  try {
    await client.query('')
  } catch {
    // A dead connection has no state left to synchronize.
  }
}

// Failures and cancellation are terminal events, never exceptions (ADR 0010): a statement that fails stops the ones after it.
export async function* executeDocument(input: ExecutionInput): AsyncGenerator<QueryEvent, void> {
  const { requestId, run, client } = input
  const startedAt = performance.now()
  const statements = splitPostgresStatements(input.sql)
  let statementIndex = 0

  const timer =
    input.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          run.timedOut = true
          void interruptRun(run, input.signalBackend)
        }, input.timeoutMs)

  const timeoutEvent = (): QueryEvent => ({
    type: 'error',
    requestId,
    statementIndex,
    error: createNormalizedError(
      'timeout',
      `The query exceeded the time limit of ${input.timeoutMs} ms`,
    ),
  })
  const finalEvent = (outcome: Interruption): QueryEvent =>
    outcome === 'cancelled' ? { type: 'cancelled', requestId, statementIndex } : timeoutEvent()

  try {
    for (const statement of statements) {
      const before = interrupted(input)
      if (before) {
        yield finalEvent(before)
        return
      }
      if (COPY_TO_CLIENT.test(statement.text)) {
        yield {
          type: 'error',
          requestId,
          statementIndex,
          error: createNormalizedError(
            'validation_failed',
            'COPY to or from the client is not supported',
          ),
        }
        return
      }

      const outcome = yield* runStatement(input, statement, statementIndex)
      if (outcome !== 'completed') {
        // The cancel signal may still be travelling; it has to land before the session is handed back.
        await Promise.allSettled([...run.signals])
        await awaitReadyForQuery(client)
        yield finalEvent(outcome)
        return
      }
      statementIndex++
    }

    yield {
      type: 'done',
      requestId,
      statementCount: statements.length,
      durationMs: performance.now() - startedAt,
      transaction: input.transactionState(),
    }
  } catch (error) {
    await Promise.allSettled([...run.signals])
    await awaitReadyForQuery(client)
    yield* drainNotices(input, statementIndex)

    // Once a cancel was requested, whatever failed next (57014, or the dropped connection of a disconnect) is its consequence.
    if (run.cancelRequested) {
      yield { type: 'cancelled', requestId, statementIndex }
    } else if (run.timedOut && isCancellation(error)) {
      yield timeoutEvent()
    } else {
      const normalized = toAdapterError(error, input.context).normalized
      // A 57014 nobody asked for (another session's pg_cancel_backend) is still a cancellation.
      yield normalized.code === 'cancelled'
        ? { type: 'cancelled', requestId, statementIndex }
        : { type: 'error', requestId, statementIndex, error: normalized }
    }
  } finally {
    clearTimeout(timer)
    await Promise.allSettled([...run.signals])
  }
}
