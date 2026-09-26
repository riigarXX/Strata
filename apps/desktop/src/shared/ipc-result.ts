import type { NormalizedError } from '@strata/contracts'

/**
 * Sobre de respuesta de todos los canales IPC. Un `throw` en un handler cruza IPC como un `Error`
 * con texto opaco de Electron; el sobre garantiza que el renderer solo reciba `NormalizedError`.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: NormalizedError }

export function ipcOk<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function ipcFail(error: NormalizedError): IpcResult<never> {
  return { ok: false, error }
}
