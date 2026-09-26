import {
  AI_DEFAULT_BASE_URLS,
  applyPreferencesPatch,
  DEFAULT_PREFERENCES,
  type AiProvider,
  PreferencesPatchSchema,
  type HistoryRetentionDays,
  type NormalizedError,
  type Preferences,
  type PreferencesPatch,
  type ThemePreference,
} from '@strata/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { usePreferencesApi } from '../api/use-preferences-api'
import { clampLimit, type ExecutionLimits } from '../model/execution-limits'

export type PreferencesLoadStatus = 'idle' | 'loading' | 'ready' | 'error'
export type PreferencesSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const INVALID_PATCH: NormalizedError = {
  code: 'validation_failed',
  message: 'The preferences are not valid',
  retryable: false,
}

const clone = (preferences: Preferences): Preferences => structuredClone(preferences)

/**
 * Preferencias del usuario, respaldadas por main (`window.db.preferences`, ADR 0009): se leen al arrancar
 * y cada cambio se aplica al momento en la interfaz y se guarda en segundo plano. Main revalida y es la
 * fuente de verdad: si guardar falla, la interfaz vuelve a lo último que main confirmó. Los cambios se
 * envían en orden, de uno en uno.
 */
export const usePreferencesStore = defineStore('preferences', () => {
  const api = usePreferencesApi()

  const values = ref<Preferences>(clone(DEFAULT_PREFERENCES))
  // `\timing`: solo de la sesión; el contrato de preferencias aún no lo guarda.
  const showTiming = ref(true)
  const status = ref<PreferencesLoadStatus>('idle')
  const saveStatus = ref<PreferencesSaveStatus>('idle')
  const error = ref<NormalizedError | null>(null)

  const confirmDestructive = computed(() => values.value.execution.confirmDestructive)
  const timeoutSeconds = computed(() => values.value.execution.timeoutSeconds)
  const maxRows = computed(() => values.value.execution.maxRows)
  const theme = computed(() => values.value.appearance.theme)
  const historyEnabled = computed(() => values.value.history.enabled)
  const historyRetentionDays = computed(() => values.value.history.retentionDays)
  const ai = computed(() => values.value.ai)

  // Último estado que main confirmó; a él se vuelve cuando un guardado falla.
  let confirmed = clone(DEFAULT_PREFERENCES)
  let tail: Promise<void> = Promise.resolve()
  let pending = 0

  function settle(): void {
    pending -= 1
    if (pending === 0) values.value = clone(confirmed)
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    pending += 1
    const result = tail.then(job)
    tail = result.then(settle, settle)
    return result
  }

  /** Lee las preferencias guardadas; si falla se conservan los valores por defecto y `status` pasa a `error`. */
  function load(): Promise<boolean> {
    if (status.value !== 'ready') status.value = 'loading'
    return enqueue(async () => {
      const result = await api.get()
      if (!result.ok) {
        if (status.value !== 'ready') status.value = 'error'
        error.value = result.error
        return false
      }
      confirmed = result.data
      status.value = 'ready'
      error.value = null
      return true
    })
  }

  /** Aplica un parche parcial: `false` si no es válido (no llega a main) o si main no pudo guardarlo. */
  async function update(patch: PreferencesPatch): Promise<boolean> {
    const parsed = PreferencesPatchSchema.safeParse(patch)
    if (!parsed.success) {
      saveStatus.value = 'error'
      error.value = INVALID_PATCH
      return false
    }

    const next = applyPreferencesPatch(values.value, parsed.data)
    if (
      status.value === 'ready' &&
      pending === 0 &&
      JSON.stringify(next) === JSON.stringify(values.value)
    ) {
      return true
    }
    values.value = next
    saveStatus.value = 'saving'

    return enqueue(async () => {
      const result = await api.update(parsed.data)
      if (!result.ok) {
        saveStatus.value = 'error'
        error.value = result.error
        return false
      }
      confirmed = result.data
      status.value = 'ready'
      error.value = null
      if (pending === 1) saveStatus.value = 'saved'
      return true
    })
  }

  /** Olvida el resultado del último guardado (al abrir o cerrar la pantalla de ajustes). */
  function dismissFeedback(): void {
    saveStatus.value = 'idle'
    if (status.value === 'ready') error.value = null
  }

  const setConfirmDestructive = (value: boolean) =>
    update({ execution: { confirmDestructive: value } })

  const setExecutionLimits = (limits: ExecutionLimits) =>
    update({
      execution: {
        timeoutSeconds: clampLimit('timeoutSeconds', limits.timeoutSeconds),
        maxRows: clampLimit('maxRows', limits.maxRows),
      },
    })

  const setTheme = (value: ThemePreference) => update({ appearance: { theme: value } })

  const setHistoryEnabled = (value: boolean) => update({ history: { enabled: value } })

  const setHistoryRetentionDays = (value: HistoryRetentionDays) =>
    update({ history: { retentionDays: value } })

  const setAiEnabled = (value: boolean) => update({ ai: { enabled: value } })

  /** Cada proveedor escucha en su propio puerto: al cambiar se propone su dirección por defecto. */
  const setAiProvider = (provider: AiProvider) =>
    update({ ai: { provider, baseUrl: AI_DEFAULT_BASE_URLS[provider] } })

  const setAiBaseUrl = (value: string) => update({ ai: { baseUrl: value } })

  const setAiModel = (value: string) => update({ ai: { model: value } })

  function setShowTiming(value: boolean): void {
    showTiming.value = value
  }

  return {
    /** Preferencias completas tal como se ven ahora (incluye lo aplicado y aún sin confirmar). */
    values,
    confirmDestructive,
    timeoutSeconds,
    maxRows,
    theme,
    historyEnabled,
    historyRetentionDays,
    ai,
    showTiming,
    status,
    saveStatus,
    error,
    load,
    update,
    dismissFeedback,
    setConfirmDestructive,
    setExecutionLimits,
    setTheme,
    setHistoryEnabled,
    setHistoryRetentionDays,
    setAiEnabled,
    setAiProvider,
    setAiBaseUrl,
    setAiModel,
    setShowTiming,
  }
})
