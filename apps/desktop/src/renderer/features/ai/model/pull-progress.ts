import type { AiPullProgress } from '@strata/contracts'

export type PullStage = 'preparing' | 'downloading' | 'verifying' | 'finishing'

export interface PullLayer {
  completed: number
  total: number
}

/**
 * Avance agregado de una descarga. Ollama descarga varias capas (el modelo y unos pocos archivos pequeños) y
 * cada línea de avance trae los bytes de la suya: mostrarlas tal cual haría saltar la barra de 100 % a 0 % con
 * cada capa. Aquí se suman todas las vistas hasta el momento y el porcentaje nunca retrocede.
 */
export interface PullProgressState {
  readonly stage: PullStage
  readonly layers: Readonly<Record<string, PullLayer>>
  readonly completed: number
  /** `null` mientras el servidor no ha dicho cuánto pesa (solo hay manifiesto). */
  readonly total: number | null
  /** Entero de 0 a 100, o `null` (indeterminado) hasta conocer el total. */
  readonly percent: number | null
}

export const INITIAL_PULL_PROGRESS: PullProgressState = {
  stage: 'preparing',
  layers: {},
  completed: 0,
  total: null,
  percent: null,
}

// Un modelo son unas pocas capas; el tope evita que un servidor que se desboque haga crecer la memoria.
const MAX_LAYERS = 64

function stageOf(status: string, previous: PullStage): PullStage {
  if (status === 'pulling manifest') return 'preparing'
  if (status.startsWith('pulling ')) return 'downloading'
  if (status.startsWith('verifying')) return 'verifying'
  if (status === 'writing manifest' || status === 'success' || status.startsWith('removing')) {
    return 'finishing'
  }
  return previous
}

export function advancePullProgress(
  state: PullProgressState,
  event: Pick<AiPullProgress, 'status' | 'completed' | 'total'>,
): PullProgressState {
  const stage = stageOf(event.status, state.stage)
  let layers = state.layers
  if (
    event.total !== null &&
    event.total > 0 &&
    event.completed !== null &&
    (event.status in layers || Object.keys(layers).length < MAX_LAYERS)
  ) {
    layers = {
      ...layers,
      [event.status]: { completed: Math.min(event.completed, event.total), total: event.total },
    }
  }

  const values = Object.values(layers)
  const total = values.reduce((sum, layer) => sum + layer.total, 0)
  if (total === 0) return { ...state, stage, layers }

  const completed = Math.max(
    state.completed,
    values.reduce((sum, layer) => sum + layer.completed, 0),
  )
  const percent = Math.max(state.percent ?? 0, Math.min(100, Math.floor((completed * 100) / total)))
  return { stage, layers, completed, total, percent }
}
