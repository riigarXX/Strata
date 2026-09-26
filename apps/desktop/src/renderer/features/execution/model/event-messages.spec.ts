import { describe, expect, it } from 'vitest'
import {
  describeCancelled,
  describeDone,
  describeError,
  describeNotice,
  describeStatementDone,
  describeTruncation,
} from './event-messages'

const statementDone = (overrides: Record<string, unknown> = {}) => ({
  type: 'statement_done' as const,
  requestId: 'r1',
  statementIndex: 1,
  command: 'SELECT',
  rowsReturned: 500,
  rowsAffected: null,
  durationMs: 12.3,
  truncated: false,
  ...overrides,
})

describe('event messages', () => {
  it('describes a statement with its number, command, rows and duration', () => {
    expect(describeStatementDone(statementDone())).toBe(
      'Sentencia n.º 2 · SELECT · 500 filas · 12 ms',
    )
  })

  it('describes affected rows and statements without rows', () => {
    expect(
      describeStatementDone(statementDone({ command: 'INSERT', rowsReturned: 0, rowsAffected: 3 })),
    ).toContain('3 filas afectadas')
    expect(describeStatementDone(statementDone({ rowsReturned: 0, rowsAffected: 1 }))).toContain(
      '1 fila afectada',
    )
    expect(describeStatementDone(statementDone({ command: 'CREATE', rowsReturned: 0 }))).toContain(
      'sin filas',
    )
  })

  it('explains truncation, and the effective limit when it is below the requested one', () => {
    const event = statementDone({ rowsReturned: 100, truncated: true })
    expect(describeTruncation(event, 100)).toContain('el máximo configurado')
    expect(describeTruncation(event, 5000)).toContain('tope inferior')
  })

  it('formats notices, completion, errors and cancellations with the normalized text', () => {
    expect(
      describeNotice({
        type: 'notice',
        requestId: 'r',
        statementIndex: 0,
        level: 'info',
        message: 'hola',
      }),
    ).toBe('Aviso de la sentencia n.º 1: hola')
    expect(
      describeNotice({
        type: 'notice',
        requestId: 'r',
        statementIndex: 0,
        level: 'warning',
        message: 'The statement could not be interrupted: the transaction was rolled back',
        code: 'transaction_lost',
      }),
    ).toBe(
      'Aviso de la sentencia n.º 1: La sentencia no se pudo interrumpir: se ha revertido la transacción.',
    )
    expect(
      describeDone({
        type: 'done',
        requestId: 'r',
        statementCount: 2,
        durationMs: 1500,
        transaction: 'none',
      }),
    ).toBe('Ejecución completada: 2 sentencias en 1,50 s.')
    const error = {
      code: 'syntax_error' as const,
      message: 'near "selec": syntax error',
      retryable: false,
    }
    expect(describeError({ type: 'error', requestId: 'r', statementIndex: 0, error })).toBe(
      'Error en la sentencia n.º 1: near "selec": syntax error',
    )
    expect(describeError({ type: 'error', requestId: 'r', error })).toBe(
      'Error: near "selec": syntax error',
    )
    expect(describeCancelled({ type: 'cancelled', requestId: 'r' })).toBe('Ejecución cancelada.')
  })
})
