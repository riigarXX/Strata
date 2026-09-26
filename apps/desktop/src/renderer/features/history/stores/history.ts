import type {
  Engine,
  HistoryChange,
  HistoryDeleteResult,
  HistoryEntry,
  HistoryStatus,
  NormalizedError,
  ProfileId,
} from '@strata/contracts'
import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { ipcFail, type IpcResult } from '../../../../shared/ipc-result'
import { useHistoryApi } from '../api/use-history-api'
import {
  buildListRequest,
  dateRangeProblem,
  entryMatchesFilters,
  hasActiveFilters,
  NO_FILTERS,
  type HistoryFilters,
} from '../model/filters'

export type HistoryLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

const CLEAR_BUSY: NormalizedError = {
  code: 'busy',
  message: 'The history is already being cleared',
  retryable: true,
}

/** Espera tras la última pulsación antes de pedir la búsqueda a main. */
export const SEARCH_DEBOUNCE_MS = 250

/** Cada cuánto se recalculan las fechas relativas («hace 5 min») con el panel abierto. */
export const CLOCK_TICK_MS = 30_000

/**
 * Lista del historial de consultas (ADR 0005) tal como la entrega main por `window.db.history`: páginas
 * por cursor, con búsqueda y filtros que main aplica. Es una caché de sesión de solo lectura: main es la
 * fuente de verdad, así que tras cambiar un filtro o la retención se vuelve a pedir la primera página.
 * Con el panel abierto, los cambios que main empuja (`applyChange`) mantienen la lista al día sin recargarla.
 */
