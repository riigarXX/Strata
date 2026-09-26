// @vitest-environment node
import { DEFAULT_PREFERENCES, IPC_CHANNELS } from '@strata/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createAppOrigin } from '../security/app-origin'
import type { IpcSenderLike } from '../security/sender-validation'
import { createMemoryStorage } from '../services/local-storage/testing'
import { createPreferencesStore } from '../services/preferences-store'
import { createPreferencesHandlers } from './preferences-handlers'

const ENTRY_URL = 'app://strata/index.html'
const appOrigin = createAppOrigin()
const channels = IPC_CHANNELS.preferences
const mainFrame = { url: ENTRY_URL }
const webContents = { mainFrame }
const trustedEvent: IpcSenderLike = { sender: webContents, senderFrame: mainFrame }

function setup() {
  const memory = createMemoryStorage()
  const store = createPreferencesStore({
    fileSystem: memory.fileSystem,
    filePath: '/user-data/preferences.json',
  })
  const preferencesStore = { get: vi.fn(() => store.get()), update: vi.fn((p) => store.update(p)) }
  const handlers = createPreferencesHandlers({
    preferencesStore,
    getMainWindow: () => ({ webContents }),
    appOrigin,
  })
  return { handlers, preferencesStore, memory }
}

describe('createPreferencesHandlers', () => {
  it('registra exactamente los canales get y update', () => {
    expect(Object.keys(setup().handlers).sort()).toEqual([channels.get, channels.update].sort())
  })

  it('get devuelve las preferencias por defecto y update una actualización parcial completa', async () => {
    const { handlers } = setup()

    await expect(handlers[channels.get]!(trustedEvent, undefined)).resolves.toEqual({
      ok: true,
      data: DEFAULT_PREFERENCES,
    })
    await expect(
      handlers[channels.update]!(trustedEvent, { history: { retentionDays: null } }),
    ).resolves.toEqual({
      ok: true,
      data: { ...DEFAULT_PREFERENCES, history: { enabled: true, retentionDays: null } },
    })
    await expect(handlers[channels.get]!(trustedEvent, undefined)).resolves.toMatchObject({
      data: { history: { retentionDays: null } },
    })
  })

  it.each([
    { history: { retentionDays: 15 } },
    { history: { enabled: 'yes' } },
    { execution: { maxRows: 0 } },
    { appearance: { theme: 'neon' } },
    { unknown: true },
    { history: { enabled: true, extra: 1 } },
    'x',
    null,
    [],
    undefined,
  ])('update rechaza un payload inválido (%j) sin llegar al almacén', async (payload) => {
    const { handlers, preferencesStore } = setup()

    await expect(handlers[channels.update]!(trustedEvent, payload)).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    })
    expect(preferencesStore.update).not.toHaveBeenCalled()
  })

  it.each([{}, 'x', { a: 1 }])('get rechaza un payload inesperado (%j)', async (payload) => {
    const { handlers, preferencesStore } = setup()

    await expect(handlers[channels.get]!(trustedEvent, payload)).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    })
    expect(preferencesStore.get).not.toHaveBeenCalled()
  })

  it('rechaza un remitente no confiable en todos los canales sin tocar el almacén', async () => {
    const { handlers, preferencesStore } = setup()
    const other = { url: ENTRY_URL }
    const event: IpcSenderLike = { sender: { mainFrame: other }, senderFrame: other }

    for (const channel of [channels.get, channels.update]) {
      await expect(handlers[channel]!(event, {})).rejects.toThrow('IPC sender not allowed')
    }
    expect(preferencesStore.get).not.toHaveBeenCalled()
    expect(preferencesStore.update).not.toHaveBeenCalled()
  })

  it('un fallo del almacén llega normalizado y sin la ruta del archivo', async () => {
    const { handlers, memory } = setup()
    memory.hooks.failWrite = true

    const result = await handlers[channels.update]!(trustedEvent, { history: { enabled: false } })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not access the saved preferences',
        retryable: false,
      },
    })
    expect(JSON.stringify(result)).not.toContain('/user-data')
  })

  it('la respuesta nunca incluye campos fuera del schema aunque el almacén los devuelva', async () => {
    const memory = createMemoryStorage()
    const handlers = createPreferencesHandlers({
      preferencesStore: {
        get: async () => ({ ...DEFAULT_PREFERENCES, apiKey: 'sk-secret' }) as never,
        update: async () => DEFAULT_PREFERENCES,
      },
      getMainWindow: () => ({ webContents }),
      appOrigin,
    })

    const result = await handlers[channels.get]!(trustedEvent, undefined)

    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
    expect(JSON.stringify(result)).not.toContain('sk-secret')
    expect(memory.files.size).toBe(0)
  })
})
