import { DEFAULT_PREFERENCES, type Preferences } from '@strata/contracts'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import {
  CONNECTION_ERROR,
  EMBEDDINGS,
  LM_STUDIO_MODEL,
  PULL_FAILED_ERROR,
  QWEN,
  stubAi,
  type FakeAiOptions,
} from '../testing/fake-ai'
import { useAiStore, type AiTarget } from './ai'

const OLLAMA: AiTarget = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }
const LM_STUDIO: AiTarget = { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' }

const enabled = (overrides: Partial<Preferences['ai']> = {}): Preferences => ({
  ...DEFAULT_PREFERENCES,
  ai: { ...DEFAULT_PREFERENCES.ai, enabled: true, ...overrides },
})

let fake: ReturnType<typeof createFakeDb>

function setup(options: FakeAiOptions = {}, preferences: Preferences = enabled()) {
  fake = createFakeDb({ preferences })
  installFakeDb(fake.db)
  const backend = stubAi(fake, options)
  setActivePinia(createPinia())
  return { store: useAiStore(), backend }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
})

describe('check', () => {
  it('starts with nothing checked', () => {
    const { store } = setup()
    expect(store.connection).toEqual({ phase: 'idle' })
    expect(store.models).toEqual([])
    expect(store.modelsStatus).toBe('idle')
    expect(store.pull.phase).toBe('idle')
  })

  it('detects Ollama with its version and lists every model it has, embeddings included', async () => {
    const { store } = setup()

    const pending = store.check(OLLAMA)
    expect(store.connection).toEqual({ phase: 'checking' })
    expect(store.modelsStatus).toBe('loading')
    await pending

    expect(store.connection).toEqual({ phase: 'reachable', version: '0.12.3' })
    expect(store.models).toEqual([QWEN, EMBEDDINGS])
    expect(store.modelsStatus).toBe('ready')
    expect(store.checkedTarget).toEqual(OLLAMA)
    expect(fake.ai.status).toHaveBeenCalledTimes(1)
    expect(fake.ai.listModels).toHaveBeenCalledWith(OLLAMA)
  })

  it('reports LM Studio as not reachable when its server is off, and says what else runs', async () => {
    const { store } = setup()

    await store.check(LM_STUDIO)

    expect(store.connection).toEqual({ phase: 'unreachable' })
    expect(store.models).toEqual([])
    expect(store.modelsStatus).toBe('idle')
    expect(
      store.detected.filter((server) => server.reachable).map((server) => server.provider),
    ).toEqual(['ollama'])
  })

  it('lists the models of LM Studio (no version, no sizes) when its server is on', async () => {
    const { store } = setup({ lmstudio: { reachable: true } })

    await store.check(LM_STUDIO)

    expect(store.connection).toEqual({ phase: 'reachable', version: null })
    expect(store.models).toEqual([LM_STUDIO_MODEL])
  })

  it('keeps a reachable server whose model list failed, with the error apart', async () => {
    const error = { code: 'not_found', message: 'No route', retryable: false } as const
    const { store } = setup({ ollama: { listError: error } })

    await store.check(OLLAMA)

    expect(store.connection).toEqual({ phase: 'reachable', version: '0.12.3' })
    expect(store.modelsStatus).toBe('error')
    expect(store.modelsError).toEqual(error)
    expect(store.models).toEqual([])
  })

  it('uses the answer of listModels for an address main has not probed yet', async () => {
    const { store, backend } = setup()
    const custom: AiTarget = { provider: 'custom', baseUrl: 'http://127.0.0.1:8080' }

    await store.check(custom)
    expect(store.connection).toEqual({ phase: 'unreachable' })

    backend.server(custom.baseUrl).reachable = true
    backend.server(custom.baseUrl).models = [LM_STUDIO_MODEL]
    await store.check(custom)
    expect(store.connection).toEqual({ phase: 'reachable', version: null })
    expect(store.models).toEqual([LM_STUDIO_MODEL])

    fake.ai.listModels.mockResolvedValueOnce(
      ipcFail({ code: 'permission_denied', message: 'Refused', retryable: false }),
    )
    await store.check(custom)
    expect(store.connection).toMatchObject({ phase: 'error', error: { code: 'permission_denied' } })
  })

  it('still reports the server when status itself fails', async () => {
    const { store } = setup()
    fake.ai.status.mockResolvedValueOnce(
      ipcFail({ code: 'internal_error', message: 'Broken', retryable: true }),
    )

    await store.check(OLLAMA)

    expect(store.connection).toEqual({ phase: 'reachable', version: null })
    expect(store.detected).toEqual([])
    expect(store.models).toEqual([QWEN, EMBEDDINGS])
  })

  it('reports both calls failing as unreachable when the server cannot be reached', async () => {
    const { store } = setup()
    fake.ai.status.mockResolvedValueOnce(ipcFail(CONNECTION_ERROR))
    fake.ai.listModels.mockResolvedValueOnce(ipcFail(CONNECTION_ERROR))

    await store.check({ provider: 'custom', baseUrl: 'http://127.0.0.1:9999' })

    expect(store.connection).toEqual({ phase: 'unreachable' })
  })

  it('keeps the previous list while checking the same server again, and drops it for another one', async () => {
    const { store } = setup({ lmstudio: { reachable: true } })
    await store.check(OLLAMA)

    const again = store.check(OLLAMA)
    expect(store.models).toEqual([QWEN, EMBEDDINGS])
    await again

    const other = store.check(LM_STUDIO)
    expect(store.models).toEqual([])
    await other
  })

  it('ignores an answer that arrives after a newer check', async () => {
    const { store } = setup({ lmstudio: { reachable: true } })
    let release: () => void = () => undefined
    fake.ai.listModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ipcOk([QWEN]))
        }),
    )

    const first = store.check(OLLAMA)
    await store.check(LM_STUDIO)
    expect(store.models).toEqual([LM_STUDIO_MODEL])
    release()
    await first

    expect(store.checkedTarget).toEqual(LM_STUDIO)
    expect(store.models).toEqual([LM_STUDIO_MODEL])
    expect(store.connection).toEqual({ phase: 'reachable', version: null })
  })

  it('forgets everything on reset, including an answer still on its way', async () => {
    const { store } = setup()
    const pending = store.check(OLLAMA)
    store.reset()
    await pending

    expect(store.connection).toEqual({ phase: 'idle' })
    expect(store.models).toEqual([])
    expect(store.modelsStatus).toBe('idle')
    expect(store.checkedTarget).toBeNull()
    expect(store.detected).toEqual([])
  })
})

