import {
  normalizeAiBaseUrl,
  type AiModelInfo,
  type AiProvider,
  type AiProviderStatus,
  type AiPullProgress,
  type NormalizedError,
} from '@strata/contracts'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { IpcResult } from '../../../../shared/ipc-result'
import { useAiApi } from '../api/use-ai-api'
import {
  advancePullProgress,
  INITIAL_PULL_PROGRESS,
  type PullProgressState,
} from '../model/pull-progress'

/** Servidor al que apuntan las comprobaciones: se pasa explícito para no depender de lo que main haya guardado ya. */
export interface AiTarget {
  provider: AiProvider
  baseUrl: string
}

export type AiConnection =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'reachable'; version: string | null }
  | { phase: 'unreachable' }
  | { phase: 'error'; error: NormalizedError }

export type AiModelsStatus = 'idle' | 'loading' | 'ready' | 'error'

export type AiPullPhase = 'idle' | 'running' | 'cancelling' | 'done' | 'cancelled' | 'error'

export interface AiPull {
  phase: AiPullPhase
  model: string | null
  requestId: string | null
  progress: PullProgressState
  error: NormalizedError | null
}

const IDLE_PULL: AiPull = {
  phase: 'idle',
  model: null,
  requestId: null,
  progress: INITIAL_PULL_PROGRESS,
  error: null,
}

const sameTarget = (a: AiTarget | null, b: AiTarget): boolean =>
  a !== null && a.provider === b.provider && a.baseUrl === b.baseUrl

/**
 * Lo que la pantalla de ajustes sabe del servidor de modelos local (ADR 0012): si responde, qué modelos tiene
 * y cómo va la descarga del recomendado. Todo sale de `window.db.ai`; aquí no hay SQL ni datos de la base de
 * datos. Es estado de la sesión de la interfaz: nada se guarda, main es la fuente de verdad.
 */
