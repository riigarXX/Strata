// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createHistoryStore } from './history-store'
import { DAY_MS, entryAt, HISTORY_PATH, NOW, setupHistory } from './testing'

async function seedAges(
  ctx: ReturnType<typeof setupHistory>,
  ages: readonly number[],
): Promise<void> {
  // Se siembra el archivo directamente: `add` ya purga por retención y no dejaría entradas viejas.
  ctx.memory.files.set(
    HISTORY_PATH,
    JSON.stringify({
      version: 1,
      entries: ages.map((days, index) => ({
        ...entryAt(NOW - days * DAY_MS, { sql: `age-${days}d` }),
        id: `seed-${index}`,
      })),
    }),
  )
}

const remaining = async (ctx: ReturnType<typeof setupHistory>) =>
  (await ctx.store.list({ limit: 200 })).entries.map(({ sql }) => sql)

describe('HistoryStore: purga por retención (ADR 0005)', () => {
  it.each([
    [7, ['age-1d', 'age-6d']],
    [30, ['age-1d', 'age-6d', 'age-8d', 'age-29d']],
    [90, ['age-1d', 'age-6d', 'age-8d', 'age-29d', 'age-31d', 'age-89d']],
    [null, ['age-1d', 'age-6d', 'age-8d', 'age-29d', 'age-31d', 'age-89d', 'age-91d', 'age-4000d']],
  ] as const)(
    'con retención de %s días conserva solo lo que cae dentro',
    async (days, expected) => {
      const ctx = setupHistory({ retentionDays: days })
      await seedAges(ctx, [1, 6, 8, 29, 31, 89, 91, 4000])

      await ctx.store.purge()

      expect(await remaining(ctx)).toEqual(expected)
    },
  )

  it('el límite es exacto: una entrada de justo 30 días se conserva y de 30 días y 1 ms se purga', async () => {
    const ctx = setupHistory({ retentionDays: 30 })
    ctx.memory.files.set(
      HISTORY_PATH,
      JSON.stringify({
        version: 1,
        entries: [
          { ...entryAt(NOW - 30 * DAY_MS, { sql: 'edge' }), id: 'edge' },
          { ...entryAt(NOW - 30 * DAY_MS - 1, { sql: 'over' }), id: 'over' },
        ],
      }),
    )

    expect(await ctx.store.purge()).toBe(1)
    expect(await remaining(ctx)).toEqual(['edge'])
  })

  it('devuelve cuántas entradas purgó y persiste el resultado', async () => {
    const ctx = setupHistory({ retentionDays: 7 })
    await seedAges(ctx, [1, 10, 20])

    expect(await ctx.store.purge()).toBe(2)
    expect(ctx.stored().entries).toHaveLength(1)
    expect(await ctx.store.purge()).toBe(0)
  })

  it('no reescribe el archivo si no hay nada que purgar', async () => {
    const ctx = setupHistory({ retentionDays: 30 })
    await seedAges(ctx, [1, 2])
    const before = ctx.memory.files.get(HISTORY_PATH)
    ctx.memory.hooks.failWrite = true

    expect(await ctx.store.purge()).toBe(0)
    expect(ctx.memory.files.get(HISTORY_PATH)).toBe(before)
  })

  it('cambiar la retención purga de inmediato con la nueva política', async () => {
    const ctx = setupHistory({ retentionDays: 90 })
    await seedAges(ctx, [1, 10, 40, 80])
    await ctx.store.purge()
    expect(await remaining(ctx)).toHaveLength(4)

    ctx.retention.days = 7
    await ctx.store.purge()

    expect(await remaining(ctx)).toEqual(['age-1d'])
  })

  it('pasar a ilimitado deja de purgar', async () => {
    const ctx = setupHistory({ retentionDays: 7 })
    await seedAges(ctx, [1, 100])
    ctx.retention.days = null

    await ctx.store.purge()

    expect(await remaining(ctx)).toEqual(['age-1d', 'age-100d'])
  })

  it('cada alta purga también lo caducado, en la misma escritura', async () => {
    const ctx = setupHistory({ retentionDays: 30 })
    await seedAges(ctx, [1, 45, 60])

    await ctx.store.add(entryAt(NOW, { sql: 'fresh' }))

    expect(await remaining(ctx)).toEqual(['fresh', 'age-1d'])
    expect(ctx.stored().entries).toHaveLength(2)
  })

  it('una alta con una fecha ya caducada no llega a conservarse', async () => {
    const ctx = setupHistory({ retentionDays: 7 })
    await ctx.store.add(entryAt(NOW - 20 * DAY_MS, { sql: 'stale' }))
    expect(await remaining(ctx)).toEqual([])
  })

  describe('al arrancar y con el temporizador diario', () => {
    it('start purga al arrancar y arma un temporizador', async () => {
      const ctx = setupHistory({ retentionDays: 30 })
      await seedAges(ctx, [1, 45, 200])

      await ctx.store.start()

      expect(await remaining(ctx)).toEqual(['age-1d'])
      expect(ctx.clock.activeTimers).toBe(1)
    })

    it('el temporizador diario purga lo que caduca con el paso de los días', async () => {
      const ctx = setupHistory({ retentionDays: 30 })
      await seedAges(ctx, [1, 20])
      await ctx.store.start()
      expect(await remaining(ctx)).toHaveLength(2)

      ctx.clock.advance(11 * DAY_MS)
      await ctx.store.list({})

      expect(await remaining(ctx)).toEqual(['age-1d'])
    })

    it('no purga antes de que pase un día', async () => {
      const ctx = setupHistory({ retentionDays: 7 })
      await seedAges(ctx, [1, 6])
      await ctx.store.start()

      ctx.clock.advance(DAY_MS - 1)

      expect(await remaining(ctx)).toHaveLength(2)
    })

    it('llamar a start dos veces no duplica el temporizador y stop lo cancela', async () => {
      const ctx = setupHistory()

      await ctx.store.start()
      await ctx.store.start()
      expect(ctx.clock.activeTimers).toBe(1)

      ctx.store.stop()
      expect(ctx.clock.activeTimers).toBe(0)
    })

    it('start no rechaza si el almacén falla y la siguiente purga lo reintenta', async () => {
      const ctx = setupHistory({ retentionDays: 7 })
      await seedAges(ctx, [1, 30])
      ctx.memory.hooks.failRead = true

      await expect(ctx.store.start()).resolves.toBeUndefined()

      ctx.memory.hooks.failRead = false
      ctx.clock.advance(DAY_MS)
      expect(await remaining(ctx)).toEqual(['age-1d'])
    })

    it('un fallo de escritura durante la purga diaria no rompe el almacén', async () => {
      const ctx = setupHistory({ retentionDays: 7 })
      await seedAges(ctx, [1, 30])
      await ctx.store.start()
      await seedAges(ctx, [1, 30])
      const fresh = createHistoryStore({
        fileSystem: ctx.memory.fileSystem,
        filePath: HISTORY_PATH,
        getRetentionDays: async () => 7,
        clock: ctx.clock,
      })

      ctx.memory.hooks.failWrite = true
      await fresh.start()
      ctx.memory.hooks.failWrite = false

      expect((await fresh.list({})).entries).toHaveLength(2)
      expect(await fresh.purge()).toBe(1)
    })
  })
})
