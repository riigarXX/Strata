import { watch } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useLiveConnections } from './use-active-connection'

/**
 * Mantiene coherentes las pestañas con las sesiones: una sesión que se cierra se desasocia de sus
 * pestañas, y una sesión recién abierta se asocia a la pestaña activa si esta aún no tenía ninguna.
 */
export function useTabSessionBinding(): void {
  const workspace = useWorkspaceStore()
  const live = useLiveConnections()

  watch(
    () => live.value.map((entry) => entry.session.sessionId),
    (current, previous = []) => {
      workspace.detachClosedSessions(new Set(current))
      const opened = current.filter((sessionId) => !previous.includes(sessionId))
      const target = workspace.activeTab
      const latest = opened[opened.length - 1]
      if (target && target.sessionId === null && latest) workspace.setSession(target.id, latest)
    },
  )
}
