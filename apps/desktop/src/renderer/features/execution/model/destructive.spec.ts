import { describe, expect, it } from 'vitest'
import { describeDestructive, findDestructiveStatements } from './destructive'

describe('findDestructiveStatements', () => {
  it('lists only the destructive statements of a script, per engine', () => {
    const sql =
      'SELECT 1; DROP TABLE users; DELETE FROM t; DELETE FROM t WHERE id = 1; UPDATE t SET a = 1;'
    for (const engine of ['sqlite', 'postgres'] as const) {
      const found = findDestructiveStatements(engine, sql)
      expect(found.map((statement) => statement.command)).toEqual(['DROP', 'DELETE', 'UPDATE'])
    }
  })

  it('finds nothing in plain reads and safe writes', () => {
    expect(
      findDestructiveStatements('sqlite', "SELECT 'drop table x'; INSERT INTO t VALUES (1)"),
    ).toEqual([])
  })

  it('has a reason for each kind of destructive command', () => {
    expect(describeDestructive({ command: 'DROP' })).toContain('Elimina')
    expect(describeDestructive({ command: 'TRUNCATE' })).toContain('Vacía')
    expect(describeDestructive({ command: 'OTHER' })).toContain('Puede')
  })
})
