import type { HistoryEntry } from '@strata/contracts'
import { useConnectionsStore } from '../../connections'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import type { ReopenOutcome } from '../model/reopen'

/** Reabre una entrada del historial en una pestaña nueva, sin ejecutarla. */
export function useReopenEntry() {
  const workspace = useWorkspaceStore()
  const connections = useConnectionsStore()

  return function reopen(entry: HistoryEntry): ReopenOutcome {
    const profile = connections.findProfile(entry.profileId)
    if (profile) connections.select(profile.id)

    const runtime = profile ? connections.runtimeOf(profile.id) : null
    const sessionId = runtime?.status === 'connected' ? (runtime.session?.sessionId ?? null) : null
    const tab = workspace.createTab(sessionId)
    workspace.setContent(tab.id, entry.sql)

    if (!profile) return 'missing'
    return sessionId === null ? 'disconnected' : 'linked'
  }
}
