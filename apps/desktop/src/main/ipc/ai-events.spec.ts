// @vitest-environment node
import { IPC_CHANNELS, type AiPullProgress } from '@strata/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createAppOrigin } from '../security/app-origin'
import { publishAiProgress } from './ai-events'
import type { HistoryEventWindow } from './history-events'

const ENTRY_URL = 'app://strata/index.html'
const appOrigin = createAppOrigin()

const progress: AiPullProgress = {
  requestId: 'r1',
  model: 'qwen3:14b',
  status: 'pulling abc',
  completed: 5,
  total: 10,
}

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

function fakeService() {
  let listener: ((progress: AiPullProgress) => void) | undefined
  const unsubscribe = vi.fn()
  return {
    aiService: {
      subscribePullProgress: vi.fn((next: (progress: AiPullProgress) => void) => {
        listener = next
        return unsubscribe
      }),
    },
    emit: (value: unknown) => listener?.(value as AiPullProgress),
    unsubscribe,
  }
}

describe('publishAiProgress', () => {
  it('envía el avance por el canal del catálogo solo a la ventana principal', () => {
    const { window, send } = fakeWindow()
    const { aiService, emit } = fakeService()
    publishAiProgress({ aiService, getMainWindow: () => window, appOrigin })

    emit(progress)

    expect(send.mock.calls).toEqual([[IPC_CHANNELS.ai.pullProgress, progress]])
  })

  it('no envía nada sin ventana, con la ventana destruida o con el frame fuera del origen de la app', () => {
    const { window, send, state } = fakeWindow()
    const { aiService, emit } = fakeService()
    let current: HistoryEventWindow | null = null
    publishAiProgress({ aiService, getMainWindow: () => current, appOrigin })

    emit(progress)
    current = window
    state.destroyed = true
    emit(progress)
    state.destroyed = false
    for (const url of [
      'https://evil.example.com/',
      'file:///etc/passwd',
      'app://strata/other',
      'about:blank',
    ]) {
      state.url = url
      emit(progress)
    }

    expect(send).not.toHaveBeenCalled()
  })

  it('valida el payload antes de enviarlo: un avance con campos de más o inválido no sale', () => {
    const { window, send } = fakeWindow()
    const { aiService, emit } = fakeService()
    publishAiProgress({ aiService, getMainWindow: () => window, appOrigin })

    emit({ ...progress, extra: 'x' })
    emit({ ...progress, completed: -1 })
    emit({ ...progress, model: 'has space' })

    expect(send).not.toHaveBeenCalled()
  })

  it('un envío que falla a mitad no propaga el error', () => {
    const { window, state } = fakeWindow()
    const { aiService, emit } = fakeService()
    publishAiProgress({ aiService, getMainWindow: () => window, appOrigin })
    state.throwOnSend = true

    expect(() => emit(progress)).not.toThrow()
  })

  it('devuelve la desuscripción del servicio', () => {
    const { window } = fakeWindow()
    const { aiService, unsubscribe } = fakeService()

    publishAiProgress({ aiService, getMainWindow: () => window, appOrigin })()

    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
