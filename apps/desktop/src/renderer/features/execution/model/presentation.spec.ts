import { describe, expect, it } from 'vitest'
import {
  ABORTED_RUN_REJECTION,
  describeRejection,
  describeTransaction,
  formatDuration,
  formatRows,
  formatRowsAs,
  splitExecutionStatus,
  transactionHint,
} from './presentation'

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [12.4, '12 ms'],
    [999, '999 ms'],
    [1234, '1,23 s'],
    [59_990, '59,99 s'],
    [125_000, '2 min 5 s'],
  ])('%d ms is %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe('formatRows', () => {
  it('pluralises and groups thousands', () => {
    expect(formatRows(1)).toBe('1 fila')
    expect(formatRows(0)).toBe('0 filas')
    expect(formatRows(10_000)).toContain('filas')
  })
})

describe('formatRowsAs', () => {
  it('agrees the participle with the count', () => {
    expect(formatRowsAs(1, 'recibida', 'recibidas')).toBe('1 fila recibida')
    expect(formatRowsAs(3, 'recibida', 'recibidas')).toBe('3 filas recibidas')
  })
})

describe('describeRejection', () => {
  const error = (
    code: Parameters<typeof describeRejection>[0]['code'],
    message = 'raw message',
  ) => ({
    code,
    message,
    retryable: false,
  })

  it('explains busy and no_session in Spanish', () => {
    expect(describeRejection(error('busy'))).toContain('sesión está ocupada')
    expect(describeRejection(error('no_session'))).toContain('sesión ya no está abierta')
  })

  it('keeps the normalized message of a read-only rejection untouched', () => {
    const text = describeRejection(error('read_only_violation', 'Only read statements are allowed'))
    expect(text).toContain('solo lectura')
    expect(text).toContain('Only read statements are allowed')
  })

  it('falls back to the normalized message', () => {
    expect(describeRejection(error('validation_failed', 'bad input'))).toBe('bad input')
  })
})

describe('transactionHint', () => {
  it('only warns when the transaction is aborted, and says what can still be run', () => {
    expect(transactionHint('aborted')).toBe(
      'Transacción abortada: solo puedes ejecutar ROLLBACK o pulsar «Revertir».',
    )
    expect(transactionHint('active')).toBeNull()
    expect(transactionHint(null)).toBeNull()
  })
})

describe('ABORTED_RUN_REJECTION', () => {
  it('names the only thing that runs and the alternative button', () => {
    expect(ABORTED_RUN_REJECTION).toContain('ROLLBACK')
    expect(ABORTED_RUN_REJECTION).toContain('«Revertir»')
  })
})

describe('describeTransaction', () => {
  it.each([
    ['none', 'Sin transacción'],
    ['active', 'Transacción activa'],
    ['aborted', 'Transacción abortada'],
  ] as const)('spells out the %s state as text', (state, label) => {
    const indicator = describeTransaction(state)!
    expect(indicator.state).toBe(state)
    expect(indicator.lead + indicator.detail).toBe(label)
  })

  it('keeps a visible word for the states that need attention when the lead is dropped', () => {
    expect(describeTransaction('active')!.detail).toBe('activa')
    expect(describeTransaction('aborted')!.detail).toBe('abortada')
  })

  it('has nothing to show without a session', () => {
    expect(describeTransaction(null)).toBeNull()
  })
})

describe('splitExecutionStatus', () => {
  it.each([
    ['Última ejecución completada (3 ms).', 'Última ejecución ', 'completada (3 ms).'],
    [
      'La última ejecución terminó con error (1,20 s).',
      'La última ejecución ',
      'terminó con error (1,20 s).',
    ],
    ['La última ejecución se canceló.', 'La última ejecución ', 'se canceló.'],
  ])('drops the prefix of «%s» without losing text', (text, lead, rest) => {
    expect(splitExecutionStatus(text)).toEqual({ lead, rest })
  })

  it.each([
    'Listo para ejecutar.',
    'Ejecutando la consulta…',
    'Sin conexión: no se puede ejecutar.',
    'No se puede operar con la transacción: No hay ninguna transacción activa.',
    'Última ejecución',
  ])('leaves «%s» as it is', (text) => {
    expect(splitExecutionStatus(text)).toEqual({ lead: '', rest: text })
  })
})
