import type { ConnectionProfile, Session } from '@strata/contracts'
import { computed, type ComputedRef } from 'vue'
import { useConnectionsStore } from '../../connections'
import { useWorkspaceStore } from '../stores/workspace'

export interface ActiveConnection {
  profile: ConnectionProfile
  session: Session
}

/** Sesiones abiertas ahora mismo, tal como las entrega el store de conexiones. */
export function useLiveConnections(): ComputedRef<ActiveConnection[]> {
  const connections = useConnectionsStore()
  return computed(() =>
    connections.profiles.flatMap((profile) => {
      const { status, session } = connections.runtimeOf(profile.id)
      return status === 'connected' && session ? [{ profile, session }] : []
    }),
  )
}

/**
 * Conexión que gobierna el workspace: la de la pestaña activa y, si esta no tiene sesión, la del perfil
 * seleccionado en la sidebar (la que heredaría una pestaña nueva).
 */
export function useActiveConnection(): ComputedRef<ActiveConnection | null> {
  const workspace = useWorkspaceStore()
  const connections = useConnectionsStore()
  const live = useLiveConnections()

  return computed(() => {
    const tabSession = workspace.activeTab?.sessionId
    const fromTab = tabSession
      ? live.value.find((entry) => entry.session.sessionId === tabSession)
      : undefined
    if (fromTab) return fromTab
    return live.value.find((entry) => entry.profile.id === connections.selectedId) ?? null
  })
}
