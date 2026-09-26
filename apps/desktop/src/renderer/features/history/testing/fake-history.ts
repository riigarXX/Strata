import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  HISTORY_LIMITS,
  type HistoryEntry,
  type HistoryListRequest,
  type HistoryPage,
} from '@strata/contracts'
import { ipcOk } from '../../../../shared/ipc-result'
import type { createFakeDb } from '../../connections/testing/fake-db'

const BASE_TIME = Date.parse('2026-09-20T12:00:00.000Z')

/** Instante de referencia de los datos de prueba: la entrada 1 es del minuto anterior. */
export const HISTORY_NOW = BASE_TIME

/** Entrada determinista: cuanto mayor el índice, más antigua (un minuto por índice). */
export function makeEntry(index: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `entry-${index}`,
    sql: `select ${index} from users`,
    engine: 'postgres',
    profileId: 'pg1',
    profileName: 'Producción',
    executedAt: new Date(BASE_TIME - index * 60_000).toISOString(),
    durationMs: 12 + index,
    status: 'ok',
    rowCount: index,
    ...overrides,
  }
}

export function makeEntries(count: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry[] {
  return Array.from({ length: count }, (_, index) => makeEntry(index + 1, overrides))
}

const position = (entry: HistoryEntry) => ({ time: Date.parse(entry.executedAt), id: entry.id })

function isAfter(entry: HistoryEntry, cursor: { time: number; id: string }): boolean {
  const { time, id } = position(entry)
  return time < cursor.time || (time === cursor.time && id < cursor.id)
}

function matches(entry: HistoryEntry, request: HistoryListRequest): boolean {
  const search = request.search?.toLowerCase()
  return (
    (search === undefined || entry.sql.toLowerCase().includes(search)) &&
    (request.status === undefined || entry.status === request.status) &&
    (request.engine === undefined || entry.engine === request.engine) &&
    (request.profileId === undefined || entry.profileId === request.profileId) &&
    (request.from === undefined || Date.parse(entry.executedAt) >= Date.parse(request.from)) &&
    (request.to === undefined || Date.parse(entry.executedAt) <= Date.parse(request.to))
  )
}

/**
 * Almacén en memoria que imita las reglas visibles del historial de main: más reciente primero,
 * paginación por cursor (tiempo, id), búsqueda de subcadena sin distinguir mayúsculas y filtros.
 */
export function createFakeHistory(initial: readonly HistoryEntry[]) {
  let stored = [...initial].sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt))

  function page(request: HistoryListRequest): HistoryPage {
    const cursor = request.cursor === undefined ? undefined : decodeHistoryCursor(request.cursor)
    const limit = request.limit ?? HISTORY_LIMITS.pageSize.default
    const candidates = stored.filter(
      (entry) => matches(entry, request) && (cursor === undefined || isAfter(entry, cursor)),
    )
    const entries = candidates.slice(0, limit)
    const last = entries.at(-1)
    return {
      entries,
      nextCursor:
        last && candidates.length > entries.length ? encodeHistoryCursor(position(last)) : null,
    }
  }

  const byRecency = (a: HistoryEntry, b: HistoryEntry) =>
    Date.parse(b.executedAt) - Date.parse(a.executedAt)

  return {
    entries: () => [...stored],
    /** Guarda una entrada nueva como haría main; el aviso de cambio lo emite `stubHistory`. */
    add: (entry: HistoryEntry) => {
      stored = [...stored, entry].sort(byRecency)
    },
    list: async (request: HistoryListRequest) => ipcOk(page(request)),
    delete: async ({ id }: { id: string }) => {
      const before = stored.length
      stored = stored.filter((entry) => entry.id !== id)
      return ipcOk({ deleted: before - stored.length })
    },
    clear: async () => {
      const deleted = stored.length
      stored = []
      return ipcOk({ deleted })
    },
  }
}

/** Conecta el almacén en memoria a los `vi.fn` de `window.db.history` del `fake-db` compartido. */
export function stubHistory(
  fake: Pick<ReturnType<typeof createFakeDb>, 'history' | 'emitHistoryChange'>,
  entries: readonly HistoryEntry[],
) {
  const backend = createFakeHistory(entries)
  fake.history.list.mockImplementation(backend.list)
  fake.history.delete.mockImplementation(async (request) => {
    const result = await backend.delete(request)
    if (result.ok && result.data.deleted > 0) {
      fake.emitHistoryChange({ type: 'removed', id: request.id })
    }
    return result
  })
  fake.history.clear.mockImplementation(async () => {
    const result = await backend.clear()
    if (result.ok && result.data.deleted > 0) fake.emitHistoryChange({ type: 'cleared' })
    return result
  })
  return {
    ...backend,
    /** Una ejecución terminó y main guardó su entrada: llega el aviso `added`. */
    record(entry: HistoryEntry, requestId?: string): void {
      backend.add(entry)
      fake.emitHistoryChange({
        type: 'added',
        entry,
        ...(requestId === undefined ? {} : { requestId }),
      })
    },
  }
}
