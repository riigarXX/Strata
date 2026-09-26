import { onBeforeUnmount, onMounted } from 'vue'
import { useHistoryApi } from '../api/use-history-api'
import { useHistoryStore } from '../stores/history'
import { useRecordedEntriesStore } from '../stores/recorded-entries'

/**
 * Se monta una sola vez en el workspace: una única suscripción a los cambios del historial que empuja main.
 * La lista solo los aplica con el panel abierto (`discard` la vacía al cerrarlo); el registro de entradas
 * recientes los sigue siempre, porque la acción «quitar del historial» de la barra funciona con el panel cerrado.
 */
export function useHistoryFeed(): void {
  const api = useHistoryApi()
  const history = useHistoryStore()
  const recorded = useRecordedEntriesStore()
  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    unsubscribe = api.onChange((change) => {
      recorded.applyChange(change)
      history.applyChange(change)
    })
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    unsubscribe = null
  })
}
