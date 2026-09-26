// @vitest-environment node
import { HISTORY_LIMITS, type HistoryChange, type HistoryEntry } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { createHistoryStore } from './history-store'
import { DAY_MS, entryAt, HISTORY_PATH, NOW, setupHistory } from './testing'

const MINUTE = 60_000

describe('HistoryStore: alta y persistencia', () => {
  it('arranca vacío si el archivo no existe y no escribe nada', async () => {
    const { store, memory } = setupHistory()

    expect(await store.list({})).toEqual({ entries: [], nextCursor: null })
    expect(memory.files.size).toBe(0)
  })

  it('añade una entrada con id, la persiste versionada y con permisos 0600', async () => {
    const { store, memory, stored } = setupHistory()

    const added = await store.add(
      entryAt(NOW - MINUTE, { status: 'error', errorCode: 'syntax_error', rowCount: 3 }),
    )

    expect(added).toEqual({
      id: 'id-0001',
      sql: 'SELECT 1',
      engine: 'sqlite',
      profileId: 'profile-1',
      profileName: 'Local',
      executedAt: new Date(NOW - MINUTE).toISOString(),
      durationMs: 5,
      status: 'error',
      rowCount: 3,
      errorCode: 'syntax_error',
    })
    expect(stored()).toEqual({ version: 1, entries: [added] })
    expect(memory.modes.get(HISTORY_PATH)).toBe(0o600)
    expect(memory.files.has(`${HISTORY_PATH}.tmp`)).toBe(false)
  })

  it('rechaza una entrada con campos no permitidos, como resultados o una password', async () => {
    const { store } = setupHistory()

    await expect(store.add({ ...entryAt(NOW), rows: [[1]] } as never)).rejects.toThrow()
    await expect(store.add({ ...entryAt(NOW), password: 'x' } as never)).rejects.toThrow()
    expect(await store.list({})).toEqual({ entries: [], nextCursor: null })
  })

  it('devuelve las entradas más recientes primero, con el id como desempate', async () => {
    const { store } = setupHistory()
    await store.add(entryAt(NOW - 3 * MINUTE, { sql: 'old' }))
    await store.add(entryAt(NOW - MINUTE, { sql: 'new' }))
    await store.add(entryAt(NOW - 2 * MINUTE, { sql: 'mid' }))
    await store.add(entryAt(NOW - 2 * MINUTE, { sql: 'mid-tie' }))

    const { entries } = await store.list({})
    expect(entries.map(({ sql }) => sql)).toEqual(['new', 'mid-tie', 'mid', 'old'])
  })

  it('normaliza la fecha a UTC con milisegundos', async () => {
    const { store } = setupHistory()
    const added = await store.add({ ...entryAt(NOW), executedAt: '2026-09-20T13:00:00Z' })
    expect(added.executedAt).toBe('2026-09-20T13:00:00.000Z')
  })

  it('un fallo al escribir conserva el archivo y el estado anteriores', async () => {
    const { store, memory } = setupHistory()
    await store.add(entryAt(NOW, { sql: 'first' }))
    const before = memory.files.get(HISTORY_PATH)

    memory.hooks.failRename = true
    await expect(store.add(entryAt(NOW, { sql: 'second' }))).rejects.toMatchObject({
      normalized: { code: 'internal_error' },
    })

    expect(memory.files.get(HISTORY_PATH)).toBe(before)
    expect(memory.files.has(`${HISTORY_PATH}.tmp`)).toBe(false)
    expect((await store.list({})).entries.map(({ sql }) => sql)).toEqual(['first'])
  })

  it('serializa altas concurrentes sin perder ninguna', async () => {
    const { store } = setupHistory()

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.add(entryAt(NOW - index * 1000))),
    )

    expect((await store.list({ limit: 200 })).entries).toHaveLength(20)
  })

  it('las entradas sobreviven a un nuevo almacén sobre el mismo archivo', async () => {
    const { store, memory, clock } = setupHistory()
    await store.add(entryAt(NOW - MINUTE, { sql: 'kept' }))

    const reopened = createHistoryStore({
      fileSystem: memory.fileSystem,
      filePath: HISTORY_PATH,
      getRetentionDays: async () => 30,
      clock,
    })
    expect((await reopened.list({})).entries.map(({ sql }) => sql)).toEqual(['kept'])
  })
})

