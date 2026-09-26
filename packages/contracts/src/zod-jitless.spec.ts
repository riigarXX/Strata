import { afterEach, describe, expect, it, vi } from 'vitest'

const originalFunction = globalThis.Function

afterEach(() => {
  globalThis.Function = originalFunction
  vi.resetModules()
})

/** Cuenta las evaluaciones de código que Zod haría (la sonda `new Function("")` y el parser compilado). */
function watchCodeGeneration(): () => number {
  let count = 0
  globalThis.Function = new Proxy(originalFunction, {
    construct(target, args: unknown[], newTarget) {
      const body = String(args.at(-1) ?? '')
      if (body === '' || body.includes('payload')) count += 1
      return Reflect.construct(target, args, newTarget) as object
    },
  })
  return () => count
}

async function importContractsAndParse(): Promise<void> {
  const { QueryEventSchema } = await import('./events')
  QueryEventSchema.parse({
    type: 'done',
    requestId: 'r1',
    statementCount: 1,
    durationMs: 1,
    transaction: 'none',
  })
}

describe('zod-jitless', () => {
  it('sin la configuración, Zod genera código con `new Function` (la violación de CSP que se evita)', async () => {
    vi.resetModules()
    const generated = watchCodeGeneration()

    await importContractsAndParse()

    expect(generated()).toBeGreaterThan(0)
  })

  it('importado antes que los schemas, no se genera código ni al construirlos ni al validar', async () => {
    vi.resetModules()
    const generated = watchCodeGeneration()

    await import('./zod-jitless')
    await importContractsAndParse()

    expect(generated()).toBe(0)
  })
})
