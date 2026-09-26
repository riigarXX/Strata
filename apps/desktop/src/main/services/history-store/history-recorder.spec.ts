// @vitest-environment node
import { DEFAULT_PREFERENCES } from '@strata/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from '../local-storage/testing'
import { createPreferencesStore } from '../preferences-store'
import { createQueryExecutor } from '../query-executor'
import {
  createFakeSink,
  createSessionRuntime,
  createStreamingAdapter,
  until,
} from '../query-executor/testing'
import { createHistoryRecorder } from './history-recorder'
import { createHistoryStore } from './history-store'
import { entryAt, HISTORY_PATH, NOW } from './testing'

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('createHistoryRecorder', () => {
  it('guarda la entrada en el almacén cuando el historial está activo', async () => {
    const add = vi.fn(async () => entryAt(NOW) as never)
    const recorder = createHistoryRecorder({ store: { add }, isEnabled: async () => true })
    const entry = entryAt(NOW)

    expect(recorder.record(entry, { requestId: 'r' })).toBeUndefined()
    await settle()

    expect(add).toHaveBeenCalledWith(entry, { requestId: 'r' })
  })

  it('pasa al almacén la ejecución que originó la entrada', async () => {
    const add = vi.fn(async () => entryAt(NOW) as never)
    const recorder = createHistoryRecorder({ store: { add }, isEnabled: async () => true })
    const entry = entryAt(NOW)

    recorder.record(entry, { requestId: 'req-7' })
    await settle()

    expect(add).toHaveBeenCalledWith(entry, { requestId: 'req-7' })
  })

  it('no guarda nada cuando el historial está desactivado', async () => {
    const add = vi.fn()
    const recorder = createHistoryRecorder({ store: { add }, isEnabled: async () => false })

    recorder.record(entryAt(NOW), { requestId: 'r' })
    await settle()

    expect(add).not.toHaveBeenCalled()
  })

  it('consulta el estado del historial en cada registro', async () => {
    const add = vi.fn(async () => entryAt(NOW) as never)
    let enabled = true
    const recorder = createHistoryRecorder({ store: { add }, isEnabled: async () => enabled })

    recorder.record(entryAt(NOW), { requestId: 'r' })
    await settle()
    enabled = false
    recorder.record(entryAt(NOW), { requestId: 'r' })
    await settle()

    expect(add).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'el almacén rechaza',
      {
        add: async () => Promise.reject(new Error('disk full at /secret/path')),
        isEnabled: async () => true,
      },
    ],
    [
      'el almacén lanza de forma síncrona',
      {
        add: () => {
          throw new Error('sync boom')
        },
        isEnabled: async () => true,
      },
    ],
    [
      'las preferencias no se pueden leer',
      { add: vi.fn(), isEnabled: async () => Promise.reject(new Error('EIO')) },
    ],
  ])('absorbe el fallo cuando %s y avisa sin la causa', async (_name, deps) => {
    const onError = vi.fn()
    const recorder = createHistoryRecorder({
      store: { add: deps.add as never },
      isEnabled: deps.isEnabled,
      onError,
    })

    expect(() => recorder.record(entryAt(NOW), { requestId: 'r' })).not.toThrow()
    await settle()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith()
  })

  it('un aviso que también falla no escapa', async () => {
    const recorder = createHistoryRecorder({
      store: { add: async () => Promise.reject(new Error('x')) },
      isEnabled: async () => true,
      onError: () => {
        throw new Error('logger down')
      },
    })

    expect(() => recorder.record(entryAt(NOW), { requestId: 'r' })).not.toThrow()
    await settle()
  })

  it('por defecto avisa con un texto fijo que no contiene la causa', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const recorder = createHistoryRecorder({
      store: { add: async () => Promise.reject(new Error('EACCES /Users/me/secret')) },
      isEnabled: async () => true,
    })

    recorder.record(entryAt(NOW), { requestId: 'r' })
    await settle()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
    warn.mockRestore()
  })
})

describe('registro de extremo a extremo con preferencias y almacén reales', () => {
  function setup() {
    const memory = createMemoryStorage()
    const preferences = createPreferencesStore({
      fileSystem: memory.fileSystem,
      filePath: '/user-data/preferences.json',
    })
    const store = createHistoryStore({
      fileSystem: memory.fileSystem,
      filePath: HISTORY_PATH,
      getRetentionDays: async () => (await preferences.get()).history.retentionDays,
    })
    const adapter = createStreamingAdapter()
    const runtime = createSessionRuntime(adapter)
    const executor = createQueryExecutor({
      getSessionRuntime: () => runtime,
      history: createHistoryRecorder({
        store,
        isEnabled: async () => (await preferences.get()).history.enabled,
      }),
    })
    const sink = createFakeSink()
    let counter = 0
    const run = async (extra: { saveToHistory?: boolean } = {}) => {
      counter++
      executor.execute(
        { requestId: `r${counter}`, sessionId: 'session-1', sql: `SELECT ${counter}`, ...extra },
        sink,
      )
      await until(() => sink.ofType('done').length === counter)
      await settle()
    }
    return { preferences, store, run }
  }

  it('con las preferencias por defecto la ejecución aparece en el historial', async () => {
    const { store, run } = setup()

    await run()

    expect((await store.list({})).entries.map(({ sql }) => sql)).toEqual(['SELECT 1'])
  })

  it('con history.enabled en false no se registra y al reactivarlo vuelve a registrarse', async () => {
    const { store, preferences, run } = setup()

    await preferences.update({ history: { enabled: false } })
    await run()
    expect((await store.list({})).entries).toEqual([])

    await preferences.update({ history: { enabled: true } })
    await run()
    expect((await store.list({})).entries.map(({ sql }) => sql)).toEqual(['SELECT 2'])
  })

  it('saveToHistory: false gana aunque el historial esté activo', async () => {
    const { store, run } = setup()

    await run({ saveToHistory: false })
    await run()

    expect((await store.list({})).entries.map(({ sql }) => sql)).toEqual(['SELECT 2'])
    expect(DEFAULT_PREFERENCES.history.enabled).toBe(true)
  })
})