describe('refreshModels', () => {
  it('updates the list without touching the connection state', async () => {
    const { store, backend } = setup()
    await store.check(OLLAMA)
    backend.server(OLLAMA.baseUrl).models = [QWEN]

    await store.refreshModels(OLLAMA)

    expect(store.models).toEqual([QWEN])
    expect(store.connection).toEqual({ phase: 'reachable', version: '0.12.3' })
  })

  it('reports a failed refresh as a models error', async () => {
    const { store } = setup()
    fake.ai.listModels.mockResolvedValueOnce(ipcFail(CONNECTION_ERROR))

    await store.refreshModels(OLLAMA)

    expect(store.modelsStatus).toBe('error')
    expect(store.modelsError).toEqual(CONNECTION_ERROR)
  })
})

describe('pull', () => {
  const progress = (
    store: ReturnType<typeof useAiStore>,
    backend: ReturnType<typeof stubAi>,
    status: string,
    completed: number | null,
    total: number | null,
  ) => {
    backend.pull.emit(status, completed, total)
    return store.pull.progress
  }

  it('downloads with a request id, shows the progress and refreshes the list when it ends', async () => {
    const { store, backend } = setup({ ollama: { models: [EMBEDDINGS] } })
    store.attach()
    await store.check(OLLAMA)

    const result = store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()
    expect(store.pull).toMatchObject({ phase: 'running', model: 'qwen3:14b' })
    expect(fake.ai.pullModel).toHaveBeenCalledWith({
      requestId: backend.pull.activeRequestId(),
      model: 'qwen3:14b',
    })
    expect(backend.pull.activeRequestId()).toMatch(/^[0-9a-f-]{36}$/)

    expect(progress(store, backend, 'pulling manifest', null, null).percent).toBeNull()
    expect(progress(store, backend, 'pulling abc', 500, 1000)).toMatchObject({
      stage: 'downloading',
      percent: 50,
      completed: 500,
      total: 1000,
    })

    backend.pull.finish()
    expect(await result).toBe(true)

    expect(store.pull.phase).toBe('done')
    expect(store.models.map((model) => model.name)).toEqual(['nomic-embed-text', 'qwen3:14b'])
    expect(store.modelsStatus).toBe('ready')
  })

  it('ignores progress that belongs to another request or arrives when nothing is running', async () => {
    const { store, backend } = setup()
    store.attach()
    fake.emitPullProgress({
      requestId: 'x',
      model: 'm',
      status: 'pulling a',
      completed: 1,
      total: 2,
    })
    expect(store.pull.progress.percent).toBeNull()

    void store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()
    fake.emitPullProgress({
      requestId: 'other',
      model: 'm',
      status: 'pulling a',
      completed: 1,
      total: 2,
    })
    expect(store.pull.progress.percent).toBeNull()

    backend.pull.fail()
    await flushPromises()
    fake.emitPullProgress({
      requestId: 'late',
      model: 'm',
      status: 'pulling a',
      completed: 2,
      total: 2,
    })
    expect(store.pull.progress.percent).toBeNull()
  })

  it('cancels a running download and ends as cancelled', async () => {
    const { store, backend } = setup()
    store.attach()
    const result = store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()
    const requestId = backend.pull.activeRequestId()

    const cancelling = store.cancelPull()
    expect(store.pull.phase).toBe('cancelling')
    await cancelling
    expect(await result).toBe(false)

    expect(fake.ai.cancel).toHaveBeenCalledWith({ requestId })
    expect(store.pull.phase).toBe('cancelled')
    expect(store.pull.error?.code).toBe('cancelled')
  })

  it('goes back to running when the cancel request itself fails', async () => {
    const { store } = setup()
    void store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()
    fake.ai.cancel.mockResolvedValueOnce(ipcFail(CONNECTION_ERROR))

    await store.cancelPull()

    expect(store.pull.phase).toBe('running')
  })

  it('does nothing when cancelling with no download in progress', async () => {
    const { store } = setup()
    await store.cancelPull()
    expect(fake.ai.cancel).not.toHaveBeenCalled()
    expect(store.pull.phase).toBe('idle')
  })

  it.each([
    ['a server that fails or has no space', PULL_FAILED_ERROR],
    ['an unknown model', { code: 'not_found', message: 'x', retryable: false } as const],
  ])('reports %s as an error with the code', async (_name, error) => {
    const { store, backend } = setup()
    const result = store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()

    backend.pull.fail(error)

    expect(await result).toBe(false)
    expect(store.pull).toMatchObject({ phase: 'error', error })
  })

  it('refuses to download while the assistant is disabled', async () => {
    const { store } = setup({}, DEFAULT_PREFERENCES)

    expect(await store.startPull('qwen3:14b', OLLAMA)).toBe(false)

    expect(store.pull).toMatchObject({ phase: 'error', error: { code: 'permission_denied' } })
  })

  it('refuses with LM Studio, which does not download models', async () => {
    const { store } = setup({}, enabled({ provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' }))

    expect(await store.startPull('qwen3:14b', LM_STUDIO)).toBe(false)

    expect(store.pull).toMatchObject({ phase: 'error', error: { code: 'validation_failed' } })
  })

  it('does not start a second download while one is running', async () => {
    const { store, backend } = setup()
    void store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()

    expect(await store.startPull('qwen3:14b', OLLAMA)).toBe(false)

    expect(fake.ai.pullModel).toHaveBeenCalledTimes(1)
    backend.pull.finish()
  })

  it('lets the user retry after a failure, with a new request id and clean progress', async () => {
    const { store, backend } = setup()
    store.attach()
    void store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()
    const first = backend.pull.activeRequestId()
    progress(store, backend, 'pulling a', 5, 10)
    backend.pull.fail()
    await flushPromises()

    void store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()

    expect(backend.pull.activeRequestId()).not.toBe(first)
    expect(store.pull).toMatchObject({ phase: 'running', error: null })
    expect(store.pull.progress.percent).toBeNull()
    backend.pull.finish()
  })

  it('collects the result of a download that ends while nobody is listening to the progress', async () => {
    const { store, backend } = setup({ ollama: { models: [] } })
    store.attach()
    const result = store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()
    store.detach()
    expect(fake.pullListenerCount()).toBe(0)

    backend.pull.finish()
    await result

    expect(store.pull.phase).toBe('done')
    expect(store.models.map((model) => model.name)).toEqual(['qwen3:14b'])
  })

  it('forgets a finished download but never one that is still running', async () => {
    const { store, backend } = setup()
    void store.startPull('qwen3:14b', OLLAMA)
    await flushPromises()
    store.clearFinishedPull()
    expect(store.pull.phase).toBe('running')

    backend.pull.fail()
    await flushPromises()
    expect(store.pull.phase).toBe('error')
    store.clearFinishedPull()
    expect(store.pull).toMatchObject({ phase: 'idle', error: null, model: null })
  })
})

describe('progress subscription', () => {
  it('subscribes once, however many times it is asked, and leaves no listener after detach', () => {
    const { store } = setup()
    expect(fake.pullListenerCount()).toBe(0)

    store.attach()
    store.attach()
    expect(fake.pullListenerCount()).toBe(1)
    expect(fake.ai.onPullProgress).toHaveBeenCalledTimes(1)

    store.detach()
    store.detach()
    expect(fake.pullListenerCount()).toBe(0)

    store.attach()
    expect(fake.pullListenerCount()).toBe(1)
    store.detach()
  })
})
