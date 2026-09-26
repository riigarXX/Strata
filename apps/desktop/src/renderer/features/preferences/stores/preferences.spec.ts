import { DEFAULT_PREFERENCES, type NormalizedError, type Preferences } from '@strata/contracts'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { usePreferencesStore } from './preferences'

const STORAGE_ERROR: NormalizedError = {
  code: 'internal_error',
  message: 'Could not access the saved preferences',
  retryable: true,
}

const SAVED: Preferences = {
  history: { enabled: false, retentionDays: 90 },
  appearance: { theme: 'dark' },
  execution: { timeoutSeconds: 60, maxRows: 500, confirmDestructive: false },
  ai: DEFAULT_PREFERENCES.ai,
}

let fake: ReturnType<typeof createFakeDb>

function setup(preferences?: Preferences) {
  fake = createFakeDb(preferences ? { preferences } : {})
  installFakeDb(fake.db)
  setActivePinia(createPinia())
  return usePreferencesStore()
}

beforeEach(() => {
  setup()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
  vi.restoreAllMocks()
})

describe('preferences store: initial state and load', () => {
  it('starts with the factory defaults and asks nothing to main until loaded', () => {
    const store = usePreferencesStore()
    expect(store.confirmDestructive).toBe(true)
    expect(store.timeoutSeconds).toBe(30)
    expect(store.maxRows).toBe(10_000)
    expect(store.theme).toBe('system')
    expect(store.historyEnabled).toBe(true)
    expect(store.historyRetentionDays).toBe(30)
    expect(store.status).toBe('idle')
    expect(fake.preferences.get).not.toHaveBeenCalled()
  })

  it('loads what main has saved', async () => {
    const store = setup(SAVED)
    const loading = store.load()
    expect(store.status).toBe('loading')
    expect(await loading).toBe(true)

    expect(store.status).toBe('ready')
    expect(store.theme).toBe('dark')
    expect(store.timeoutSeconds).toBe(60)
    expect(store.maxRows).toBe(500)
    expect(store.confirmDestructive).toBe(false)
    expect(store.historyEnabled).toBe(false)
    expect(store.historyRetentionDays).toBe(90)
  })

  it('keeps the defaults and reports the error when the preferences cannot be read', async () => {
    const store = usePreferencesStore()
    fake.preferences.get.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    expect(await store.load()).toBe(false)

    expect(store.status).toBe('error')
    expect(store.error).toEqual(STORAGE_ERROR)
    expect(store.theme).toBe('system')
  })

  it('recovers when loading is retried', async () => {
    const store = setup(SAVED)
    fake.preferences.get.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))
    await store.load()

    expect(await store.load()).toBe(true)

    expect(store.status).toBe('ready')
    expect(store.error).toBeNull()
    expect(store.theme).toBe('dark')
  })

  it('normalises a rejected call or a malformed answer into an error, never a throw', async () => {
    const store = usePreferencesStore()
    fake.preferences.get.mockRejectedValueOnce(
      new Error('Error invoking remote method /Users/me/secret'),
    )
    expect(await store.load()).toBe(false)
    expect(store.error?.code).toBe('internal_error')
    expect(JSON.stringify(store.error)).not.toContain('/Users/me')

    fake.preferences.get.mockResolvedValueOnce(
      ipcOk({ ...DEFAULT_PREFERENCES, extra: true } as unknown as Preferences),
    )
    expect(await store.load()).toBe(false)
    expect(store.status).toBe('error')
  })

  it('persistence is simulated across "restarts": a new store loads what the previous one saved', async () => {
    const first = usePreferencesStore()
    await first.setTheme('light')
    await first.setHistoryRetentionDays(null)

    setActivePinia(createPinia())
    const second = usePreferencesStore()
    await second.load()

    expect(second.theme).toBe('light')
    expect(second.historyRetentionDays).toBeNull()
  })
})

