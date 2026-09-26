import type { ErrorCode } from '@strata/contracts'
import { AdapterError, createNormalizedError } from '@strata/db-core'

/**
 * Los mensajes son fijos: nada de lo que dijo el servidor del modelo (ni la pregunta, ni el SQL) llega a un error.
 * `createNormalizedError` además redacta direcciones IP y URL por si alguna se colara.
 */
export function aiError(code: ErrorCode, message: string, retryable?: boolean): AdapterError {
  return new AdapterError(
    createNormalizedError(code, message, retryable === undefined ? {} : { retryable }),
  )
}
