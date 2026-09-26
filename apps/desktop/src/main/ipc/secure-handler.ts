import {
  createNormalizedError,
  DEFAULT_ERROR_MESSAGES,
  normalizeUnknownError,
} from '@strata/db-core'
import { ipcFail, ipcOk, type IpcResult } from '../../shared/ipc-result'
import type { AppOrigin } from '../security/app-origin'
import { assertTrustedSender, type IpcSenderLike } from '../security/sender-validation'

export type IpcHandler<TEvent extends IpcSenderLike = IpcSenderLike> = (
  event: TEvent,
  payload: unknown,
) => Promise<IpcResult<unknown>>

// Contrato estructural mínimo de un schema de Zod: desktop no depende de zod directamente.
export interface InputSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

export interface OutputSchema {
  parse(value: unknown): unknown
}

export interface HandlerSpec<TInput, TEvent extends IpcSenderLike = IpcSenderLike> {
  input: InputSchema<TInput>
  output: OutputSchema
  /** El evento solo llega a `run` después de validar remitente y payload. */
  run(input: TInput, event: TEvent): Promise<unknown>
}

export const nothing: InputSchema<undefined> & OutputSchema = {
  safeParse: (value) =>
    value === undefined ? { success: true, data: undefined } : { success: false },
  parse(value) {
    if (value !== undefined) throw new TypeError('Expected no value')
    return undefined
  },
}

export function arrayOf(item: OutputSchema): OutputSchema {
  return {
    parse(value) {
      if (!Array.isArray(value)) throw new TypeError('Expected an array')
      return value.map((element) => item.parse(element))
    },
  }
}

export interface SecureHandlerDependencies {
  getMainWindow: () => { webContents: object } | null
  appOrigin: AppOrigin
}

/**
 * Envuelve la lógica de un canal con las tres barreras comunes (ADR 0008): remitente confiable,
 * revalidación del payload con el schema de contracts y respuesta validada dentro de un `IpcResult`.
 */
export function createSecureHandlerFactory({
  getMainWindow,
  appOrigin,
}: SecureHandlerDependencies): <TInput, TEvent extends IpcSenderLike = IpcSenderLike>(
  spec: HandlerSpec<TInput, TEvent>,
) => IpcHandler<TEvent> {
  return (spec) => async (event, payload) => {
    assertTrustedSender(event, getMainWindow()?.webContents ?? null, appOrigin)

    const input = spec.input.safeParse(payload)
    if (!input.success) {
      // Sin detalle del schema: los mensajes de Zod pueden citar valores enviados (p. ej. una password).
      return ipcFail(
        createNormalizedError('validation_failed', DEFAULT_ERROR_MESSAGES.validation_failed),
      )
    }

    try {
      return ipcOk(spec.output.parse(await spec.run(input.data, event)))
    } catch (reason) {
      return ipcFail(normalizeUnknownError(reason))
    }
  }
}
