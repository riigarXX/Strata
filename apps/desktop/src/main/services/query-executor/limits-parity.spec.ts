import { EXECUTION_PREFERENCE_LIMITS } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { QUERY_LIMITS } from './limits'

describe('límites de las preferencias de ejecución', () => {
  it('coinciden con los topes que main aplica a cada ejecución', () => {
    expect(EXECUTION_PREFERENCE_LIMITS.timeoutSeconds.max * 1000).toBe(QUERY_LIMITS.timeoutMs.max)
    expect(EXECUTION_PREFERENCE_LIMITS.timeoutSeconds.default * 1000).toBe(
      QUERY_LIMITS.timeoutMs.default,
    )
    expect(EXECUTION_PREFERENCE_LIMITS.maxRows.max).toBe(QUERY_LIMITS.maxRows.max)
    expect(EXECUTION_PREFERENCE_LIMITS.maxRows.default).toBe(QUERY_LIMITS.maxRows.default)
  })
})
