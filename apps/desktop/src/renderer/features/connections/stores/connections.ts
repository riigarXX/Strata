import type {
  ConnectionProfile,
  NormalizedError,
  ProfileId,
  Session,
  SessionId,
  TransactionState,
} from '@strata/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useConnectionsApi } from '../api/use-connections-api'
import { requestFromStored } from '../model/profile-form'
import { ENGINE_LABELS, type ConnectionUiStatus } from '../model/presentation'

export type { ConnectionUiStatus }

export interface ConnectionRuntime {
  status: ConnectionUiStatus
  session: Session | null
  error: NormalizedError | null
  /** Reconexión en curso: el botón «Reconectar» permanece para no perder el foco. */
  reconnecting: boolean
}

export type ProfileTestState =
  | { status: 'running' }
  | { status: 'ok'; serverVersion: string; latencyMs: number }
  | { status: 'failed'; error: NormalizedError }

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

const DISCONNECTED: ConnectionRuntime = Object.freeze({
  status: 'disconnected',
  session: null,
  error: null,
  reconnecting: false,
})

function runtime(patch: Partial<ConnectionRuntime>): ConnectionRuntime {
  return { ...DISCONNECTED, ...patch }
}

// Todo campo distinto del nombre puede cerrar la sesión abierta en main (updateProfile).
function sameConnectionTarget(a: ConnectionProfile, b: ConnectionProfile): boolean {
  const comparable = (profile: ConnectionProfile) =>
    JSON.stringify(
      Object.entries(profile)
        .filter(([key]) => key !== 'name')
        .sort(([left], [right]) => left.localeCompare(right)),
    )
  return comparable(a) === comparable(b)
}

/**
 * Caché de sesión de lo que main entrega por IPC (ADR 0009). Nunca recibe passwords: el formulario
 * habla con la API directamente y solo entrega aquí el perfil público ya guardado.
 */
