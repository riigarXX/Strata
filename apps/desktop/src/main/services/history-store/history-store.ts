import { randomUUID } from 'node:crypto'
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  HISTORY_LIMITS,
  HistoryEntrySchema,
  type HistoryChange,
  type HistoryEntry,
  type HistoryListRequest,
  type HistoryPage,
  type HistoryRetentionDays,
} from '@strata/contracts'
import { createJsonFile, createSerialQueue, type StorageFileSystem } from '../local-storage'
import { systemClock, type Clock } from './clock'

export const HISTORY_FILE_NAME = 'history.json'

const FILE_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000

/** Entrada por registrar: el almacén asigna el `id`, recorta el SQL y normaliza la fecha. */
export type NewHistoryEntry = Omit<HistoryEntry, 'id'>

export interface HistoryStoreDependencies {
  fileSystem: StorageFileSystem
  filePath: string
  /** Retención vigente (`history.retentionDays`); el almacén no conoce dónde se guardan las preferencias. */
  getRetentionDays(): Promise<HistoryRetentionDays>
  clock?: Clock
  createId?: () => string
}

/**
 * Historial de consultas en un archivo propio (`history.json`, ADR 0005 y 0009). Solo guarda el texto SQL
 * que escribió el usuario y metadatos de la ejecución: nunca resultados ni secretos.
 */
export interface HistoryStore {
  /** `requestId` es la ejecución que la originó; solo viaja en el cambio `added`, no se guarda. */
  add(entry: NewHistoryEntry, options?: { requestId?: string }): Promise<HistoryEntry>
  /** Más reciente primero; búsqueda sin distinguir mayúsculas, filtros y paginación por cursor. */
  list(request: HistoryListRequest): Promise<HistoryPage>
  /** Número de entradas borradas (0 si el id no existía). */
  delete(id: string): Promise<number>
  /** Número de entradas borradas. */
  clear(): Promise<number>
  /** Borra lo que excede la retención vigente; devuelve cuántas entradas se fueron. */
  purge(): Promise<number>
  /**
   * Avisa de cada cambio ya persistido (alta, borrado, vaciado o purga). Un listener que falla no afecta al
   * almacén ni a los demás. Devuelve la función que lo retira.
   */
  subscribe(listener: (change: HistoryChange) => void): () => void
  /** Purga inicial y purga diaria. Nunca rechaza: un fallo se reintenta en la siguiente purga. */
  start(): Promise<void>
  stop(): void
}

interface Row {
  entry: HistoryEntry
  /** `executedAt` en milisegundos. */
  time: number
}

// Más reciente primero; el id desempata para que el orden (y con él el cursor) sea estable.
function byRecency(a: Row, b: Row): number {
  if (a.time !== b.time) return b.time - a.time
  if (a.entry.id === b.entry.id) return 0
  return a.entry.id < b.entry.id ? 1 : -1
}

function isAfter(row: Row, cursor: { time: number; id: string }): boolean {
  return row.time < cursor.time || (row.time === cursor.time && row.entry.id < cursor.id)
}

