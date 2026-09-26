export interface PaneLimits {
  min: number
  max: number
}

export function clampSize(value: number, { min, max }: PaneLimits): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Límites de un panel redimensionable: el máximo absoluto se recorta para dejar `reserved` px al
 * resto del layout. Con `available === 0` (aún sin medir) solo rige el máximo absoluto.
 */
export function paneLimits(
  bounds: { min: number; max: number },
  available: number,
  reserved: number,
): PaneLimits {
  const room = available > 0 ? available - reserved : bounds.max
  return { min: bounds.min, max: Math.max(bounds.min, Math.min(bounds.max, room)) }
}
