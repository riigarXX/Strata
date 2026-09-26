// @vitest-environment node
import { DEFAULT_PREFERENCES, type Preferences } from '@strata/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from '../local-storage/testing'
import { createPreferencesStore } from './preferences-store'

const FILE_PATH = '/user-data/preferences.json'

function setup() {
  const memory = createMemoryStorage()
  const store = createPreferencesStore({ fileSystem: memory.fileSystem, filePath: FILE_PATH })
  return { memory, store }
}

const stored = (memory: ReturnType<typeof createMemoryStorage>) =>
  JSON.parse(memory.files.get(FILE_PATH) ?? 'null') as { version: number; preferences: Preferences }

describe('PreferencesStore', () => {
  it('arranca con los valores por defecto sin escribir nada', async () => {
    const { store, memory } = setup()

    expect(await store.get()).toEqual(DEFAULT_PREFERENCES)
    expect(memory.files.size).toBe(0)
  })

  it('devuelve copias: mutar el resultado no altera lo guardado', async () => {
    const { store } = setup()
    const first = await store.get()
    first.history.enabled = false

    expect((await store.get()).history.enabled).toBe(true)
  })

  it('aplica una actualización parcial, la persiste versionada y con permisos 0600', async () => {
    const { store, memory } = setup()

    const result = await store.update({
      history: { retentionDays: 90 },
      appearance: { theme: 'dark' },
    })

    expect(result).toEqual({
      ...DEFAULT_PREFERENCES,
      history: { enabled: true, retentionDays: 90 },
      appearance: { theme: 'dark' },
    })
    expect(stored(memory)).toEqual({ version: 1, preferences: result })
    expect(memory.modes.get(FILE_PATH)).toBe(0o600)
    expect(memory.files.has(`${FILE_PATH}.tmp`)).toBe(false)
  })

  it('acepta null como retención ilimitada y la conserva al releer', async () => {
    const { store, memory } = setup()
    await store.update({ history: { retentionDays: null } })

    const reopened = createPreferencesStore({ fileSystem: memory.fileSystem, filePath: FILE_PATH })
    expect((await reopened.get()).history.retentionDays).toBeNull()
  })

  it.each([
    { history: { retentionDays: 15 } },
    { execution: { timeoutSeconds: 0 } },
    { execution: { maxRows: 100_001 } },
    { appearance: { theme: 'sepia' } },
    { password: 'x' },
  ])('rechaza una actualización inválida (%j) sin tocar el archivo', async (patch) => {
    const { store, memory } = setup()
    await store.update({ history: { enabled: false } })
    const before = memory.files.get(FILE_PATH)

    await expect(store.update(patch as never)).rejects.toThrow()

    expect(memory.files.get(FILE_PATH)).toBe(before)
    expect((await store.get()).history.enabled).toBe(false)
  })

  it('una actualización que no cambia nada no escribe ni avisa', async () => {
    const { store, memory } = setup()
    const listener = vi.fn()
    store.subscribe(listener)

    await store.update({ history: { enabled: true } })
    await store.update({})

    expect(memory.files.size).toBe(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('serializa actualizaciones concurrentes sin perder ninguna', async () => {
    const { store } = setup()

    await Promise.all([
      store.update({ history: { enabled: false } }),
      store.update({ appearance: { theme: 'light' } }),
      store.update({ execution: { maxRows: 500 } }),
    ])

    expect(await store.get()).toEqual({
      history: { enabled: false, retentionDays: 30 },
      appearance: { theme: 'light' },
      execution: { timeoutSeconds: 30, maxRows: 500, confirmDestructive: true },
      ai: DEFAULT_PREFERENCES.ai,
    })
  })

  it('un fallo al escribir conserva el archivo y el estado anteriores', async () => {
    const { store, memory } = setup()
    await store.update({ appearance: { theme: 'dark' } })
    const before = memory.files.get(FILE_PATH)

    memory.hooks.failRename = true
    await expect(store.update({ appearance: { theme: 'light' } })).rejects.toMatchObject({
      normalized: { code: 'internal_error' },
    })

    expect(memory.files.get(FILE_PATH)).toBe(before)
    expect(memory.files.has(`${FILE_PATH}.tmp`)).toBe(false)
    expect((await store.get()).appearance.theme).toBe('dark')
  })

  it('un error de lectura no sustituye el archivo por los valores por defecto y se puede reintentar', async () => {
    const { store, memory } = setup()
    memory.files.set(
      FILE_PATH,
      JSON.stringify({ version: 1, preferences: { history: { enabled: false } } }),
    )

    memory.hooks.failRead = true
    await expect(store.get()).rejects.toBeDefined()
    expect(memory.files.has(`${FILE_PATH}.corrupt`)).toBe(false)

    memory.hooks.failRead = false
    expect((await store.get()).history.enabled).toBe(false)
  })

  describe('avisos de cambio', () => {
    it('notifica siguiente y anterior tras persistir, y se puede cancelar la suscripción', async () => {
      const { store } = setup()
      const listener = vi.fn()
      const unsubscribe = store.subscribe(listener)

      await store.update({ history: { retentionDays: 7 } })
      unsubscribe()
      await store.update({ history: { retentionDays: 90 } })

      expect(listener).toHaveBeenCalledTimes(1)
      const [next, previous] = listener.mock.calls[0] as [Preferences, Preferences]
      expect(next.history.retentionDays).toBe(7)
      expect(previous.history.retentionDays).toBe(30)
    })

    it('un oyente que lanza no impide la actualización ni a los demás oyentes', async () => {
      const { store } = setup()
      const healthy = vi.fn()
      store.subscribe(() => {
        throw new Error('boom')
      })
      store.subscribe(healthy)

      await expect(store.update({ history: { enabled: false } })).resolves.toBeDefined()
      expect(healthy).toHaveBeenCalledTimes(1)
    })

    it('no avisa si la escritura falla', async () => {
      const { store, memory } = setup()
      const listener = vi.fn()
      store.subscribe(listener)
      memory.hooks.failWrite = true

      await expect(store.update({ history: { enabled: false } })).rejects.toBeDefined()
      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('corrupción', () => {
    it('un archivo con JSON inválido arranca con los valores por defecto y conserva una copia', async () => {
      const { store, memory } = setup()
      memory.files.set(FILE_PATH, '{"version": 1, "prefer')

      expect(await store.get()).toEqual(DEFAULT_PREFERENCES)
      expect(memory.files.get(`${FILE_PATH}.corrupt`)).toBe('{"version": 1, "prefer')
      await store.update({ history: { enabled: false } })
      expect(stored(memory).preferences.history.enabled).toBe(false)
    })

    it.each([
      ['un array', '[]'],
      ['un texto', '"hola"'],
      ['una versión inválida', '{"version":"x","preferences":{}}'],
      ['una versión menor que 1', '{"version":0,"preferences":{}}'],
      ['sin preferencias', '{"version":1}'],
    ])('un archivo con %s se trata como corrupto', async (_name, raw) => {
      const { store, memory } = setup()
      memory.files.set(FILE_PATH, raw)

      expect(await store.get()).toEqual(DEFAULT_PREFERENCES)
      expect(memory.files.get(`${FILE_PATH}.corrupt`)).toBe(raw)
    })

    it('conserva los campos válidos y repone solo los inválidos', async () => {
      const { store, memory } = setup()
      const raw = JSON.stringify({
        version: 1,
        preferences: {
          history: { enabled: false, retentionDays: 15 },
          appearance: { theme: 'dark' },
          execution: { timeoutSeconds: 9999, maxRows: 250, confirmDestructive: 'sí' },
        },
      })
      memory.files.set(FILE_PATH, raw)

      expect(await store.get()).toEqual({
        history: { enabled: false, retentionDays: 30 },
        appearance: { theme: 'dark' },
        execution: { timeoutSeconds: 30, maxRows: 250, confirmDestructive: true },
        ai: DEFAULT_PREFERENCES.ai,
      })
      expect(memory.files.get(`${FILE_PATH}.corrupt`)).toBe(raw)
    })

    it('la corrupción de las preferencias no toca los demás almacenes', async () => {
      const { store, memory } = setup()
      memory.files.set('/user-data/connections.json', 'connections-untouched')
      memory.files.set('/user-data/history.json', 'history-untouched')
      memory.files.set(FILE_PATH, '{broken')

      await store.get()
      await store.update({ history: { enabled: false } })

      expect(memory.files.get('/user-data/connections.json')).toBe('connections-untouched')
      expect(memory.files.get('/user-data/history.json')).toBe('history-untouched')
    })
  })

  describe('migración', () => {
    it('lee el formato sin versión (secciones en la raíz), lo reescribe en v1 y no lo da por dañado', async () => {
      const { store, memory } = setup()
      memory.files.set(
        FILE_PATH,
        JSON.stringify({
          history: { enabled: false, retentionDays: 7 },
          appearance: { theme: 'light' },
        }),
      )

      const result = await store.get()

      expect(result).toEqual({
        ...DEFAULT_PREFERENCES,
        history: { enabled: false, retentionDays: 7 },
        appearance: { theme: 'light' },
      })
      expect(stored(memory)).toEqual({ version: 1, preferences: result })
      expect(memory.files.has(`${FILE_PATH}.corrupt`)).toBe(false)
    })

    it('una versión posterior se lee campo a campo con lo que se entiende, sin marcarla dañada', async () => {
      const { store, memory } = setup()
      memory.files.set(
        FILE_PATH,
        JSON.stringify({
          version: 7,
          preferences: { history: { enabled: false, futureField: 1 }, network: { proxy: 'x' } },
        }),
      )

      expect((await store.get()).history).toEqual({ enabled: false, retentionDays: 30 })
      expect(memory.files.has(`${FILE_PATH}.corrupt`)).toBe(false)
    })

    it('rellena con los valores por defecto los campos que añadió una versión nueva', async () => {
      const { store, memory } = setup()
      memory.files.set(
        FILE_PATH,
        JSON.stringify({ version: 1, preferences: { history: { enabled: false } } }),
      )

      expect(await store.get()).toEqual({
        ...DEFAULT_PREFERENCES,
        history: { enabled: false, retentionDays: 30 },
      })
      expect(memory.files.has(`${FILE_PATH}.corrupt`)).toBe(false)
    })

    it('un preferences.json anterior al asistente de IA se lee sin dañarlo: `ai` sale desactivado y por defecto', async () => {
      const { store, memory } = setup()
      const before = {
        version: 1,
        preferences: {
          history: { enabled: false, retentionDays: 7 },
          appearance: { theme: 'light' },
          execution: { timeoutSeconds: 45, maxRows: 250, confirmDestructive: false },
        },
      }
      memory.files.set(FILE_PATH, JSON.stringify(before))

      const result = await store.get()

      expect(result).toEqual({ ...before.preferences, ai: DEFAULT_PREFERENCES.ai })
      expect(result.ai.enabled).toBe(false)
      expect(memory.files.has(`${FILE_PATH}.corrupt`)).toBe(false)
    })

    it('activa el asistente con un parche parcial y lo conserva al releer', async () => {
      const { store, memory } = setup()

      await store.update({ ai: { enabled: true, model: 'llama3.1:8b' } })

      expect(stored(memory).preferences.ai).toEqual({
        ...DEFAULT_PREFERENCES.ai,
        enabled: true,
        model: 'llama3.1:8b',
      })
      const reread = createPreferencesStore({ fileSystem: memory.fileSystem, filePath: FILE_PATH })
      expect((await reread.get()).ai.enabled).toBe(true)
    })

    it('una dirección de IA que no es de bucle local, escrita a mano en el archivo, se repone y se marca dañada', async () => {
      const { store, memory } = setup()
      const raw = JSON.stringify({
        version: 1,
        preferences: { ai: { enabled: true, baseUrl: 'http://evil.example.com:11434' } },
      })
      memory.files.set(FILE_PATH, raw)

      const result = await store.get()

      expect(result.ai).toEqual({ ...DEFAULT_PREFERENCES.ai, enabled: true })
      expect(memory.files.get(`${FILE_PATH}.corrupt`)).toBe(raw)
    })

    it('si no puede reescribir el archivo migrado sigue funcionando en memoria', async () => {
      const { store, memory } = setup()
      memory.files.set(FILE_PATH, JSON.stringify({ history: { enabled: false } }))
      memory.hooks.failWrite = true

      expect((await store.get()).history.enabled).toBe(false)
    })
  })
})
