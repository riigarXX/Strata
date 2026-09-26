import { IPC_CHANNELS, type QueryEvent } from '@strata/contracts'
import type { QueryEventSink } from '../services/query-executor'

export interface NavigationDetails {
  isMainFrame: boolean
  isSameDocument: boolean
}

/** Lo mínimo de `WebContents` que usa el sink; `WebContents` real lo cumple y los tests usan un `EventEmitter`. */
export interface EventTargetWebContents {
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
  on(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown
  on(event: 'did-start-navigation', listener: (details: NavigationDetails) => void): unknown
  removeListener(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown
  removeListener(
    event: 'did-start-navigation',
    listener: (details: NavigationDetails) => void,
  ): unknown
}

/**
 * Los eventos van solo al `webContents` que pidió la ejecución. Una recarga (navegación del frame principal a
 * otro documento), un fallo del proceso de renderizado o su destrucción hacen que el renderer pierda su
 * estado: en los tres casos la ejecución ya no tiene destinatario.
 */
export function createWebContentsSink(webContents: EventTargetWebContents): QueryEventSink {
  return {
    owner: webContents,
    isAlive: () => !webContents.isDestroyed(),
    send(event: QueryEvent) {
      if (webContents.isDestroyed()) return
      try {
        webContents.send(IPC_CHANNELS.query.event, event)
      } catch {
        // Un envío fallido equivale a un destinatario ausente: el executor lo detecta con `isAlive` o al recibir `onGone`.
      }
    },
    onGone(listener) {
      const onNavigation = (details: NavigationDetails): void => {
        if (details.isMainFrame && !details.isSameDocument) listener()
      }
      webContents.on('destroyed', listener)
      webContents.on('render-process-gone', listener)
      webContents.on('did-start-navigation', onNavigation)
      return () => {
        webContents.removeListener('destroyed', listener)
        webContents.removeListener('render-process-gone', listener)
        webContents.removeListener('did-start-navigation', onNavigation)
      }
    },
  }
}
