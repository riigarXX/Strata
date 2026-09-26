// @vitest-environment node
import { IPC_CHANNELS, type HistoryChange, type HistoryEntry } from '@strata/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createAppOrigin } from '../security/app-origin'
import { createMemoryStorage } from '../services/local-storage/testing'
import { createHistoryStore } from '../services/history-store'
import { entryAt, HISTORY_PATH, NOW } from '../services/history-store/testing'
import { publishHistoryChanges, type HistoryEventWindow } from './history-events'

const ENTRY_URL = 'app://strata/index.html'
const appOrigin = createAppOrigin()

const entry: HistoryEntry = { id: 'h1', ...entryAt(NOW) }

function fakeWindow(url = ENTRY_URL) {
  const state = { destroyed: false, throwOnSend: false, url }
  const send = vi.fn<HistoryEventWindow['webContents']['send']>(() => {
    if (state.throwOnSend) throw new Error('Object has been destroyed')
  })
  const window: HistoryEventWindow = {
    webContents: {
      send,
      isDestroyed: () => state.destroyed,
      get mainFrame() {
        return { url: state.url }
      },
    },
  }
  return { window, send, state }
}

function fakeStore() {
  let listener: ((change: HistoryChange) => void) | undefined
  const unsubscribe = vi.fn()
  return {
    store: {
      subscribe: vi.fn((next: (change: HistoryChange) => void) => {
        listener = next
        return unsubscribe
      }),
    },
    emit: (change: HistoryChange) => listener?.(change),
    unsubscribe,
  }
}

describe('publishHistoryChanges', () => {
  it('envía cada cambio por el canal del catálogo solo a la ventana principal', () => {
    const { window, send } = fakeWindow()
    const { store, emit } = fakeStore()
    publishHistoryChanges({ historyStore: store, getMainWindow: () => window, appOrigin })

    emit({ type: 'added', entry, requestId: 'r1' })
    emit({ type: 'removed', id: 'h1' })
    emit({ type: 'cleared' })
    emit({ type: 'purged' })

    expect(send.mock.calls).toEqual([
      [IPC_CHANNELS.history.changed, { type: 'added', entry, requestId: 'r1' }],
      [IPC_CHANNELS.history.changed, { type: 'removed', id: 'h1' }],
      [IPC_CHANNELS.history.changed, { type: 'cleared' }],
      [IPC_CHANNELS.history.changed, { type: 'purged' }],
    ])
  })

  it('no envía nada sin ventana principal o con la ventana destruida', () => {
    const { window, send, state } = fakeWindow()
    const { store, emit } = fakeStore()
    let current: HistoryEventWindow | null = null
    publishHistoryChanges({ historyStore: store, getMainWindow: () => current, appOrigin })

    emit({ type: 'cleared' })
    current = window
    state.destroyed = true
    emit({ type: 'cleared' })

    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['un origen externo', 'https://evil.example.com/'],
    ['about:blank', 'about:blank'],
    ['otra ruta file:', 'file:///etc/passwd'],
    ['app:// de otro host', 'app://evil/index.html'],
    ['data:', 'data:text/html,<script>1</script>'],
  ])('no envía el SQL si el frame principal navegó a %s', (_name, url) => {
    const { window, send } = fakeWindow(url)
    const { store, emit } = fakeStore()
    publishHistoryChanges({ historyStore: store, getMainWindow: () => window, appOrigin })

    emit({ type: 'added', entry })

    expect(send).not.toHaveBeenCalled()
  })

  it('no envía un payload que no cumple el contrato', () => {
    const { window, send } = fakeWindow()
    const { store, emit } = fakeStore()
    publishHistoryChanges({ historyStore: store, getMainWindow: () => window, appOrigin })

    emit({ type: 'added', entry: { ...entry, status: 'weird' } } as unknown as HistoryChange)
    emit({ type: 'added', entry, extra: 1 } as unknown as HistoryChange)

    expect(send).not.toHaveBeenCalled()
  })

  it('un envío que falla no propaga el error al almacén', () => {
    const { window, state } = fakeWindow()
    state.throwOnSend = true
    const { store, emit } = fakeStore()
    publishHistoryChanges({ historyStore: store, getMainWindow: () => window, appOrigin })

    expect(() => emit({ type: 'cleared' })).not.toThrow()
  })

  it('devuelve la desuscripción del almacén', () => {
    const { store, unsubscribe } = fakeStore()

    const stop = publishHistoryChanges({
      historyStore: store,
      getMainWindow: () => null,
      appOrigin,
    })
    stop()

    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('de extremo a extremo con el almacén real: alta, borrado y vaciado llegan a la ventana', async () => {
    const memory = createMemoryStorage()
    const store = createHistoryStore({
      fileSystem: memory.fileSystem,
      filePath: HISTORY_PATH,
      getRetentionDays: async () => 30,
      createId: () => 'h-real',
    })
    const { window, send } = fakeWindow()
    publishHistoryChanges({ historyStore: store, getMainWindow: () => window, appOrigin })

    await store.add(entryAt(NOW), { requestId: 'r9' })
    await store.delete('h-real')
    await store.add(entryAt(NOW))
    await store.clear()

    expect(send.mock.calls.map(([, payload]) => (payload as HistoryChange).type)).toEqual([
      'added',
      'removed',
      'added',
      'cleared',
    ])
    expect(send.mock.calls[0]?.[1]).toMatchObject({ requestId: 'r9' })
  })
})