export const useAiStore = defineStore('ai', () => {
  const api = useAiApi()

  const connection = ref<AiConnection>({ phase: 'idle' })
  const checkedTarget = ref<AiTarget | null>(null)
  /** Otros servidores que main ha encontrado en los puertos por defecto (Ollama, LM Studio). */
  const detected = ref<AiProviderStatus[]>([])
  const models = ref<AiModelInfo[]>([])
  const modelsStatus = ref<AiModelsStatus>('idle')
  const modelsError = ref<NormalizedError | null>(null)
  const pull = ref<AiPull>({ ...IDLE_PULL })

  // Cada comprobación invalida las respuestas en vuelo: una respuesta tardía nunca pisa una más nueva.
  let checkRun = 0
  let listRun = 0
  let unsubscribe: (() => void) | undefined

  function applyModels(result: IpcResult<AiModelInfo[]>): void {
    if (result.ok) {
      models.value = result.data
      modelsStatus.value = 'ready'
      modelsError.value = null
    } else {
      modelsStatus.value = 'error'
      modelsError.value = result.error
    }
  }

  /** «Probar conexión»: sondea los servidores por defecto y pide los modelos del indicado. Nunca lanza. */
  async function check(target: AiTarget): Promise<void> {
    checkRun += 1
    listRun += 1
    const run = checkRun
    if (!sameTarget(checkedTarget.value, target)) models.value = []
    checkedTarget.value = target
    connection.value = { phase: 'checking' }
    modelsStatus.value = 'loading'
    modelsError.value = null

    const [status, list] = await Promise.all([api.status(), api.listModels(target)])
    if (run !== checkRun) return

    detected.value = status.ok ? status.data.providers : []
    const wanted = normalizeAiBaseUrl(target.baseUrl) ?? target.baseUrl
    const entry = detected.value.find(
      (candidate) => candidate.provider === target.provider && candidate.baseUrl === wanted,
    )

    if (entry?.reachable === false) {
      models.value = []
      modelsStatus.value = 'idle'
      connection.value = { phase: 'unreachable' }
      return
    }
    if (entry) {
      connection.value = { phase: 'reachable', version: entry.version }
      applyModels(list)
      return
    }
    // main no sondeó esa dirección (aún no guardada): lo que dijo `listModels` es lo único que se sabe.
    if (list.ok) {
      connection.value = { phase: 'reachable', version: null }
      applyModels(list)
      return
    }
    models.value = []
    modelsStatus.value = 'idle'
    connection.value =
      list.error.code === 'connection_failed' || list.error.code === 'timeout'
        ? { phase: 'unreachable' }
        : { phase: 'error', error: list.error }
  }

  /** Solo la lista de modelos (p. ej. al terminar una descarga); no toca el estado de la conexión. */
  async function refreshModels(target: AiTarget): Promise<void> {
    listRun += 1
    const run = listRun
    modelsStatus.value = 'loading'
    const result = await api.listModels(target)
    if (run !== listRun) return
    applyModels(result)
  }

  /** Olvida lo comprobado (se cambió de servidor o se desactivó la IA): lo anterior ya no describe el nuevo estado. */
  function reset(): void {
    checkRun += 1
    listRun += 1
    checkedTarget.value = null
    connection.value = { phase: 'idle' }
    detected.value = []
    models.value = []
    modelsStatus.value = 'idle'
    modelsError.value = null
  }

  function onProgress(event: AiPullProgress): void {
    const current = pull.value
    if (current.phase !== 'running' && current.phase !== 'cancelling') return
    if (event.requestId !== current.requestId) return
    pull.value = { ...current, progress: advancePullProgress(current.progress, event) }
  }

  /**
   * Escucha el avance de las descargas. Solo debe estar activa mientras la pantalla de ajustes está abierta;
   * la descarga en sí sigue en main aunque se cierre, y su resultado se recoge igualmente.
   */
  function attach(): void {
    if (unsubscribe) return
    unsubscribe = api.onPullProgress(onProgress)
  }

  function detach(): void {
    unsubscribe?.()
    unsubscribe = undefined
  }

  /** `true` si la descarga terminó bien. Main solo descarga con el proveedor y la dirección guardados. */
  async function startPull(model: string, target: AiTarget): Promise<boolean> {
    if (pull.value.phase === 'running' || pull.value.phase === 'cancelling') return false
    const requestId = crypto.randomUUID()
    pull.value = { ...IDLE_PULL, phase: 'running', model, requestId }

    const result = await api.pullModel({ requestId, model })
    if (pull.value.requestId !== requestId) return false

    if (!result.ok) {
      pull.value = {
        ...pull.value,
        phase: result.error.code === 'cancelled' ? 'cancelled' : 'error',
        error: result.error,
      }
      return false
    }
    pull.value = { ...pull.value, phase: 'done', error: null }
    await refreshModels(target)
    return true
  }

  async function cancelPull(): Promise<void> {
    const current = pull.value
    if (current.phase !== 'running' || current.requestId === null) return
    pull.value = { ...current, phase: 'cancelling' }
    const result = await api.cancel({ requestId: current.requestId })
    // Si la petición de cancelar no llegó, la descarga sigue y el usuario puede volver a intentarlo.
    if (
      !result.ok &&
      pull.value.requestId === current.requestId &&
      pull.value.phase === 'cancelling'
    ) {
      pull.value = { ...pull.value, phase: 'running' }
    }
  }

  /** Al abrir los ajustes no se arrastra el resultado de una descarga anterior (terminada, cancelada o fallida). */
  function clearFinishedPull(): void {
    const { phase } = pull.value
    if (phase === 'done' || phase === 'cancelled' || phase === 'error')
      pull.value = { ...IDLE_PULL }
  }

  return {
    connection,
    checkedTarget,
    detected,
    models,
    modelsStatus,
    modelsError,
    pull,
    check,
    refreshModels,
    reset,
    attach,
    detach,
    startPull,
    cancelPull,
    clearFinishedPull,
  }
})
