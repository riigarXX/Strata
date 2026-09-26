import type { QueryRequest } from '@strata/contracts'

/**
 * Valores por defecto y topes duros de una ejecución. El renderer no es de confianza: lo que pide en el
 * `QueryRequest` solo puede bajar de estos topes, nunca superarlos.
 */
export const QUERY_LIMITS = {
  maxRows: { default: 10_000, max: 100_000 },
  timeoutMs: { default: 30_000, max: 300_000 },
  chunkSize: { default: 500, max: 1_000 },
  /** Chunks enviados y aún sin confirmar con `db:query:ack` antes de dejar de consumir del adapter. */
  chunkWindow: 4,
  /** Sin confirmaciones durante este tiempo con la ventana llena, la ejecución se cancela. */
  ackTimeoutMs: 30_000,
  /** Espera máxima a que una ejecución cancelada termine antes de cerrar su sesión. */
  cancelGraceMs: 5_000,
} as const

export interface ResolvedLimits {
  readonly maxRows: number
  readonly timeoutMs: number
  readonly chunkSize: number
}

function clamp(
  requested: number | undefined,
  {
    default: fallback,
    max,
  }: {
    default: number
    max: number
  },
): number {
  return Math.min(requested ?? fallback, max)
}

export function resolveQueryLimits(
  request: Pick<QueryRequest, 'maxRows' | 'timeoutMs' | 'chunkSize'>,
): ResolvedLimits {
  return {
    maxRows: clamp(request.maxRows, QUERY_LIMITS.maxRows),
    timeoutMs: clamp(request.timeoutMs, QUERY_LIMITS.timeoutMs),
    chunkSize: clamp(request.chunkSize, QUERY_LIMITS.chunkSize),
  }
}
