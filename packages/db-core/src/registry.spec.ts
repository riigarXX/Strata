import { describe, expect, it } from 'vitest'
import type { Engine } from '@strata/contracts'
import type { DatabaseAdapter } from './adapter'
import {
  AdapterAlreadyRegisteredError,
  AdapterNotRegisteredError,
  AdapterRegistry,
} from './registry'

function fakeAdapter(engine: Engine): DatabaseAdapter {
  return {
    engine,
    capabilities: {
      cancellation: true,
      schemas: engine === 'postgres',
      explain: false,
      transactions: true,
      readOnlyMode: true,
    },
    testConnection: () => Promise.reject(new Error('not implemented')),
    connect: () => Promise.reject(new Error('not implemented')),
    disconnect: () => Promise.resolve(),
    // eslint-disable-next-line require-yield
    execute: async function* () {
      return
    },
    cancel: (requestId) => Promise.resolve({ requestId, outcome: 'not_running' }),
    listSchemas: () => Promise.resolve([]),
    listTables: () => Promise.resolve([]),
    describeTable: () => Promise.reject(new Error('not implemented')),
    begin: (sessionId) => Promise.resolve({ sessionId, transaction: 'active' }),
    commit: (sessionId) => Promise.resolve({ sessionId, transaction: 'none' }),
    rollback: (sessionId) => Promise.resolve({ sessionId, transaction: 'none' }),
    transactionState: () => 'none',
  }
}

describe('AdapterRegistry', () => {
  it('returns a registered adapter by engine', () => {
    const registry = new AdapterRegistry()
    const postgres = fakeAdapter('postgres')

    registry.register(postgres)

    expect(registry.get('postgres')).toBe(postgres)
    expect(registry.has('postgres')).toBe(true)
    expect(registry.has('sqlite')).toBe(false)
  })

  it('rejects registering the same engine twice and keeps the first adapter', () => {
    const registry = new AdapterRegistry()
    const first = fakeAdapter('sqlite')
    registry.register(first)

    const attempt = () => registry.register(fakeAdapter('sqlite'))

    expect(attempt).toThrow(AdapterAlreadyRegisteredError)
    expect(attempt).toThrow(/already registered.*"sqlite"/)
    expect(registry.get('sqlite')).toBe(first)
  })

  it('throws a clear error for an engine with no adapter', () => {
    const registry = new AdapterRegistry()

    expect(() => registry.get('postgres')).toThrow(AdapterNotRegisteredError)
    expect(() => registry.get('postgres')).toThrow(/No database adapter.*"postgres"/)
  })

  it('lists registered adapters in registration order', () => {
    const registry = new AdapterRegistry()
    expect(registry.list()).toEqual([])

    const sqlite = fakeAdapter('sqlite')
    const postgres = fakeAdapter('postgres')
    registry.register(sqlite)
    registry.register(postgres)

    expect(registry.list()).toEqual([sqlite, postgres])
  })

  it('does not let callers mutate the registry through the listed array', () => {
    const registry = new AdapterRegistry()
    registry.register(fakeAdapter('sqlite'))

    registry.list().pop()

    expect(registry.list()).toHaveLength(1)
  })
})
