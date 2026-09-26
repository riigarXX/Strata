// Primero: Zod decide su modo al construir los schemas (ver zod-jitless.ts).
import '@strata/contracts/zod-jitless'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { createDbApi } from './db-api'

contextBridge.exposeInMainWorld(
  'db',
  createDbApi(
    (channel, payload) => ipcRenderer.invoke(channel, payload),
    (channel, listener) => {
      const handler = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
  ),
)
