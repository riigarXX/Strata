import type {
  CellValue,
  QueryEvent,
  RequestId,
  ResultColumn,
  TransactionState,
} from '@strata/contracts'
import type Database from 'better-sqlite3'
import { createNormalizedError, type RedactionContext } from '../normalization'
import { boundRow, ChunkBuffer } from '../result-limits'
import { toAdapterError } from './errors'
import { splitSqliteStatements, type SqlStatement } from './statement-splitter'
import { boundDriverValue, describeColumns, toCellValue } from './values'

const DEFAULT_CHUNK_SIZE = 500
const DML_COMMANDS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE'])

// Shared with the adapter so cancel and disconnect can reach a request that is suspended between chunks.
export interface ExecutionRun {
  cancelRequested: boolean
  closeCursor: (() => void) | undefined
}

export interface ExecutionInput {
  readonly requestId: RequestId
  readonly db: Database.Database
  readonly transactionState: () => TransactionState
  readonly run: ExecutionRun
  readonly sql: string
  readonly context: RedactionContext
  readonly timeoutMs?: number
  readonly maxRows?: number
  readonly chunkSize?: number
}

type StatementOutcome = 'completed' | 'cancelled' | 'timed_out'

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function isDml(statement: SqlStatement, returnsRows: boolean): boolean {
  return DML_COMMANDS.has(statement.command) || (statement.command === 'WITH' && !returnsRows)
}

// better-sqlite3 is synchronous: cancel and timeout are only observable while control is back on the event loop.
async function* runStatement(
  input: ExecutionInput,
  statement: SqlStatement,
  statementIndex: number,
  deadline: number | undefined,
): AsyncGenerator<QueryEvent, StatementOutcome> {
  const { requestId, db, run } = input
  const startedAt = performance.now()
  const stmt = db.prepare<[], unknown[]>(statement.text)

  if (!stmt.reader) {
    const { changes } = stmt.run()
    yield {
      type: 'statement_done',
      requestId,
      statementIndex,
      command: statement.command,
      rowsReturned: 0,
      rowsAffected: isDml(statement, false) ? changes : null,
      durationMs: performance.now() - startedAt,
      truncated: false,
    }
    return 'completed'
  }

  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE
  const driverColumns = stmt.columns().map(({ name, type }) => ({ name, type }))
  const iterator = stmt.raw().safeIntegers().iterate()
  run.closeCursor = () => {
    iterator.return?.()
  }

  let columns: ResultColumn[] | undefined
  const pending = new ChunkBuffer<unknown>(chunkSize)
  let chunkIndex = 0
  let rowsReturned = 0
  let truncated = false

  const takeChunk = (): QueryEvent => {
    const { rows: rawRows, truncated: truncatedCells } = pending.take()
    columns ??= describeColumns(driverColumns, rawRows)
    const resolved = columns
    const rows: CellValue[][] = rawRows.map((row) =>
      row.map((value, index) => toCellValue(value, resolved[index]?.kind ?? 'other')),
    )
    return {
      type: 'chunk',
      requestId,
      statementIndex,
      chunkIndex: chunkIndex++,
      columns: resolved,
      rows,
      ...(truncatedCells && { truncated: truncatedCells }),
    }
  }

  try {
    for (;;) {
      if (deadline !== undefined && performance.now() > deadline) {
        return 'timed_out'
      }
      const next = iterator.next()
      if (next.done) {
        break
      }
      if (input.maxRows !== undefined && rowsReturned >= input.maxRows) {
        truncated = true
        break
      }
      const row = boundRow(next.value, (value) => boundDriverValue(value))
      rowsReturned++

      if (!pending.accepts(row)) {
        yield takeChunk()
        await yieldToEventLoop()
        if (run.cancelRequested) {
          return 'cancelled'
        }
      }
      pending.push(row)

      if (pending.isFull) {
        yield takeChunk()
        await yieldToEventLoop()
        if (run.cancelRequested) {
          return 'cancelled'
        }
      }
    }
    if (pending.length > 0 || chunkIndex === 0) {
      yield takeChunk()
    }
  } finally {
    run.closeCursor = undefined
    iterator.return?.()
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

  // changes() reports the last completed write, so it is only meaningful for a full run of a statement that writes.
  const returnsRowsAndWrites = isDml(statement, true) && !truncated
  const changes = returnsRowsAndWrites ? Number(db.prepare('SELECT changes()').pluck().get()) : null

  yield {
    type: 'statement_done',
    requestId,
    statementIndex,
    command: statement.command,
    rowsReturned,
    rowsAffected: changes,
    durationMs: performance.now() - startedAt,
    truncated,
  }
  return 'completed'
}

// Failures and cancellation are terminal events, never exceptions (ADR 0010): a statement that fails stops the ones after it.
export async function* executeDocument(input: ExecutionInput): AsyncGenerator<QueryEvent, void> {
  const { requestId, run } = input
  const startedAt = performance.now()
  const deadline = input.timeoutMs === undefined ? undefined : startedAt + input.timeoutMs
  const statements = splitSqliteStatements(input.sql)
  let statementIndex = 0

  const timeoutEvent = (): QueryEvent => ({
    type: 'error',
    requestId,
    statementIndex,
    error: createNormalizedError(
      'timeout',
      `The query exceeded the time limit of ${input.timeoutMs} ms`,
    ),
  })

  try {
    for (const statement of statements) {
      if (run.cancelRequested) {
        yield { type: 'cancelled', requestId, statementIndex }
        return
      }
      if (deadline !== undefined && performance.now() > deadline) {
        yield timeoutEvent()
        return
      }

      const outcome = yield* runStatement(input, statement, statementIndex, deadline)
      if (outcome === 'cancelled') {
        yield { type: 'cancelled', requestId, statementIndex }
        return
      }
      if (outcome === 'timed_out') {
        yield timeoutEvent()
        return
      }

      statementIndex++
      await yieldToEventLoop()
    }

    yield {
      type: 'done',
      requestId,
      statementCount: statements.length,
      durationMs: performance.now() - startedAt,
      transaction: input.transactionState(),
    }
  } catch (error) {
    yield {
      type: 'error',
      requestId,
      statementIndex,
      error: toAdapterError(error, input.context).normalized,
    }
  }
}
