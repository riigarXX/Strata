import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ConnectionProfileInputSchema,
  ConnectionProfileListSchema,
  ConnectionProfileSchema,
  ConnectionStateSchema,
  SessionSchema,
  TestConnectionResultSchema,
} from './connections'
import { NormalizedErrorSchema } from './errors'
import { QueryEventSchema } from './events'
import { TableDetailsSchema } from './metadata'
import { CancelResultSchema, TransactionResultSchema } from './queries'

const SENSITIVE_KEY = /pass(word)?|secret(?!Ref$)|token|credential|connection_?string|dsn/i

function collectPropertyNames(node: unknown, names: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((item) => collectPropertyNames(item, names))
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        names.push(...Object.keys(value))
      }
      collectPropertyNames(value, names)
    }
  }
  return names
}

const outputSchemas = {
  ConnectionProfileSchema,
  ConnectionProfileListSchema,
  ConnectionStateSchema,
  SessionSchema,
  TestConnectionResultSchema,
  NormalizedErrorSchema,
  QueryEventSchema,
  TableDetailsSchema,
  CancelResultSchema,
  TransactionResultSchema,
}

describe('main -> renderer schemas', () => {
  for (const [name, schema] of Object.entries(outputSchemas)) {
    it(`${name} declares no password or secret-like property`, () => {
      const names = collectPropertyNames(z.toJSONSchema(schema))
      expect(names.length).toBeGreaterThan(0)
      expect(names.filter((key) => SENSITIVE_KEY.test(key))).toEqual([])
    })
  }

  it('NormalizedError exposes only code, message and retryable', () => {
    expect(Object.keys(NormalizedErrorSchema.shape).sort()).toEqual([
      'code',
      'message',
      'retryable',
    ])
  })
})

describe('write-only password', () => {
  it('is only declared by the postgres profile input schema', () => {
    const inputNames = collectPropertyNames(z.toJSONSchema(ConnectionProfileInputSchema))
    expect(inputNames.filter((key) => SENSITIVE_KEY.test(key))).toEqual(['password'])
  })
})
