import { describe, expect, it } from 'vitest'
import { canRunWhileAborted } from './aborted-transaction'

describe('canRunWhileAborted', () => {
  it.each([
    'ROLLBACK',
    'rollback;',
    'ROLLBACK TO SAVEPOINT sp1',
    'ROLLBACK TO sp1',
    'ABORT',
    'END',
    'COMMIT',
    '-- volver atrás\nRollback',
    '/* cierre */ ROLLBACK AND NO CHAIN',
  ])('accepts the closing statement %j', (sql) => {
    expect(canRunWhileAborted('postgres', sql)).toBe(true)
  })

  it.each([
    'SELECT 1',
    'INSERT INTO t VALUES (1)',
    'BEGIN',
    'START TRANSACTION',
    'SAVEPOINT sp1',
    'RELEASE SAVEPOINT sp1',
    'SET search_path = public',
    'ROLLBACK PREPARED foo',
    'COMMIT PREPARED foo',
    "SELECT 'rollback'",
    'WITH x AS (SELECT 1) SELECT * FROM x',
  ])('rejects %j', (sql) => {
    expect(canRunWhileAborted('postgres', sql)).toBe(false)
  })

  it('looks at the first statement only: after it the transaction is no longer aborted', () => {
    expect(canRunWhileAborted('postgres', 'ROLLBACK; SELECT 1')).toBe(true)
    expect(canRunWhileAborted('postgres', 'ROLLBACK TO sp1; INSERT INTO t VALUES (1)')).toBe(true)
    expect(canRunWhileAborted('postgres', 'SELECT 1; ROLLBACK')).toBe(false)
  })

  it('lets an empty text through: there is nothing to send', () => {
    expect(canRunWhileAborted('postgres', '')).toBe(true)
    expect(canRunWhileAborted('postgres', '  -- solo un comentario\n')).toBe(true)
  })
})
