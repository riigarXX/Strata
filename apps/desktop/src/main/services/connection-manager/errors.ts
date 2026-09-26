import type { ErrorCode, NormalizedError } from '@strata/contracts'
import {
  AdapterError,
  createNormalizedError,
  normalizeUnknownError,
  redactionContextFromProfile,
  type RedactionContext,
  type ResolvedConnectionProfile,
} from '@strata/db-core'
import { CredentialStoreError, type CredentialStoreErrorCode } from '../credential-store'
import { ProfileStoreError } from './profile-store'

export function managerError(code: ErrorCode, message: string, retryable?: boolean): AdapterError {
  return new AdapterError(
    createNormalizedError(code, message, retryable === undefined ? {} : { retryable }),
  )
}

const CREDENTIAL_ERROR_MESSAGES: Record<CredentialStoreErrorCode, string> = {
  ENCRYPTION_UNAVAILABLE: 'Secure credential storage is not available on this system',
  INVALID_INPUT: 'The credential is not valid',
  DECRYPT_FAILED: 'The saved password could not be read',
  STORAGE_FAILED: 'Could not access the credential storage',
}

/**
 * Convierte cualquier fallo en un `NormalizedError`. Nunca lee el mensaje de una causa desconocida y,
 * si se conoce el perfil, vuelve a redactar host, usuario, ruta y password (defensa en profundidad
 * frente a adapters que no lo hayan hecho).
 */
export function toNormalizedError(
  reason: unknown,
  profile?: ResolvedConnectionProfile,
): NormalizedError {
  let normalized: NormalizedError
  if (reason instanceof CredentialStoreError) {
    normalized = createNormalizedError('internal_error', CREDENTIAL_ERROR_MESSAGES[reason.code])
  } else if (reason instanceof ProfileStoreError) {
    normalized = createNormalizedError('internal_error', 'Could not access the saved connections')
  } else {
    normalized = normalizeUnknownError(reason)
  }

  if (!profile) return normalized
  return redactNormalizedError(normalized, redactionContextFromProfile(profile))
}

export function redactNormalizedError(
  error: NormalizedError,
  context: RedactionContext,
): NormalizedError {
  return createNormalizedError(error.code, error.message, { retryable: error.retryable, context })
}

export function toAdapterError(reason: unknown, profile?: ResolvedConnectionProfile): AdapterError {
  return new AdapterError(toNormalizedError(reason, profile))
}
