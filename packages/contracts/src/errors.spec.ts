import { describe, expect, it } from 'vitest'
import { ERROR_CODES, ErrorCodeSchema, NormalizedErrorSchema } from './errors'

describe('error codes', () => {
  it('include the object, constraint and contention failures', () => {
    for (const code of ['not_found', 'constraint_violation', 'busy']) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true)
      expect(
        NormalizedErrorSchema.safeParse({ code, message: 'x', retryable: false }).success,
      ).toBe(true)
    }
  })

  it('include the AI assistant code for a question the schema cannot answer', () => {
    expect(ErrorCodeSchema.safeParse('cannot_answer').success).toBe(true)
  })

  it('include the code for a session whose transaction is aborted', () => {
    expect(ErrorCodeSchema.safeParse('transaction_aborted').success).toBe(true)
  })

  it('has no duplicates and rejects driver-specific codes', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
    expect(ErrorCodeSchema.safeParse('SQLITE_BUSY').success).toBe(false)
  })
})
