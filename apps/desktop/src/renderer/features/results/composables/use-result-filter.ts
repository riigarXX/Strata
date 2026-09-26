import { computed, onScopeDispose, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import type { ResultSetView } from '../../execution/model/result-buffers'
import { normalizeQuery, RowFilter } from '../model/row-filter'

export interface ResultFilterOptions {
  rows: () => ResultSetView['rows']
  /** Filas cargadas hasta ahora; sirve para seguir el crecimiento del búfer. */
  loaded: Ref<number>
  query: Ref<string>
  /** Tiempo de CPU por tanda antes de ceder el hilo al navegador. */
  budgetMs?: number
  yieldToMain?: () => Promise<void>
}

export interface ResultFilter {
  active: ComputedRef<boolean>
  /** Hay filas cargadas que aún no se han revisado. */
  scanning: Ref<boolean>
  /** Cambia con cada tanda o cambio de consulta: hay que leerlo para reaccionar a `sourceRow`. */
  version: Ref<number>
  /** Filas visibles: las coincidencias, o todas las cargadas sin filtro. */
  count: ComputedRef<number>
  /** Fila del resultado que corresponde a la posición `index` de la lista visible. */
  sourceRow: (index: number) => number
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Filtro local sobre las filas cargadas. Trabaja por tandas cediendo el hilo, se cancela solo cuando la
 * consulta cambia y continúa desde donde iba cuando llegan más filas, sin repetir el trabajo ya hecho.
 */
export function useResultFilter(options: ResultFilterOptions): ResultFilter {
  const budgetMs = options.budgetMs ?? 8
  const yieldToMain = options.yieldToMain ?? defaultYield
  const version = shallowRef(0)
  const scanning = shallowRef(false)
  let filter: RowFilter | null = null
  let pumping: RowFilter | null = null

  const active = computed(() => normalizeQuery(options.query.value) !== '')
  const count = computed(() => {
    void version.value
    return active.value && filter ? filter.matches.length : options.loaded.value
  })

  async function pump(target: RowFilter): Promise<void> {
    if (pumping === target) return
    pumping = target
    scanning.value = true
    while (filter === target && !target.isComplete(options.rows().length)) {
      target.step(options.rows(), budgetMs)
      version.value += 1
      if (!target.isComplete(options.rows().length)) await yieldToMain()
    }
    if (pumping === target) {
      pumping = null
      scanning.value = false
    }
  }

  watch(
    options.query,
    (query) => {
      filter = normalizeQuery(query) === '' ? null : new RowFilter(query)
      version.value += 1
      if (filter) void pump(filter)
      else {
        pumping = null
        scanning.value = false
      }
    },
    { flush: 'sync' },
  )

  watch(options.loaded, () => {
    if (filter && pumping !== filter) void pump(filter)
  })

  onScopeDispose(() => {
    filter = null
    pumping = null
  })

  return {
    active,
    scanning,
    version,
    count,
    sourceRow: (index) => (filter ? (filter.matches[index] ?? index) : index),
  }
}
