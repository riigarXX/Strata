import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useLiveConnections } from '../../workspace/composables/use-active-connection'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { useQueryApi } from '../api/use-query-api'
import { useExecutionStore } from '../stores/execution'

/**
 * Se monta una sola vez en el workspace: una única suscripción a los eventos de consulta que los enruta
 * por `requestId` a la pestaña dueña, y la limpieza cuando desaparece una pestaña o una sesión.
 * Si la suscripción termina con ejecuciones abiertas, se cierran: nada más les entregaría su evento terminal.
 */
export function useExecutionLifecycle(): void {
  const execution = useExecutionStore()
  const workspace = useWorkspaceStore()
  const live = useLiveConnections()
  const api = useQueryApi()
  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    unsubscribe = api.onEvent((event) => execution.applyEvent(event))
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    unsubscribe = null
    execution.abandonAll()
  })

  watch(
    () => workspace.tabs.map((tab) => tab.id),
    (current, previous = []) => {
      for (const tabId of previous) if (!current.includes(tabId)) execution.forgetTab(tabId)
    },
  )

  watch(
    () => live.value.map((entry) => entry.session.sessionId),
    (current, previous = []) => {
      for (const sessionId of previous) {
        if (!current.includes(sessionId)) execution.sessionClosed(sessionId)
      }
    },
  )
}
