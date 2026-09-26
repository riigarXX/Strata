import type { CellValue, NormalizedError, QueryEvent, TransactionState } from '@strata/contracts'

export const COLUMNS = [
  { name: 'id', dataType: 'integer', kind: 'number' as const },
  { name: 'name', dataType: 'text', kind: 'text' as const },
]

export function rowsOf(from: number, count: number): CellValue[][] {
  return Array.from({ length: count }, (_, offset) => [from + offset, `name-${from + offset}`])
}

export const chunk = (
  requestId: string,
  rows: CellValue[][],
  chunkIndex = 0,
  statementIndex = 0,
): QueryEvent => ({ type: 'chunk', requestId, statementIndex, chunkIndex, columns: COLUMNS, rows })

export const statementDone = (
  requestId: string,
  overrides: Partial<Extract<QueryEvent, { type: 'statement_done' }>> = {},
): QueryEvent => ({
  type: 'statement_done',
  requestId,
  statementIndex: 0,
  command: 'SELECT',
  rowsReturned: 0,
  rowsAffected: null,
  durationMs: 5,
  truncated: false,
  ...overrides,
})

export const done = (
  requestId: string,
  transaction: TransactionState = 'none',
  durationMs = 42,
): QueryEvent => ({ type: 'done', requestId, statementCount: 1, durationMs, transaction })

export const failed = (
  requestId: string,
  error: Partial<NormalizedError> = {},
  transaction?: TransactionState,
): QueryEvent => ({
  type: 'error',
  requestId,
  statementIndex: 0,
  error: { code: 'syntax_error', message: 'syntax error near "selec"', retryable: false, ...error },
  ...(transaction === undefined ? {} : { transaction }),
})

export const cancelled = (requestId: string, transaction?: TransactionState): QueryEvent => ({
  type: 'cancelled',
  requestId,
  ...(transaction === undefined ? {} : { transaction }),
})
