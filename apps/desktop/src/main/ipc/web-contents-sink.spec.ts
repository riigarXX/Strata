// @vitest-environment node
import { EventEmitter } from 'node:events'
import { IPC_CHANNELS, type QueryEvent } from '@strata/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createWebContentsSink, type EventTargetWebContents } from './web-contents-sink'

function fakeWebContents() {
  const emitter = new EventEmitter()
  const state = { destroyed: false, throwOnSend: false }
  const send = vi.fn<EventTargetWebContents['send']>(() => {
    if (state.throwOnSend) throw new Error('Object has been destroyed')
  })
  const webContents = {
    send,
    isDestroyed: () => state.destroyed,
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) =>
      emitter.removeListener(event, listener),
  } as EventTargetWebContents
  return { webContents, emitter, send, state }
}

const done: QueryEvent = {
  type: 'done',
  requestId: 'r1',
  statementCount: 1,
  durationMs: 1,
  transaction: 'none',
}

describe('createWebContentsSink', () => {
  it('envía los eventos por el canal de eventos del catálogo, solo a ese webContents', () => {
    const { webContents, send } = fakeWebContents()
    const sink = createWebContentsSink(webContents)

    sink.send(done)

    expect(sink.owner).toBe(webContents)
    expect(send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.query.event, done)
  })

  it('no envía ni lanza si el webContents está destruido o el envío falla', () => {
    const { webContents, send, state } = fakeWebContents()
    const sink = createWebContentsSink(webContents)

    state.throwOnSend = true
    expect(() => sink.send(done)).not.toThrow()
    state.throwOnSend = false
    state.destroyed = true
    sink.send(done)

    expect(sink.isAlive()).toBe(false)
    expect(send).toHaveBeenCalledOnce()
  })

  it('avisa al destruirse, al caer el proceso de renderizado y al recargar la página', () => {
    const { webContents, emitter } = fakeWebContents()
    const sink = createWebContentsSink(webContents)
    const gone = vi.fn()
    sink.onGone(gone)

    emitter.emit('destroyed')
    emitter.emit('render-process-gone')
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })

    expect(gone).toHaveBeenCalledTimes(3)
  })

  it('ignora la navegación dentro del mismo documento y la de subframes', () => {
    const { webContents, emitter } = fakeWebContents()
    const gone = vi.fn()
    createWebContentsSink(webContents).onGone(gone)

    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    emitter.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })

    expect(gone).not.toHaveBeenCalled()
  })

  it('la desuscripción retira todos los listeners', () => {
    const { webContents, emitter } = fakeWebContents()
    const gone = vi.fn()
    const unsubscribe = createWebContentsSink(webContents).onGone(gone)

    unsubscribe()
    emitter.emit('destroyed')
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })

    expect(gone).not.toHaveBeenCalled()
    for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
      expect(emitter.listenerCount(event)).toBe(0)
    }
  })
})
