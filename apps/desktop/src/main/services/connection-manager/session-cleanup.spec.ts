// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { closeSessionsOnQuit } from './session-cleanup'

function setup(hasActiveSessions: boolean) {
  const emitter = new EventEmitter()
  const app = {
    on: (event: 'before-quit', listener: (event: { preventDefault(): void }) => void) =>
      emitter.on(event, listener),
    quit: vi.fn(() => emitter.emit('before-quit', { preventDefault: vi.fn() })),
  }
  let resolveClose: () => void = () => {}
  const connectionManager = {
    hasActiveSessions: () => hasActiveSessions,
    closeAll: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve
        }),
    ),
  }
  closeSessionsOnQuit(app, connectionManager)
  return { emitter, app, connectionManager, finishClose: () => resolveClose() }
}

describe('closeSessionsOnQuit', () => {
  it('aplaza la salida, cierra las sesiones y vuelve a salir al terminar', async () => {
    const { emitter, app, connectionManager, finishClose } = setup(true)
    const event = { preventDefault: vi.fn() }

    emitter.emit('before-quit', event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(connectionManager.closeAll).toHaveBeenCalledOnce()
    expect(app.quit).not.toHaveBeenCalled()

    finishClose()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    expect(connectionManager.closeAll).toHaveBeenCalledOnce()
  })

  it('no interfiere con la salida cuando no hay sesiones activas', () => {
    const { emitter, connectionManager } = setup(false)
    const event = { preventDefault: vi.fn() }

    emitter.emit('before-quit', event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(connectionManager.closeAll).not.toHaveBeenCalled()
  })
})
