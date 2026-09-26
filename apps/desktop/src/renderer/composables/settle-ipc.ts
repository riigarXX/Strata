import { NormalizedErrorSchema, type NormalizedError } from '@strata/contracts'
import { ipcFail, ipcOk, type IpcResult } from '../../shared/ipc-result'

// Mensaje propio del renderer: nunca se interpola el texto de una excepción desconocida.
export const UNEXPECTED_ERROR: NormalizedError = {
  code: 'internal_error',
  message: 'Something went wrong while talking to the application. Try again.',
  retryable: true,
}

// Cualquier cosa que cruza IPC se trata como no confiable (threat-model.md): se revalida el sobre y la carga.
export interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

export const acceptAnything: Parser<void> = {
  safeParse: () => ({ success: true, data: undefined }),
}

/** Ejecuta una llamada IPC sin lanzar: excepciones y respuestas malformadas pasan a ser un `NormalizedError`. */
export async function settleIpc<T>(
  call: () => Promise<unknown>,
  payload: Parser<T>,
): Promise<IpcResult<T>> {
  try {
    const envelope = await call()
    if (typeof envelope !== 'object' || envelope === null || !('ok' in envelope)) {
      return ipcFail(UNEXPECTED_ERROR)
    }
    if (envelope.ok === true) {
      const parsed = payload.safeParse('data' in envelope ? envelope.data : undefined)
      return parsed.success ? ipcOk(parsed.data) : ipcFail(UNEXPECTED_ERROR)
    }
    if (envelope.ok === false && 'error' in envelope) {
      const parsed = NormalizedErrorSchema.safeParse(envelope.error)
      return ipcFail(parsed.success ? parsed.data : UNEXPECTED_ERROR)
    }
    return ipcFail(UNEXPECTED_ERROR)
  } catch {
    return ipcFail(UNEXPECTED_ERROR)
  }
}
