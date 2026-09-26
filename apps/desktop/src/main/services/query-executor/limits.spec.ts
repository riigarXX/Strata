// @vitest-environment node
import { QueryRequestSchema } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { QUERY_LIMITS, resolveQueryLimits } from './limits'

describe('resolveQueryLimits', () => {
  it('aplica los valores por defecto cuando la petición no pide nada', () => {
    expect(resolveQueryLimits({})).toEqual({ maxRows: 10_000, timeoutMs: 30_000, chunkSize: 500 })
  })

  it('respeta lo que pide el renderer mientras no supere el tope', () => {
    expect(resolveQueryLimits({ maxRows: 50, timeoutMs: 1_000, chunkSize: 10 })).toEqual({
      maxRows: 50,
      timeoutMs: 1_000,
      chunkSize: 10,
    })
  })

  it('recorta a los topes duros lo que el schema del contrato aún deja pasar', () => {
    const request = QueryRequestSchema.parse({
      requestId: 'r',
      sessionId: 's',
      sql: 'SELECT 1',
      maxRows: 10_000_000,
      timeoutMs: 3_600_000,
      chunkSize: 10_000,
    })
    expect(resolveQueryLimits(request)).toEqual({
      maxRows: QUERY_LIMITS.maxRows.max,
      timeoutMs: QUERY_LIMITS.timeoutMs.max,
      chunkSize: QUERY_LIMITS.chunkSize.max,
    })
    expect(QUERY_LIMITS.maxRows.max).toBe(100_000)
    expect(QUERY_LIMITS.timeoutMs.max).toBe(300_000)
    expect(QUERY_LIMITS.chunkSize.max).toBe(1_000)
  })

  it('mantiene los valores por defecto por debajo de los topes', () => {
    for (const key of ['maxRows', 'timeoutMs', 'chunkSize'] as const) {
      expect(QUERY_LIMITS[key].default).toBeLessThanOrEqual(QUERY_LIMITS[key].max)
    }
  })
})
