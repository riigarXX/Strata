import { EXECUTION_PREFERENCE_LIMITS } from '@strata/contracts'

/**
 * Límites de ejecución que el usuario puede pedir: los mismos del contrato de preferencias, que reflejan
 * los topes duros de main (`QUERY_LIMITS`). Main recorta por su cuenta lo que se le pida; esto solo evita pedir de más.
 */
export const EXECUTION_LIMITS = EXECUTION_PREFERENCE_LIMITS

export type LimitField = keyof typeof EXECUTION_LIMITS

export interface ExecutionLimits {
  timeoutSeconds: number
  maxRows: number
}

export type ParsedLimit = { ok: true; value: number } | { ok: false; error: string }

const formatInteger = (value: number): string => value.toLocaleString('es-ES')

/** Un entero decimal sin signo dentro del rango del campo; cualquier otra cosa se rechaza con un texto claro. */
export function parseLimit(field: LimitField, raw: string): ParsedLimit {
  const { min, max } = EXECUTION_LIMITS[field]
  const text = raw.trim()
  const value = /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN
  if (Number.isInteger(value) && value >= min && value <= max) return { ok: true, value }
  return {
    ok: false,
    error: `Introduce un número entero entre ${formatInteger(min)} y ${formatInteger(max)}.`,
  }
}

/** Fuerza un valor a un entero dentro del rango del campo (para valores que no pasan por el formulario). */
export function clampLimit(field: LimitField, value: number): number {
  const { default: fallback, min, max } = EXECUTION_LIMITS[field]
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
