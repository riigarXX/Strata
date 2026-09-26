import { describe, expect, it } from 'vitest'
import {
  describeCleared,
  describeCount,
  formatAbsoluteDate,
  formatRelativeDate,
  previewSql,
} from './presentation'

describe('previewSql', () => {
  it('collapses whitespace and line breaks into a single line', () => {
    expect(previewSql('  select *\n  from   users\n')).toBe('select * from users')
  })

  it('cuts long text with an ellipsis and leaves short text alone', () => {
    expect(previewSql('select 1')).toBe('select 1')
    const cut = previewSql(`select ${'a'.repeat(500)}`)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(161)
  })

  it('only scans the start of a huge text and still marks it as cut', () => {
    const cut = previewSql('x'.repeat(20_000), 20)
    expect(cut).toBe(`${'x'.repeat(20)}…`)
  })
})

describe('formatRelativeDate', () => {
  const now = Date.parse('2026-09-20T12:00:00.000Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('speaks in minutes, hours and days, and never in the future', () => {
    expect(formatRelativeDate(ago(10_000), now)).toBe('hace un momento')
    expect(formatRelativeDate(ago(5 * 60_000), now)).toBe('hace 5 min')
    expect(formatRelativeDate(ago(3 * 3_600_000), now)).toBe('hace 3 h')
    expect(formatRelativeDate(ago(24 * 3_600_000), now)).toBe('hace 1 día')
    expect(formatRelativeDate(ago(3 * 24 * 3_600_000), now)).toBe('hace 3 días')
    expect(formatRelativeDate(ago(-5_000), now)).toBe('hace un momento')
  })

  it('gives up after a week: only the absolute date makes sense', () => {
    expect(formatRelativeDate(ago(8 * 24 * 3_600_000), now)).toBe('')
  })
})

describe('other labels', () => {
  it('formats an absolute date in Spanish', () => {
    expect(formatAbsoluteDate('2026-09-20T12:00:00.000Z')).toMatch(/2026/)
  })

  it('describes counts and clearing with the right plural', () => {
    expect(describeCount(1, false)).toBe('1 consulta')
    expect(describeCount(50, true)).toBe('50 consultas; hay más por cargar')
    expect(describeCleared(0)).toBe('El historial ya estaba vacío')
    expect(describeCleared(1)).toBe('Historial vaciado: 1 consulta eliminada')
    expect(describeCleared(3)).toBe('Historial vaciado: 3 consultas eliminadas')
  })
})
