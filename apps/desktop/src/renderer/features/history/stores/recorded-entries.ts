import type { HistoryChange, NormalizedError } from '@strata/contracts'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useHistoryApi } from '../api/use-history-api'

/** Ejecuciones recientes de las que se recuerda la entrada: bastan las de las pestañas abiertas. */
const MAX_TRACKED = 100

export type RecordedState = 'recorded' | 'removed'

export type ExcludeOutcome =
  { outcome: 'excluded' } | { outcome: 'gone' } | { outcome: 'error'; error: NormalizedError }

/**
 * Qué entrada del historial dejó cada ejecución reciente (por `requestId`), para poder excluirla después de
 * ejecutar (ADR 0005). Solo guarda ids, nunca el SQL, y no depende de que el panel esté abierto. Main es la
 * fuente de verdad: una entrada borrada por cualquier vía pasa a `removed`.
 */
export const useRecordedEntriesStore = defineStore('historyRecorded', () => {
  const api = useHistoryApi()
  const tracked = ref<Record<string, { entryId: string; state: RecordedState }>>({})
  const excluding = ref<Record<string, true>>({})

  function remember(requestId: string, entryId: string): void {
    tracked.value[requestId] = { entryId, state: 'recorded' }
    const oldest = Object.keys(tracked.value)
    for (const stale of oldest.slice(0, Math.max(0, oldest.length - MAX_TRACKED))) {
      delete tracked.value[stale]
    }
  }

  function markRemoved(matches: (entryId: string) => boolean): void {
    for (const record of Object.values(tracked.value)) {
      if (record.state === 'recorded' && matches(record.entryId)) record.state = 'removed'
    }
  }

  function applyChange(change: HistoryChange): void {
    switch (change.type) {
      case 'added':
        if (change.requestId !== undefined) remember(change.requestId, change.entry.id)
        return
      case 'removed':
        markRemoved((entryId) => entryId === change.id)
        return
      case 'cleared':
        markRemoved(() => true)
        return
      case 'purged':
        // Sin ids no se sabe qué caducó; excluir una entrada ya purgada responde `gone`.
        return
    }
  }

  /** `undefined` si de esa ejecución no hay entrada (historial desactivado, opt-out, o aún no llegó). */
  function stateOf(requestId: string | null): RecordedState | undefined {
    return requestId === null ? undefined : tracked.value[requestId]?.state
  }

  function isExcluding(requestId: string | null): boolean {
    return requestId !== null && excluding.value[requestId] === true
  }

  /** Borra en main la entrada de esa ejecución. Una entrada que ya no existía cuenta como excluida. */
  async function exclude(requestId: string): Promise<ExcludeOutcome> {
    const record = tracked.value[requestId]
    if (!record || record.state !== 'recorded' || excluding.value[requestId]) {
      return { outcome: 'gone' }
    }
    excluding.value[requestId] = true
    const result = await api.delete({ id: record.entryId })
    delete excluding.value[requestId]
    if (!result.ok) return { outcome: 'error', error: result.error }
    // El aviso de main suele llegar antes que esta respuesta; si no, se marca aquí.
    const current = tracked.value[requestId]
    if (current) current.state = 'removed'
    return result.data.deleted > 0 ? { outcome: 'excluded' } : { outcome: 'gone' }
  }

  return { stateOf, isExcluding, applyChange, exclude }
})
