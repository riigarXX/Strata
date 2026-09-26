import { computed, type ComputedRef } from 'vue'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { formatDuration } from '../model/presentation'
import { useExecutionStore } from '../stores/execution'

/** Duración de la última consulta terminada de la pestaña activa, ya formateada para la barra de estado. */
export function useLastQueryDuration(): ComputedRef<string | null> {
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()
  return computed(() => {
    const tab = workspace.activeTab
    const durationMs = tab ? execution.stateOf(tab.id).durationMs : null
    return durationMs === null ? null : formatDuration(durationMs)
  })
}