export const useHistoryStore = defineStore('history', () => {
  const api = useHistoryApi()

  const entries = ref<HistoryEntry[]>([])
  const nextCursor = ref<string | null>(null)
  const status = ref<HistoryLoadStatus>('idle')
  const error = ref<NormalizedError | null>(null)
  const loadingMore = ref(false)
  const moreError = ref<NormalizedError | null>(null)
  /** Fallo de la última operación de borrado; se olvida al empezar otra. */
  const actionError = ref<NormalizedError | null>(null)
  const clearing = ref(false)
  const filters = reactive<HistoryFilters>({ ...NO_FILTERS })
  /** Referencia de las fechas relativas: la última carga, entrada nueva o pulso del reloj con el panel abierto. */
  const now = ref(Date.now())
  /** Entradas nuevas que `applyChange` ha insertado en la lista; permite anunciarlas sin comparar listas. */
  const arrivals = ref(0)

  const filtered = computed(() => hasActiveFilters(filters))
  const dateProblem = computed(() => dateRangeProblem(filters))
  const hasMore = computed(() => nextCursor.value !== null)

  // Cada carga invalida las respuestas en vuelo: una página que llega tarde nunca pisa una lista más nueva.
  let generation = 0
  let debounce: ReturnType<typeof setTimeout> | undefined
  let clock: ReturnType<typeof setInterval> | undefined
  // Llegó un cambio mientras se cargaba la lista: esa respuesta puede no reflejarlo, así que se vuelve a pedir.
  let reloadAfterLoad = false

  function cancelDebounce(): void {
    clearTimeout(debounce)
    debounce = undefined
  }

  /** Pide la primera página con los filtros actuales y sustituye la lista. */
  async function load(): Promise<void> {
    cancelDebounce()
    generation += 1
    const mine = generation
    reloadAfterLoad = false
    // Un rango invertido no se pide a main: el panel explica el problema y conserva la lista anterior hasta que se corrija.
    if (dateProblem.value !== null) {
      loadingMore.value = false
      if (status.value === 'loading') status.value = 'ready'
      return
    }
    status.value = 'loading'
    error.value = null
    moreError.value = null
    loadingMore.value = false

    const result = await api.list(buildListRequest(filters))
    if (mine !== generation) return
    if (!result.ok) {
      entries.value = []
      nextCursor.value = null
      error.value = result.error
      status.value = 'error'
      return
    }
    entries.value = result.data.entries
    nextCursor.value = result.data.nextCursor
    now.value = Date.now()
    status.value = 'ready'
    if (reloadAfterLoad) void load()
  }

  /** Añade la página siguiente; un fallo conserva lo ya cargado y se puede reintentar. */
  async function loadMore(): Promise<void> {
    const cursor = nextCursor.value
    if (cursor === null || loadingMore.value || status.value !== 'ready') return
    const mine = generation
    loadingMore.value = true
    moreError.value = null

    const result = await api.list(buildListRequest(filters, cursor))
    if (mine !== generation) return
    loadingMore.value = false
    if (!result.ok) {
      moreError.value = result.error
      return
    }
    const known = new Set(entries.value.map((entry) => entry.id))
    entries.value.push(...result.data.entries.filter((entry) => !known.has(entry.id)))
    nextCursor.value = result.data.nextCursor
  }

  /** Actualiza el texto al momento y recarga cuando el usuario deja de teclear. */
  function setSearch(text: string): void {
    filters.search = text
    cancelDebounce()
    debounce = setTimeout(() => void load(), SEARCH_DEBOUNCE_MS)
  }

  function setStatus(value: HistoryStatus | null): Promise<void> {
    filters.status = value
    return load()
  }

  function setEngine(value: Engine | null): Promise<void> {
    filters.engine = value
    return load()
  }

  function setProfile(value: ProfileId | null): Promise<void> {
    filters.profileId = value
    return load()
  }

  function setFrom(value: string): Promise<void> {
    filters.from = value
    return load()
  }

  function setTo(value: string): Promise<void> {
    filters.to = value
    return load()
  }

  /** Quita todos los filtros sin recargar: quien lo llama decide cuándo pedir la lista. */
  function resetFilters(): void {
    cancelDebounce()
    Object.assign(filters, NO_FILTERS)
  }

  /** Empieza a refrescar las fechas relativas; `discard` lo detiene. */
  function startClock(): void {
    stopClock()
    clock = setInterval(() => {
      now.value = Date.now()
    }, CLOCK_TICK_MS)
  }

  function stopClock(): void {
    clearInterval(clock)
    clock = undefined
  }

  /** Olvida la lista (el texto SQL no debe quedar en memoria con el panel cerrado) e invalida lo que esté en vuelo. */
  function discard(): void {
    cancelDebounce()
    stopClock()
    reloadAfterLoad = false
    generation += 1
    entries.value = []
    nextCursor.value = null
    status.value = 'idle'
    error.value = null
    moreError.value = null
    actionError.value = null
    loadingMore.value = false
  }

  /** Borra una entrada en main y, si se borró (o ya no existía), la quita de la lista. */
  async function remove(id: string): Promise<boolean> {
    actionError.value = null
    const result = await api.delete({ id })
    if (!result.ok) {
      actionError.value = result.error
      return false
    }
    await dropLocally(id)
    return true
  }

  async function dropLocally(id: string): Promise<void> {
    entries.value = entries.value.filter((entry) => entry.id !== id)
    // Se vació la página pero main aún tiene más: la lista no puede quedarse en blanco con un cursor pendiente.
    if (entries.value.length === 0 && nextCursor.value !== null) await load()
  }

  function resetToEmpty(): void {
    generation += 1
    entries.value = []
    nextCursor.value = null
    moreError.value = null
    loadingMore.value = false
    error.value = null
    status.value = 'ready'
  }

  // Más reciente primero, con el id como desempate: el mismo orden con el que main pagina.
  function insertionIndex(entry: HistoryEntry): number {
    const time = Date.parse(entry.executedAt)
    const index = entries.value.findIndex((existing) => {
      const existingTime = Date.parse(existing.executedAt)
      return existingTime < time || (existingTime === time && existing.id < entry.id)
    })
    return index === -1 ? entries.value.length : index
  }

  function insertLocally(entry: HistoryEntry): void {
    if (dateProblem.value !== null || !entryMatchesFilters(entry, filters)) return
    if (entries.value.some((existing) => existing.id === entry.id)) return
    const index = insertionIndex(entry)
    // Más antigua que todo lo cargado y con páginas por venir: le toca llegar con su página, no aquí.
    if (index === entries.value.length && nextCursor.value !== null) return
    entries.value.splice(index, 0, entry)
    now.value = Date.now()
    arrivals.value += 1
  }

  /**
   * Aplica un cambio del historial que empujó main. Solo tiene efecto con el panel abierto (con la lista
   * descartada no hay nada que mantener) y nunca mueve el orden de lo ya cargado: la entrada nueva se
   * inserta en su sitio si cumple búsqueda y filtros, y el resto de la lista, el foco y el scroll no cambian.
   */
  function applyChange(change: HistoryChange): void {
    if (status.value === 'idle' || status.value === 'error') return
    if (status.value === 'loading') {
      reloadAfterLoad = true
      return
    }
    switch (change.type) {
      case 'added':
        insertLocally(change.entry)
        return
      case 'removed':
        void dropLocally(change.id)
        return
      case 'cleared':
        resetToEmpty()
        return
      case 'purged':
        // Main no dice qué caducó: se vuelve a pedir la primera página con los mismos filtros.
        void load()
        return
    }
  }

  /** Vacía todo el historial (no solo lo que dejan ver los filtros). */
  async function clear(): Promise<IpcResult<HistoryDeleteResult>> {
    if (clearing.value) return ipcFail(CLEAR_BUSY)
    clearing.value = true
    actionError.value = null
    const result = await api.clear()
    clearing.value = false
    if (result.ok) resetToEmpty()
    return result
  }

  return {
    entries,
    nextCursor,
    status,
    error,
    loadingMore,
    moreError,
    actionError,
    clearing,
    filters,
    filtered,
    dateProblem,
    hasMore,
    now,
    arrivals,
    load,
    loadMore,
    setSearch,
    setStatus,
    setEngine,
    setProfile,
    setFrom,
    setTo,
    resetFilters,
    startClock,
    discard,
    applyChange,
    remove,
    clear,
  }
})