export const useConnectionsStore = defineStore('connections', () => {
  const api = useConnectionsApi()

  const profiles = ref<ConnectionProfile[]>([])
  const runtimes = ref<Record<ProfileId, ConnectionRuntime>>({})
  const tests = ref<Record<ProfileId, ProfileTestState>>({})
  const selectedId = ref<ProfileId | null>(null)
  const loadStatus = ref<LoadStatus>('idle')
  const loadError = ref<NormalizedError | null>(null)
  const notice = ref('')

  const selectedProfile = computed(
    () => profiles.value.find((profile) => profile.id === selectedId.value) ?? null,
  )

  function runtimeOf(profileId: ProfileId): ConnectionRuntime {
    return runtimes.value[profileId] ?? DISCONNECTED
  }

  function findProfile(profileId: ProfileId): ConnectionProfile | undefined {
    return profiles.value.find((profile) => profile.id === profileId)
  }

  function ensureSelection(): void {
    if (profiles.value.some((profile) => profile.id === selectedId.value)) return
    selectedId.value = profiles.value[0]?.id ?? null
  }

  function forget(profileId: ProfileId): void {
    delete runtimes.value[profileId]
    delete tests.value[profileId]
  }

  function select(profileId: ProfileId): void {
    if (findProfile(profileId)) selectedId.value = profileId
  }

  async function load(): Promise<void> {
    loadStatus.value = 'loading'
    loadError.value = null
    const result = await api.list()
    if (!result.ok) {
      loadStatus.value = 'error'
      loadError.value = result.error
      return
    }
    profiles.value = result.data
    const known = new Set(result.data.map((profile) => profile.id))
    for (const profileId of Object.keys(runtimes.value))
      if (!known.has(profileId)) forget(profileId)
    ensureSelection()
    loadStatus.value = 'ready'
  }

  /** Incorpora un perfil ya guardado por main. `sessionMayHaveClosed`: se envió una password nueva. */
  function applySaved(profile: ConnectionProfile, sessionMayHaveClosed = false): void {
    const index = profiles.value.findIndex((entry) => entry.id === profile.id)
    const previous = index >= 0 ? profiles.value[index] : undefined
    const targetChanged = previous !== undefined && !sameConnectionTarget(previous, profile)
    if (previous) {
      profiles.value[index] = profile
      if (sessionMayHaveClosed || targetChanged) {
        runtimes.value[profile.id] = runtime({})
        delete tests.value[profile.id]
      }
    } else {
      profiles.value.push(profile)
    }
    selectedId.value = profile.id
    notice.value = `Conexión «${profile.name}» guardada.`
  }

  /** Refleja el estado de transacción que main comunica tras begin/commit/rollback o al terminar una consulta. */
  function applyTransaction(sessionId: SessionId, transaction: TransactionState): void {
    for (const entry of Object.values(runtimes.value)) {
      if (entry.session?.sessionId === sessionId) entry.session.transaction = transaction
    }
  }

  async function connect(profileId: ProfileId): Promise<void> {
    const profile = findProfile(profileId)
    if (!profile || runtimeOf(profileId).status === 'connecting') return

    runtimes.value[profileId] = runtime({ status: 'connecting' })
    const result = await api.connect({ profileId })
    if (!findProfile(profileId)) return
    if (result.ok) {
      runtimes.value[profileId] = runtime({ status: 'connected', session: result.data })
      notice.value = `Conectado a «${profile.name}» (${ENGINE_LABELS[result.data.engine]} ${result.data.serverVersion}).`
    } else {
      runtimes.value[profileId] = runtime({ status: 'error', error: result.error })
      notice.value = ''
    }
  }

  async function disconnect(profileId: ProfileId): Promise<void> {
    const profile = findProfile(profileId)
    const current = runtimeOf(profileId)
    if (!profile || current.status !== 'connected' || !current.session) return

    const result = await api.disconnect({ sessionId: current.session.sessionId })
    // `no_session`: main ya la cerró (p. ej. al editar el perfil), el estado real es «desconectado».
    if (result.ok || result.error.code === 'no_session') {
      runtimes.value[profileId] = runtime({})
      notice.value = `Desconectado de «${profile.name}».`
    } else {
      runtimes.value[profileId] = { ...current, error: result.error }
    }
  }

  async function reconnect(profileId: ProfileId): Promise<void> {
    const profile = findProfile(profileId)
    const current = runtimeOf(profileId)
    if (!profile || current.status === 'connecting') return

    if (current.status === 'connected' && current.session) {
      runtimes.value[profileId] = runtime({ status: 'connecting', reconnecting: true })
      const closed = await api.disconnect({ sessionId: current.session.sessionId })
      if (!closed.ok && closed.error.code !== 'no_session') {
        runtimes.value[profileId] = { ...current, error: closed.error }
        return
      }
      runtimes.value[profileId] = runtime({})
    }
    await connect(profileId)
  }

  async function remove(profileId: ProfileId): Promise<NormalizedError | null> {
    const profile = findProfile(profileId)
    if (!profile) return null
    const result = await api.delete({ profileId })
    if (!result.ok) return result.error

    const index = profiles.value.findIndex((entry) => entry.id === profileId)
    profiles.value.splice(index, 1)
    forget(profileId)
    ensureSelection()
    notice.value = `Conexión «${profile.name}» eliminada.`
    return null
  }

  async function testProfile(profileId: ProfileId): Promise<void> {
    const profile = findProfile(profileId)
    if (!profile || tests.value[profileId]?.status === 'running') return

    tests.value[profileId] = { status: 'running' }
    const result = await api.test(requestFromStored(profile))
    if (!findProfile(profileId)) return
    if (!result.ok) {
      tests.value[profileId] = { status: 'failed', error: result.error }
    } else if (result.data.ok) {
      const { serverVersion, latencyMs } = result.data
      tests.value[profileId] = { status: 'ok', serverVersion, latencyMs }
    } else {
      tests.value[profileId] = { status: 'failed', error: result.data.error }
    }
  }

  return {
    profiles,
    runtimes,
    tests,
    selectedId,
    selectedProfile,
    loadStatus,
    loadError,
    notice,
    runtimeOf,
    findProfile,
    select,
    load,
    applySaved,
    connect,
    disconnect,
    reconnect,
    remove,
    testProfile,
    applyTransaction,
  }
})
