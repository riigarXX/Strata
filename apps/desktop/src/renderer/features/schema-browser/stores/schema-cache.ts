import type { SchemaInfo, SessionId, TableDetails, TableInfo, TableRef } from '@strata/contracts'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { IpcResult } from '../../../../shared/ipc-result'
import { useMetadataApi } from '../api/use-metadata-api'
import { emptySessionCache, type Loadable, type SessionCache } from '../model/cache'
import { schemaKey, tableKey, tableRefFromKey } from '../model/node-keys'

interface Slot<T> {
  get(): Loadable<T> | null | undefined
  set(value: Loadable<T>): void
}

function bucketSlot<T>(bucket: Record<string, Loadable<T>>, key: string): Slot<T> {
  return {
    get: () => bucket[key],
    set: (value) => {
      bucket[key] = value
    },
  }
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

/**
 * Caché por sesión de los metadatos del servidor (ADR 0008/0009). Solo guarda catálogo y estado de
 * expansión: ni credenciales ni filas de consultas. Se descarta al cerrarse la sesión.
 */
export const useSchemaCacheStore = defineStore('schemaCache', () => {
  const api = useMetadataApi()

  const sessions = ref<Record<SessionId, SessionCache>>({})
  // Último resultado de una carga, para el anunciante `aria-live` del explorador.
  const notice = ref('')
  let sequence = 0

  function entryOf(sessionId: SessionId): SessionCache {
    sessions.value[sessionId] ??= emptySessionCache()
    return sessions.value[sessionId]
  }

  /** `null` si la petición quedó superada (refresco) o la sesión ya no existe. */
  async function load<T>(
    sessionId: SessionId,
    slot: Slot<T>,
    fetch: () => Promise<IpcResult<T>>,
  ): Promise<IpcResult<T> | null> {
    const entry = sessions.value[sessionId]
    const seq = ++sequence
    slot.set({ status: 'loading', data: slot.get()?.data ?? null, error: null, seq })
    const result = await fetch()
    if (sessions.value[sessionId] !== entry || slot.get()?.seq !== seq) return null
    slot.set(
      result.ok
        ? { status: 'ready', data: result.data, error: null, seq }
        : { status: 'error', data: null, error: result.error, seq },
    )
    return result
  }

  async function loadSchemas(sessionId: SessionId): Promise<boolean> {
    const entry = entryOf(sessionId)
    const result = await load(
      sessionId,
      {
        get: () => entry.schemas,
        set: (value) => {
          entry.schemas = value
        },
      },
      () => api.listSchemas({ sessionId }),
    )
    if (!result) return false
    if (!result.ok) {
      notice.value = `No se pudieron cargar los esquemas: ${result.error.message}`
      return false
    }
    const names = new Set(result.data.map((schema: SchemaInfo) => schema.name))
    for (const schema of Object.keys(entry.tables))
      if (!names.has(schema)) delete entry.tables[schema]
    notice.value = `${result.data.length} ${plural(result.data.length, 'esquema cargado', 'esquemas cargados')}.`

    // Con un solo schema no hay nada que elegir: se abre por defecto salvo decisión previa del usuario.
    const only = result.data.length === 1 ? result.data[0] : undefined
    if (only && entry.toggled[schemaKey(only.name)] === undefined) {
      entry.toggled[schemaKey(only.name)] = true
      void ensureTables(sessionId, only.name)
    }
    return true
  }

  async function loadTables(sessionId: SessionId, schema: string): Promise<boolean> {
    const entry = entryOf(sessionId)
    const result = await load(sessionId, bucketSlot<TableInfo[]>(entry.tables, schema), () =>
      api.listTables({ sessionId, schema }),
    )
    if (!result) return false
    notice.value = result.ok
      ? `${schema}: ${result.data.length} ${plural(result.data.length, 'tabla o vista', 'tablas y vistas')}.`
      : `No se pudieron cargar las tablas de ${schema}: ${result.error.message}`
    return result.ok
  }

  async function loadDetails(sessionId: SessionId, table: TableRef): Promise<boolean> {
    const entry = entryOf(sessionId)
    const result = await load(
      sessionId,
      bucketSlot<TableDetails>(entry.details, tableKey(table)),
      // Solo schema y nombre: main valida el contrato con un schema estricto y rechazaría el resto de campos.
      () => api.describeTable({ sessionId, table: { schema: table.schema, name: table.name } }),
    )
    if (!result) return false
    notice.value = result.ok
      ? `Detalle de ${table.name} cargado.`
      : `No se pudo cargar ${table.name}: ${result.error.message}`
    return result.ok
  }

  /** Carga la primera vez y reintenta si la carga anterior falló; no repite lo cargado ni lo en curso. */
  async function ensure(status: Loadable<unknown> | null | undefined, run: () => Promise<boolean>) {
    if (status && status.status !== 'error') return
    await run()
  }

  function ensureSchemas(sessionId: SessionId): Promise<void> {
    return ensure(entryOf(sessionId).schemas, () => loadSchemas(sessionId))
  }

  function ensureTables(sessionId: SessionId, schema: string): Promise<void> {
    return ensure(entryOf(sessionId).tables[schema], () => loadTables(sessionId, schema))
  }

  function ensureDetails(sessionId: SessionId, table: TableRef): Promise<void> {
    return ensure(entryOf(sessionId).details[tableKey(table)], () => loadDetails(sessionId, table))
  }

  /**
   * Vuelve a pedir lo ya conocido conservando lo que se ve hasta que llegue lo nuevo: los schemas, los
   * listados cargados y el detalle de las tablas expandidas (el resto del detalle se descarta y se pedirá al expandir).
   */
  async function refresh(sessionId: SessionId): Promise<void> {
    const entry = sessions.value[sessionId]
    if (!entry) return
    notice.value = 'Actualizando esquema…'

    const jobs: Promise<boolean>[] = [loadSchemas(sessionId)]
    for (const schema of Object.keys(entry.tables)) jobs.push(loadTables(sessionId, schema))
    for (const key of Object.keys(entry.details)) {
      const table = tableRefFromKey(key)
      if (table && entry.toggled[key] === true) jobs.push(loadDetails(sessionId, table))
      else delete entry.details[key]
    }
    const results = await Promise.all(jobs)
    if (sessions.value[sessionId] !== entry) return
    notice.value = results.every(Boolean)
      ? 'Esquema actualizado.'
      : 'El esquema se actualizó con errores.'
  }

  function setExpanded(sessionId: SessionId, key: string, expanded: boolean): void {
    const entry = sessions.value[sessionId]
    if (entry) entry.toggled[key] = expanded
  }

  function dropSession(sessionId: SessionId): void {
    delete sessions.value[sessionId]
  }

  /** Descarta el caché de las sesiones que ya no están abiertas. */
  function retainSessions(live: ReadonlySet<SessionId>): void {
    for (const sessionId of Object.keys(sessions.value))
      if (!live.has(sessionId)) dropSession(sessionId)
  }

  return {
    sessions,
    notice,
    ensureSchemas,
    ensureTables,
    ensureDetails,
    refresh,
    setExpanded,
    dropSession,
    retainSessions,
  }
})
