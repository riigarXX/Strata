import type { Engine } from '@strata/contracts'
import type { DatabaseAdapter } from './adapter'

export class AdapterAlreadyRegisteredError extends Error {
  readonly engine: Engine

  constructor(engine: Engine) {
    super(`A database adapter is already registered for engine "${engine}"`)
    this.name = 'AdapterAlreadyRegisteredError'
    this.engine = engine
  }
}

export class AdapterNotRegisteredError extends Error {
  readonly engine: Engine

  constructor(engine: Engine) {
    super(`No database adapter is registered for engine "${engine}"`)
    this.name = 'AdapterNotRegisteredError'
    this.engine = engine
  }
}

export class AdapterRegistry {
  readonly #adapters = new Map<Engine, DatabaseAdapter>()

  register(adapter: DatabaseAdapter): void {
    if (this.#adapters.has(adapter.engine)) {
      throw new AdapterAlreadyRegisteredError(adapter.engine)
    }
    this.#adapters.set(adapter.engine, adapter)
  }

  get(engine: Engine): DatabaseAdapter {
    const adapter = this.#adapters.get(engine)
    if (!adapter) {
      throw new AdapterNotRegisteredError(engine)
    }
    return adapter
  }

  has(engine: Engine): boolean {
    return this.#adapters.has(engine)
  }

  list(): DatabaseAdapter[] {
    return [...this.#adapters.values()]
  }
}