describe('HistoryStore: tope de tamaño', () => {
  it('recorta un SQL largo y termina el texto con una marca', async () => {
    const { store } = setupHistory()
    const sql = `SELECT '${'x'.repeat(HISTORY_LIMITS.maxSqlChars + 5_000)}'`

    const added = await store.add(entryAt(NOW, { sql }))

    expect(added.sql.startsWith(sql.slice(0, HISTORY_LIMITS.maxSqlChars))).toBe(true)
    expect(added.sql).toMatch(/\n-- \[Strata: SQL truncated, 5\d{3} more characters\]$/)
    expect(added.sql.length).toBeLessThan(HISTORY_LIMITS.maxSqlChars + 100)
  })

  it('un SQL exactamente en el tope no se recorta', async () => {
    const { store } = setupHistory()
    const sql = 'y'.repeat(HISTORY_LIMITS.maxSqlChars)
    expect((await store.add(entryAt(NOW, { sql }))).sql).toBe(sql)
  })

  it('no parte un par sustituto por la mitad al recortar', async () => {
    const { store } = setupHistory()
    const sql = `${'a'.repeat(HISTORY_LIMITS.maxSqlChars - 1)}😀tail`

    const added = await store.add(entryAt(NOW, { sql }))

    expect(added.sql.startsWith('a'.repeat(HISTORY_LIMITS.maxSqlChars - 1))).toBe(true)
    expect(added.sql).not.toContain('\ud83d')
    expect(added.sql).toContain('truncated')
  })

  it('conserva como mucho el máximo de entradas y descarta las más antiguas', async () => {
    const { memory, clock, retention } = setupHistory({ retentionDays: null })
    const max = HISTORY_LIMITS.maxEntries
    const seeded = Array.from({ length: max }, (_, index) => ({
      ...entryAt(NOW - (index + 1) * 1000, { sql: `q${index}` }),
      id: `seed-${String(index).padStart(5, '0')}`,
    }))
    memory.files.set(HISTORY_PATH, JSON.stringify({ version: 1, entries: seeded }))
    const store = createHistoryStore({
      fileSystem: memory.fileSystem,
      filePath: HISTORY_PATH,
      getRetentionDays: async () => retention.days,
      clock,
      createId: () => 'newest',
    })

    await store.add(entryAt(NOW, { sql: 'newest' }))

    const all: HistoryEntry[] = []
    let cursor: string | undefined
    do {
      const page = await store.list({ limit: 200, ...(cursor ? { cursor } : {}) })
      all.push(...page.entries)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(all).toHaveLength(max)
    expect(all[0]?.sql).toBe('newest')
    expect(all.some(({ sql }) => sql === `q${max - 1}`)).toBe(false)
    expect(all.at(-1)?.sql).toBe(`q${max - 2}`)
  })
})

describe('HistoryStore: búsqueda y filtros', () => {
  async function seeded() {
    const ctx = setupHistory()
    const { store } = ctx
    await store.add(
      entryAt(NOW - 6 * MINUTE, {
        sql: 'SELECT * FROM Users',
        profileId: 'pg',
        engine: 'postgres',
        profileName: 'PG',
      }),
    )
    await store.add(
      entryAt(NOW - 5 * MINUTE, {
        sql: 'select name from users where id = 1',
        status: 'error',
        errorCode: 'syntax_error',
      }),
    )
    await store.add(entryAt(NOW - 4 * MINUTE, { sql: 'DELETE FROM orders', status: 'cancelled' }))
    await store.add(
      entryAt(NOW - 3 * MINUTE, {
        sql: 'INSERT INTO orders VALUES (1)',
        profileId: 'pg',
        engine: 'postgres',
        profileName: 'PG',
      }),
    )
    await store.add(entryAt(NOW - 2 * MINUTE, { sql: 'SELECT 100% FROM t' }))
    return ctx
  }
  const sqls = async (
    store: Awaited<ReturnType<typeof seeded>>['store'],
    request: Parameters<typeof store.list>[0],
  ) => (await store.list(request)).entries.map(({ sql }) => sql)

  it('busca una subcadena sin distinguir mayúsculas', async () => {
    const { store } = await seeded()

    expect(await sqls(store, { search: 'USERS' })).toEqual([
      'select name from users where id = 1',
      'SELECT * FROM Users',
    ])
    expect(await sqls(store, { search: 'from orders' })).toEqual(['DELETE FROM orders'])
    expect(await sqls(store, { search: 'nothing-like-this' })).toEqual([])
  })

  it('trata el texto buscado de forma literal, sin comodines ni expresiones regulares', async () => {
    const { store } = await seeded()

    expect(await sqls(store, { search: '100%' })).toEqual(['SELECT 100% FROM t'])
    expect(await sqls(store, { search: '.*' })).toEqual([])
    expect(await sqls(store, { search: 'SELECT *' })).toEqual(['SELECT * FROM Users'])
  })

  it('una búsqueda vacía no filtra', async () => {
    const { store } = await seeded()
    expect(await sqls(store, { search: '' })).toHaveLength(5)
  })

  it('filtra por motor, estado y perfil', async () => {
    const { store } = await seeded()

    expect(await sqls(store, { engine: 'postgres' })).toEqual([
      'INSERT INTO orders VALUES (1)',
      'SELECT * FROM Users',
    ])
    expect(await sqls(store, { status: 'error' })).toEqual(['select name from users where id = 1'])
    expect(await sqls(store, { status: 'cancelled' })).toEqual(['DELETE FROM orders'])
    expect(await sqls(store, { profileId: 'pg' })).toHaveLength(2)
    expect(await sqls(store, { profileId: 'unknown' })).toEqual([])
  })

  it('filtra por rango de fechas con límites inclusivos', async () => {
    const { store } = await seeded()
    const iso = (offset: number) => new Date(NOW - offset * MINUTE).toISOString()

    expect(await sqls(store, { from: iso(4), to: iso(3) })).toEqual([
      'INSERT INTO orders VALUES (1)',
      'DELETE FROM orders',
    ])
    expect(await sqls(store, { from: iso(3) })).toHaveLength(2)
    expect(await sqls(store, { to: iso(5) })).toHaveLength(2)
    expect(await sqls(store, { from: iso(0) })).toEqual([])
  })

  it('combina búsqueda y filtros', async () => {
    const { store } = await seeded()

    expect(await sqls(store, { search: 'users', engine: 'postgres' })).toEqual([
      'SELECT * FROM Users',
    ])
    expect(await sqls(store, { search: 'orders', status: 'ok' })).toEqual([
      'INSERT INTO orders VALUES (1)',
    ])
  })
})

describe('HistoryStore: paginación por cursor', () => {
  async function withEntries(count: number) {
    const ctx = setupHistory()
    for (let index = 0; index < count; index++) {
      await ctx.store.add(entryAt(NOW - index * MINUTE, { sql: `q${index}` }))
    }
    return ctx
  }

  it('recorre todas las entradas por páginas sin repetir ni saltarse ninguna', async () => {
    const { store } = await withEntries(7)
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0

    do {
      const page = await store.list({ limit: 3, ...(cursor ? { cursor } : {}) })
      seen.push(...page.entries.map(({ sql }) => sql))
      cursor = page.nextCursor ?? undefined
      pages++
    } while (cursor)

    expect(pages).toBe(3)
    expect(seen).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6'])
  })

  it('una página exacta no devuelve cursor y una que deja más sí lo devuelve', async () => {
    const { store } = await withEntries(3)

    expect((await store.list({ limit: 3 })).nextCursor).toBeNull()
    expect((await store.list({ limit: 2 })).nextCursor).not.toBeNull()
  })

  it('desempata por id cuando varias entradas comparten fecha', async () => {
    const { store } = setupHistory()
    for (let index = 0; index < 5; index++) await store.add(entryAt(NOW, { sql: `same${index}` }))

    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.list({ limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...page.entries.map(({ sql }) => sql))
      cursor = page.nextCursor ?? undefined
    } while (cursor)

    expect(seen).toEqual(['same4', 'same3', 'same2', 'same1', 'same0'])
  })

  it('el cursor sigue siendo válido si entre páginas se borra la entrada a la que apunta', async () => {
    const { store } = await withEntries(5)
    const first = await store.list({ limit: 2 })
    await store.delete(first.entries[1]!.id)

    const second = await store.list({ limit: 2, cursor: first.nextCursor! })
    expect(second.entries.map(({ sql }) => sql)).toEqual(['q2', 'q3'])
  })

  it('aplica los filtros junto con el cursor', async () => {
    const { store } = setupHistory()
    for (let index = 0; index < 6; index++) {
      await store.add(
        entryAt(NOW - index * MINUTE, { sql: `q${index}`, status: index % 2 ? 'error' : 'ok' }),
      )
    }

    const first = await store.list({ status: 'ok', limit: 2 })
    const second = await store.list({ status: 'ok', limit: 2, cursor: first.nextCursor! })

    expect(first.entries.map(({ sql }) => sql)).toEqual(['q0', 'q2'])
    expect(second.entries.map(({ sql }) => sql)).toEqual(['q4'])
    expect(second.nextCursor).toBeNull()
  })

  it('usa el tamaño de página por defecto', async () => {
    const { store } = await withEntries(HISTORY_LIMITS.pageSize.default + 3)
    const page = await store.list({})
    expect(page.entries).toHaveLength(HISTORY_LIMITS.pageSize.default)
    expect(page.nextCursor).not.toBeNull()
  })
})

describe('HistoryStore: borrado y vaciado', () => {
  it('borra una entrada por id y solo esa', async () => {
    const { store, stored } = setupHistory()
    const a = await store.add(entryAt(NOW - MINUTE, { sql: 'a' }))
    await store.add(entryAt(NOW, { sql: 'b' }))

    expect(await store.delete(a.id)).toBe(1)
    expect(await store.delete(a.id)).toBe(0)
    expect(await store.delete('unknown')).toBe(0)

    expect((await store.list({})).entries.map(({ sql }) => sql)).toEqual(['b'])
    expect(stored().entries).toHaveLength(1)
  })

  it('vacía todo el historial y persiste el vaciado', async () => {
    const { store, stored } = setupHistory()
    for (let index = 0; index < 4; index++) await store.add(entryAt(NOW - index))

    expect(await store.clear()).toBe(4)
    expect(await store.clear()).toBe(0)

    expect(await store.list({})).toEqual({ entries: [], nextCursor: null })
    expect(stored()).toEqual({ version: 1, entries: [] })
  })

  it('un fallo al borrar deja las entradas como estaban', async () => {
    const { store, memory } = setupHistory()
    const added = await store.add(entryAt(NOW))
    memory.hooks.failWrite = true

    await expect(store.delete(added.id)).rejects.toBeDefined()
    await expect(store.clear()).rejects.toBeDefined()
    expect((await store.list({})).entries).toHaveLength(1)
  })
})

describe('HistoryStore: corrupción', () => {
  it('un archivo con JSON inválido arranca vacío y conserva una copia del original', async () => {
    const { store, memory } = setupHistory()
    memory.files.set(HISTORY_PATH, '{"entries": [')
    memory.files.set('/user-data/connections.json', 'connections-untouched')
    memory.files.set('/user-data/credentials.json', 'credentials-untouched')

    expect(await store.list({})).toEqual({ entries: [], nextCursor: null })
    await store.add(entryAt(NOW))

    expect(memory.files.get(`${HISTORY_PATH}.corrupt`)).toBe('{"entries": [')
    expect((await store.list({})).entries).toHaveLength(1)
    expect(memory.files.get('/user-data/connections.json')).toBe('connections-untouched')
    expect(memory.files.get('/user-data/credentials.json')).toBe('credentials-untouched')
  })

  it.each([
    ['un array', '[]'],
    ['sin lista de entradas', '{"version":1}'],
    ['con entradas que no es un array', '{"entries":"x"}'],
  ])('un archivo %s se trata como corrupto', async (_name, raw) => {
    const { store, memory } = setupHistory()
    memory.files.set(HISTORY_PATH, raw)

    expect((await store.list({})).entries).toEqual([])
    expect(memory.files.get(`${HISTORY_PATH}.corrupt`)).toBe(raw)
  })

  it('descarta solo las entradas inválidas o duplicadas y conserva el resto', async () => {
    const { store, memory } = setupHistory()
    const good = { ...entryAt(NOW - MINUTE, { sql: 'good' }), id: 'g1' }
    const raw = JSON.stringify({
      version: 1,
      entries: [
        good,
        { ...good, id: 'g2', rows: [[1]] },
        { ...good, id: 'g3', status: 'running' },
        { ...good, id: 'g4', executedAt: 'yesterday' },
        good,
        { ...good, id: 'g5', sql: 'also good' },
      ],
    })
    memory.files.set(HISTORY_PATH, raw)

    expect((await store.list({})).entries.map(({ id }) => id)).toEqual(['g5', 'g1'])
    expect(memory.files.get(`${HISTORY_PATH}.corrupt`)).toBe(raw)
  })

  it('ordena por fecha las entradas de un archivo desordenado y normaliza sus fechas', async () => {
    const { store, memory } = setupHistory()
    memory.files.set(
      HISTORY_PATH,
      JSON.stringify({
        version: 1,
        entries: [
          {
            ...entryAt(NOW - 3 * MINUTE, { sql: 'old' }),
            id: 'a',
            executedAt: '2026-09-20T11:57:00Z',
          },
          { ...entryAt(NOW - MINUTE, { sql: 'new' }), id: 'b' },
        ],
      }),
    )

    const { entries } = await store.list({})
    expect(entries.map(({ sql }) => sql)).toEqual(['new', 'old'])
    expect(entries[1]?.executedAt).toBe('2026-09-20T11:57:00.000Z')
  })

  it('un error de E/S no sustituye el archivo por uno vacío y se puede reintentar', async () => {
    const { store, memory } = setupHistory()
    memory.files.set(
      HISTORY_PATH,
      JSON.stringify({ version: 1, entries: [{ ...entryAt(NOW), id: 'x' }] }),
    )

    memory.hooks.failRead = true
    await expect(store.list({})).rejects.toBeDefined()
    expect(memory.files.has(`${HISTORY_PATH}.corrupt`)).toBe(false)

    memory.hooks.failRead = false
    expect((await store.list({})).entries).toHaveLength(1)
  })

  it('el historial no depende de las preferencias: si no se leen, no se purga por edad pero se añade', async () => {
    const { memory, clock } = setupHistory()
    const store = createHistoryStore({
      fileSystem: memory.fileSystem,
      filePath: HISTORY_PATH,
      getRetentionDays: async () => {
        throw new Error('preferences unreadable')
      },
      clock,
    })

    await store.add(entryAt(NOW - 400 * DAY_MS, { sql: 'ancient' }))
    await store.add(entryAt(NOW, { sql: 'recent' }))
    expect(await store.purge()).toBe(0)

    expect((await store.list({})).entries).toHaveLength(2)
  })
})

describe('HistoryStore: aviso de cambios', () => {
  function watch(ctx: ReturnType<typeof setupHistory>) {
    const changes: HistoryChange[] = []
    ctx.store.subscribe((change) => changes.push(change))
    return changes
  }

  it('un alta avisa con la entrada guardada y la ejecución que la originó', async () => {
    const ctx = setupHistory()
    const changes = watch(ctx)

    const added = await ctx.store.add(entryAt(NOW), { requestId: 'req-1' })

    expect(changes).toEqual([{ type: 'added', entry: added, requestId: 'req-1' }])
  })

  it('sin requestId el aviso de alta no lo lleva y el requestId nunca se guarda en disco', async () => {
    const ctx = setupHistory()
    const changes = watch(ctx)

    await ctx.store.add(entryAt(NOW))
    await ctx.store.add(entryAt(NOW), { requestId: 'req-2' })

    expect(changes[0]).not.toHaveProperty('requestId')
    expect(JSON.stringify(ctx.stored())).not.toContain('req-2')
  })

  it('un borrado individual avisa con el id, y solo si la entrada existía', async () => {
    const ctx = setupHistory()
    const first = await ctx.store.add(entryAt(NOW))
    const changes = watch(ctx)

    await ctx.store.delete('no-existe')
    await ctx.store.delete(first.id)

    expect(changes).toEqual([{ type: 'removed', id: first.id }])
  })

  it('vaciar avisa solo si había algo', async () => {
    const ctx = setupHistory()
    const changes = watch(ctx)

    await ctx.store.clear()
    await ctx.store.add(entryAt(NOW))
    changes.length = 0
    await ctx.store.clear()
    await ctx.store.clear()

    expect(changes).toEqual([{ type: 'cleared' }])
  })

  it('la purga avisa solo si quitó algo', async () => {
    const ctx = setupHistory({ retentionDays: 30 })
    ctx.memory.files.set(
      HISTORY_PATH,
      JSON.stringify({ version: 1, entries: [{ ...entryAt(NOW - 40 * DAY_MS), id: 'old' }] }),
    )
    const changes = watch(ctx)

    await ctx.store.purge()
    await ctx.store.purge()

    expect(changes).toEqual([{ type: 'purged' }])
  })

  it('un alta que además expulsa entradas caducadas avisa del alta y de la purga', async () => {
    const ctx = setupHistory({ retentionDays: 30 })
    await ctx.store.add(entryAt(NOW - DAY_MS))
    const changes = watch(ctx)
    ctx.clock.advance(31 * DAY_MS)

    const added = await ctx.store.add(entryAt(NOW + 31 * DAY_MS))

    expect(changes).toEqual([{ type: 'added', entry: added }, { type: 'purged' }])
  })

  it('un alta ya caducada no se anuncia como añadida', async () => {
    const ctx = setupHistory({ retentionDays: 30 })
    const changes = watch(ctx)

    await ctx.store.add(entryAt(NOW - 40 * DAY_MS))

    expect(changes).toEqual([])
  })

  it('no avisa si la escritura falla', async () => {
    const ctx = setupHistory()
    await ctx.store.add(entryAt(NOW))
    const changes = watch(ctx)

    ctx.memory.hooks.failRename = true
    await expect(ctx.store.add(entryAt(NOW))).rejects.toThrow()
    await expect(ctx.store.clear()).rejects.toThrow()

    expect(changes).toEqual([])
  })

  it('desuscribirse detiene los avisos y un listener que lanza no afecta a los demás ni al almacén', async () => {
    const ctx = setupHistory()
    const seen: HistoryChange[] = []
    ctx.store.subscribe(() => {
      throw new Error('listener roto')
    })
    const unsubscribe = ctx.store.subscribe((change) => seen.push(change))

    await expect(ctx.store.add(entryAt(NOW))).resolves.toBeDefined()
    unsubscribe()
    await ctx.store.add(entryAt(NOW))

    expect(seen).toHaveLength(1)
    expect((await ctx.store.list({})).entries).toHaveLength(2)
  })
})