function truncateSql(sql: string): string {
  const max = HISTORY_LIMITS.maxSqlChars
  if (sql.length <= max) return sql
  let end = max
  // No parte un par sustituto por la mitad.
  const last = sql.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${sql.slice(0, end)}\n-- [Strata: SQL truncated, ${sql.length - end} more characters]`
}

function toRow(entry: HistoryEntry): Row | undefined {
  const time = Date.parse(entry.executedAt)
  if (Number.isNaN(time)) return undefined
  // Fecha normalizada (UTC, milisegundos): el orden del texto coincide con el orden temporal.
  return { entry: { ...entry, executedAt: new Date(time).toISOString() }, time }
}

interface ParsedHistory {
  rows: Row[]
  /** `true` si el archivo no era JSON válido o alguna entrada no superó el schema. */
  damaged: boolean
}

function parseHistory(raw: string): ParsedHistory {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { rows: [], damaged: true }
  }
  const entries: unknown =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { entries?: unknown }).entries
      : undefined
  if (!Array.isArray(entries)) return { rows: [], damaged: true }

  const seen = new Set<string>()
  const rows: Row[] = []
  let damaged = false
  for (const candidate of entries) {
    const result = HistoryEntrySchema.safeParse(candidate)
    const row = result.success ? toRow(result.data) : undefined
    if (row && !seen.has(row.entry.id)) {
      seen.add(row.entry.id)
      rows.push(row)
    } else {
      damaged = true
    }
  }
  return { rows, damaged }
}

const serialize = (rows: readonly Row[]): string =>
  JSON.stringify({ version: FILE_VERSION, entries: rows.map(({ entry }) => entry) }, null, 2)

export function createHistoryStore({
  fileSystem,
  filePath,
  getRetentionDays,
  clock = systemClock,
  createId = randomUUID,
}: HistoryStoreDependencies): HistoryStore {
  const file = createJsonFile({
    fileSystem,
    filePath,
    failureMessage: 'Could not access the query history',
  })
  const enqueue = createSerialQueue()
  let cache: Row[] | undefined
  let stopTimer: (() => void) | undefined
  const listeners = new Set<(change: HistoryChange) => void>()

  function emit(change: HistoryChange): void {
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch {
        // Quien escucha no puede hacer fallar una escritura ya hecha.
      }
    }
  }

  async function load(): Promise<Row[]> {
    if (cache) return cache
    const raw = await file.read()
    if (raw === undefined) return (cache = [])

    const { rows, damaged } = parseHistory(raw)
    // Se conserva el original para poder recuperarlo: la próxima escritura sobrescribe `filePath`.
    if (damaged) await file.keepCorruptCopy(raw)
    return (cache = rows.sort(byRecency).slice(0, HISTORY_LIMITS.maxEntries))
  }

  // Un fallo al leer las preferencias no debe borrar ni bloquear el historial: solo se omite la purga por edad.
  async function retentionCutoff(): Promise<number | undefined> {
    try {
      const days = await getRetentionDays()
      return days === null ? undefined : clock.now() - days * DAY_MS
    } catch {
      return undefined
    }
  }

  async function trimmed(rows: Row[]): Promise<Row[]> {
    const cutoff = await retentionCutoff()
    const kept = cutoff === undefined ? rows : rows.filter(({ time }) => time >= cutoff)
    return kept.sort(byRecency).slice(0, HISTORY_LIMITS.maxEntries)
  }

  async function persist(next: Row[]): Promise<void> {
    await file.write(serialize(next))
    cache = next
  }

  function purge(): Promise<number> {
    return enqueue(async () => {
      const rows = await load()
      const next = await trimmed([...rows])
      if (next.length === rows.length) return 0
      await persist(next)
      emit({ type: 'purged' })
      return rows.length - next.length
    })
  }

  return {
    add: (input, options) =>
      enqueue(async () => {
        const rows = await load()
        const candidate: HistoryEntry = HistoryEntrySchema.parse({
          ...input,
          id: createId(),
          sql: truncateSql(input.sql),
        })
        const row = toRow(candidate)
        if (!row) throw new TypeError('Invalid execution date')
        const next = await trimmed([...rows, row])
        await persist(next)
        // Un alta ya caducada no llega a guardarse: no hay nada que anunciar de ella.
        const stored = next.includes(row)
        if (stored) {
          emit({
            type: 'added',
            entry: row.entry,
            ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
          })
        }
        // Con la retención vigente, el alta también pudo sacar entradas antiguas.
        if (next.length < rows.length + (stored ? 1 : 0)) emit({ type: 'purged' })
        return row.entry
      }),

    list: (request) =>
      enqueue(async () => {
        const rows = await load()
        const needle = request.search?.toLowerCase()
        const from = request.from === undefined ? undefined : Date.parse(request.from)
        const to = request.to === undefined ? undefined : Date.parse(request.to)
        const cursor =
          request.cursor === undefined ? undefined : decodeHistoryCursor(request.cursor)
        const limit = request.limit ?? HISTORY_LIMITS.pageSize.default

        const matches = (row: Row): boolean =>
          (request.engine === undefined || row.entry.engine === request.engine) &&
          (request.status === undefined || row.entry.status === request.status) &&
          (request.profileId === undefined || row.entry.profileId === request.profileId) &&
          (from === undefined || row.time >= from) &&
          (to === undefined || row.time <= to) &&
          (!needle || row.entry.sql.toLowerCase().includes(needle))

        const page: Row[] = []
        let more = false
        for (const row of rows) {
          if (cursor && !isAfter(row, cursor)) continue
          if (!matches(row)) continue
          if (page.length === limit) {
            more = true
            break
          }
          page.push(row)
        }

        const last = page.at(-1)
        return {
          entries: page.map(({ entry }) => entry),
          nextCursor:
            more && last ? encodeHistoryCursor({ time: last.time, id: last.entry.id }) : null,
        }
      }),

    delete: (id) =>
      enqueue(async () => {
        const rows = await load()
        const next = rows.filter(({ entry }) => entry.id !== id)
        if (next.length === rows.length) return 0
        await persist(next)
        emit({ type: 'removed', id })
        return rows.length - next.length
      }),

    clear: () =>
      enqueue(async () => {
        const rows = await load()
        if (rows.length === 0) return 0
        await persist([])
        emit({ type: 'cleared' })
        return rows.length
      }),

    purge,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async start() {
      stopTimer?.()
      stopTimer = clock.every(DAY_MS, () => {
        void purge().catch(() => undefined)
      })
      await purge().catch(() => undefined)
    },

    stop() {
      stopTimer?.()
      stopTimer = undefined
    },
  }
}
