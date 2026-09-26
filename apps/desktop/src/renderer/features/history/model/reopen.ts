/**
 * Cómo quedó la pestaña respecto a la conexión de la entrada: `linked` con la sesión abierta del perfil,
 * `disconnected` si el perfil existe pero no está conectado (queda seleccionado: la sesión que se abra a
 * continuación se asocia a la pestaña activa) y `missing` si el perfil ya no existe.
 */
export type ReopenOutcome = 'linked' | 'disconnected' | 'missing'

const OUTCOME_HINTS: Record<ReopenOutcome, string> = {
  linked: '',
  disconnected: ' Su conexión no está abierta: conéctala para ejecutarla.',
  missing: ' La conexión original ya no existe.',
}

export function describeReopen(outcome: ReopenOutcome): string {
  return `Consulta reabierta en una pestaña nueva; no se ha ejecutado.${OUTCOME_HINTS[outcome]}`
}
