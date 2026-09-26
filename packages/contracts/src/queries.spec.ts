import { describe, expect, it } from 'vitest'
import {
  CancelRequestSchema,
  ChunkAckSchema,
  QueryRequestSchema,
  TransactionRequestSchema,
  TransactionResultSchema,
} from './queries'

const request = { requestId: 'r1', sessionId: 's1', sql: 'select 1' }

describe('QueryRequestSchema', () => {
  it('accepts a minimal and a full request', () => {
    expect(QueryRequestSchema.safeParse(request).success).toBe(true)
    expect(
      QueryRequestSchema.safeParse({ ...request, timeoutMs: 30_000, maxRows: 1000, chunkSize: 500 })
        .success,
    ).toBe(true)
  })

  it('rejects blank sql, bad limits and missing ids', () => {
    for (const patch of [
      { sql: '   ' },
      { sql: '' },
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { maxRows: -1 },
      { chunkSize: 0 },
      { requestId: '' },
      { sessionId: '' },
    ]) {
      expect(QueryRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false)
    }
  })

  it('accepts the optional saveToHistory opt-out and rejects a non-boolean', () => {
    expect(QueryRequestSchema.safeParse(request).success).toBe(true)
    expect(QueryRequestSchema.parse(request)).not.toHaveProperty('saveToHistory')
    for (const saveToHistory of [true, false]) {
      expect(QueryRequestSchema.parse({ ...request, saveToHistory }).saveToHistory).toBe(
        saveToHistory,
      )
    }
    for (const saveToHistory of ['no', 0, null]) {
      expect(QueryRequestSchema.safeParse({ ...request, saveToHistory }).success).toBe(false)
    }
  })

  it('accepts enforceReadOnly only as true: it can restrict a run, never relax it', () => {
    expect(QueryRequestSchema.parse({ ...request, enforceReadOnly: true }).enforceReadOnly).toBe(
      true,
    )
    expect(QueryRequestSchema.parse(request)).not.toHaveProperty('enforceReadOnly')
    for (const enforceReadOnly of [false, 'true', 1, null]) {
      expect(QueryRequestSchema.safeParse({ ...request, enforceReadOnly }).success).toBe(false)
    }
  })

  it('rejects unknown keys such as a client-supplied readOnly flag', () => {
    expect(QueryRequestSchema.safeParse({ ...request, readOnly: false }).success).toBe(false)
  })
})

describe('cancel, transactions and ack', () => {
  it('rejects unknown keys in every input schema', () => {
    expect(CancelRequestSchema.safeParse({ requestId: 'r1', extra: 1 }).success).toBe(false)
    expect(TransactionRequestSchema.safeParse({ sessionId: 's1', extra: 1 }).success).toBe(false)
    expect(
      ChunkAckSchema.safeParse({ requestId: 'r1', statementIndex: 0, chunkIndex: 0, extra: 1 })
        .success,
    ).toBe(false)
  })

  it('parses valid payloads', () => {
    expect(CancelRequestSchema.safeParse({ requestId: 'r1' }).success).toBe(true)
    expect(TransactionRequestSchema.safeParse({ sessionId: 's1' }).success).toBe(true)
    expect(
      TransactionResultSchema.safeParse({ sessionId: 's1', transaction: 'active' }).success,
    ).toBe(true)
    expect(
      ChunkAckSchema.safeParse({ requestId: 'r1', statementIndex: 2, chunkIndex: 0 }).success,
    ).toBe(true)
  })
})