describe('preferences store: updates', () => {
  it('applies a change at once and sends only the partial patch', async () => {
    const store = usePreferencesStore()
    const saving = store.setTheme('dark')
    expect(store.theme).toBe('dark')
    expect(store.saveStatus).toBe('saving')

    expect(await saving).toBe(true)

    expect(fake.preferences.update).toHaveBeenCalledWith({ appearance: { theme: 'dark' } })
    expect(store.saveStatus).toBe('saved')
    expect(store.status).toBe('ready')
    expect(fake.storedPreferences().appearance.theme).toBe('dark')
  })

  it('updates the confirmation and clamps the limits it is given', async () => {
    const store = usePreferencesStore()
    await store.setConfirmDestructive(false)
    await store.setExecutionLimits({ timeoutSeconds: 1000, maxRows: 0 })
    expect(store.confirmDestructive).toBe(false)
    expect(store.timeoutSeconds).toBe(300)
    expect(store.maxRows).toBe(1)
    expect(fake.storedPreferences().execution).toEqual({
      timeoutSeconds: 300,
      maxRows: 1,
      confirmDestructive: false,
    })
  })

  it('exposes the history preferences', async () => {
    const store = usePreferencesStore()
    await store.setHistoryEnabled(false)
    await store.setHistoryRetentionDays(7)
    expect(fake.preferences.update).toHaveBeenNthCalledWith(1, { history: { enabled: false } })
    expect(fake.preferences.update).toHaveBeenNthCalledWith(2, { history: { retentionDays: 7 } })
    expect(store.historyEnabled).toBe(false)
    expect(store.historyRetentionDays).toBe(7)
  })

  it('exposes the local AI preferences and proposes the default address of each provider', async () => {
    const store = usePreferencesStore()
    expect(store.ai).toEqual(DEFAULT_PREFERENCES.ai)
    expect(store.ai.enabled).toBe(false)

    await store.setAiEnabled(true)
    await store.setAiProvider('lmstudio')
    await store.setAiModel('qwen/qwen3.8-27b')
    await store.setAiProvider('custom')
    await store.setAiBaseUrl('http://localhost:9000/v1')

    expect(fake.preferences.update).toHaveBeenNthCalledWith(1, { ai: { enabled: true } })
    expect(fake.preferences.update).toHaveBeenNthCalledWith(2, {
      ai: { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' },
    })
    expect(fake.preferences.update).toHaveBeenNthCalledWith(3, {
      ai: { model: 'qwen/qwen3.8-27b' },
    })
    expect(fake.preferences.update).toHaveBeenNthCalledWith(4, {
      ai: { provider: 'custom', baseUrl: 'http://127.0.0.1:8080' },
    })
    expect(store.ai).toEqual({
      enabled: true,
      provider: 'custom',
      baseUrl: 'http://localhost:9000/v1',
      model: 'qwen/qwen3.8-27b',
    })
  })

  it('never sends an address outside the loopback to main', async () => {
    const store = usePreferencesStore()
    expect(await store.setAiBaseUrl('http://192.168.1.5:11434')).toBe(false)
    expect(await store.setAiBaseUrl('http://127.0.0.1@evil.com:11434')).toBe(false)
    expect(fake.preferences.update).not.toHaveBeenCalled()
    expect(store.ai.baseUrl).toBe(DEFAULT_PREFERENCES.ai.baseUrl)
  })

  it('validates in the client: an invalid patch never reaches main', async () => {
    const store = usePreferencesStore()

    expect(await store.update({ execution: { timeoutSeconds: 0 } })).toBe(false)
    expect(await store.update({ history: { retentionDays: 45 as never } })).toBe(false)
    expect(await store.update({ appearance: { theme: 'sepia' as never } })).toBe(false)
    expect(await store.update({ connections: { password: 'x' } } as never)).toBe(false)

    expect(fake.preferences.update).not.toHaveBeenCalled()
    expect(store.saveStatus).toBe('error')
    expect(store.error?.code).toBe('validation_failed')
    expect(store.timeoutSeconds).toBe(30)
  })

  it('does not call main for a change that changes nothing once loaded', async () => {
    const store = usePreferencesStore()
    await store.load()
    expect(await store.setTheme('system')).toBe(true)
    expect(fake.preferences.update).not.toHaveBeenCalled()
  })

  it('goes back to what main confirmed, and reports it, when saving fails', async () => {
    const store = setup(SAVED)
    await store.load()
    fake.preferences.update.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    const saving = store.setTheme('light')
    expect(store.theme).toBe('light')
    expect(await saving).toBe(false)

    expect(store.theme).toBe('dark')
    expect(store.saveStatus).toBe('error')
    expect(store.error).toEqual(STORAGE_ERROR)
  })

  it('a later success clears the error and the feedback can be dismissed', async () => {
    const store = usePreferencesStore()
    await store.load()
    fake.preferences.update.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))
    await store.setTheme('dark')
    expect(store.saveStatus).toBe('error')

    await store.setTheme('light')
    expect(store.saveStatus).toBe('saved')
    expect(store.error).toBeNull()

    store.dismissFeedback()
    expect(store.saveStatus).toBe('idle')
  })

  it('sends the changes one at a time, in order, and ends with the last value', async () => {
    const store = usePreferencesStore()
    const order: string[] = []
    let releaseFirst!: () => void
    fake.preferences.update.mockImplementationOnce(async (patch) => {
      await new Promise<void>((resolve) => (releaseFirst = resolve))
      order.push(`first:${patch.appearance?.theme}`)
      return ipcOk({ ...DEFAULT_PREFERENCES, appearance: { theme: 'dark' } })
    })

    const first = store.setTheme('dark')
    const second = store.setTheme('light')
    await flushPromises()
    expect(fake.preferences.update).toHaveBeenCalledTimes(1)
    expect(store.saveStatus).toBe('saving')

    releaseFirst()
    await Promise.all([first, second])

    expect(order).toEqual(['first:dark'])
    expect(fake.preferences.update).toHaveBeenLastCalledWith({ appearance: { theme: 'light' } })
    expect(store.theme).toBe('light')
    expect(store.saveStatus).toBe('saved')
  })

  it('a failure followed by a success keeps only what main confirmed', async () => {
    const store = usePreferencesStore()
    await store.load()
    fake.preferences.update.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    const failing = store.setTheme('dark')
    const working = store.setHistoryRetentionDays(90)
    await Promise.all([failing, working])

    expect(store.theme).toBe('system')
    expect(store.historyRetentionDays).toBe(90)
  })

  it('an update issued while the first load is pending does not lose the loaded values', async () => {
    const store = setup(SAVED)
    const loading = store.load()
    const saving = store.setTheme('light')
    await Promise.all([loading, saving])

    expect(store.theme).toBe('light')
    expect(store.timeoutSeconds).toBe(60)
    expect(store.historyRetentionDays).toBe(90)
  })
})

describe('preferences store: session-only state and hygiene', () => {
  it('keeps the timing preference in memory only', async () => {
    const store = usePreferencesStore()
    store.setShowTiming(false)
    expect(store.showTiming).toBe(false)
    expect(fake.preferences.update).not.toHaveBeenCalled()
  })

  it('holds nothing but user choices: no secret or connection data reaches the store', async () => {
    const store = usePreferencesStore()
    await store.load()
    await store.setTheme('dark')
    const serialised = JSON.stringify(store.$state)
    expect(serialised).not.toMatch(/password|secret|token|host|user/i)
    expect(Object.keys(store.$state.values).sort()).toEqual([
      'ai',
      'appearance',
      'execution',
      'history',
    ])
  })
})
