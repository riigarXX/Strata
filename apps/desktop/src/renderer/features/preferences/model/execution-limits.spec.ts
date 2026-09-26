import { describe, expect, it } from 'vitest'
import { clampLimit, EXECUTION_LIMITS, parseLimit } from './execution-limits'

describe('parseLimit', () => {
  it('accepts integers inside the range, with surrounding whitespace', () => {
    expect(parseLimit('timeoutSeconds', ' 45 ')).toEqual({ ok: true, value: 45 })
    expect(parseLimit('maxRows', '100000')).toEqual({ ok: true, value: 100_000 })
    expect(parseLimit('maxRows', '1')).toEqual({ ok: true, value: 1 })
  })

  it.each(['', '0', '301', '-5', '1.5', '1e3', 'abc', '30 s', '9999999999'])(
    'rejects %j for the timeout with a range message',
    (raw) => {
      const result = parseLimit('timeoutSeconds', raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('entre 1 y 300')
    },
  )

  it('rejects rows above the hard cap', () => {
    expect(parseLimit('maxRows', '100001').ok).toBe(false)
  })
})

describe('clampLimit', () => {
  it('clamps to the range, truncates and falls back to the default for non-finite values', () => {
    expect(clampLimit('timeoutSeconds', 9_999)).toBe(300)
    expect(clampLimit('timeoutSeconds', -2)).toBe(1)
    expect(clampLimit('maxRows', 12.9)).toBe(12)
    expect(clampLimit('maxRows', Number.NaN)).toBe(EXECUTION_LIMITS.maxRows.default)
  })
})
