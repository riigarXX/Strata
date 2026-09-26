import {
  HISTORY_LIMITS,
  type Engine,
  type HistoryEntry,
  type HistoryListRequest,
  type HistoryStatus,
  type ProfileId,
} from '@strata/contracts'

export interface HistoryFilters {
  /** Texto tal como lo escribe el usuario; al pedir se recorta y se omite si queda vacío. */
  search: string
  status: HistoryStatus | null
  engine: Engine | null
  profileId: ProfileId | null
  /**
   * Día «AAAA-MM-DD» (el valor de un `<input type="date">`), en la hora local del usuario y con ambos extremos
   * incluidos: `from` empieza a las 00:00:00.000 y `to` acaba a las 23:59:59.999 de ese día. Vacío = sin límite.
   */
  from: string
  to: string
}

export const NO_FILTERS: Readonly<HistoryFilters> = Object.freeze({
  search: '',
  status: null,
  engine: null,
  profileId: null,
  from: '',
  to: '',
})

export const HISTORY_PAGE_SIZE = HISTORY_LIMITS.pageSize.default

export function hasActiveFilters(filters: HistoryFilters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.status !== null ||
    filters.engine !== null ||
    filters.profileId !== null ||
    filters.from !== '' ||
    filters.to !== ''
  )
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
// El historial nace con la aplicación: antes de 1970 no hay nada, y un año de más de cuatro cifras no cabe en el contrato (ISO 8601).
const MIN_YEAR = 1970

/** Milisegundos (época) del día local dado, al inicio o al final; `undefined` si no es una fecha real. */
function localDayMs(day: string, edge: 'start' | 'end'): number | undefined {
  const match = DAY_PATTERN.exec(day)
  if (!match) return undefined
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  if (year < MIN_YEAR) return undefined
  const moment =
    edge === 'start'
      ? new Date(year, month - 1, date, 0, 0, 0, 0)
      : new Date(year, month - 1, date, 23, 59, 59, 999)
  // `new Date(2026, 1, 31)` desborda a marzo en lugar de fallar.
  if (moment.getMonth() !== month - 1 || moment.getDate() !== date) return undefined
  return moment.getTime()
}

export type DateRangeProblem = 'invalid-from' | 'invalid-to' | 'inverted'

/** Por qué el rango de fechas no se puede pedir, o `null` si es válido (incluido no tener ninguno). */
export function dateRangeProblem(filters: HistoryFilters): DateRangeProblem | null {
  if (filters.from !== '' && localDayMs(filters.from, 'start') === undefined) return 'invalid-from'
  if (filters.to !== '' && localDayMs(filters.to, 'end') === undefined) return 'invalid-to'
  if (filters.from !== '' && filters.to !== '' && filters.from > filters.to) return 'inverted'
  return null
}

/** ¿Cumple la entrada los filtros activos? Mismas reglas que aplica main al listar, para insertar una entrada nueva sin recargar. */
export function entryMatchesFilters(entry: HistoryEntry, filters: HistoryFilters): boolean {
  const needle = filters.search.trim().slice(0, HISTORY_LIMITS.searchMaxChars).toLowerCase()
  const time = Date.parse(entry.executedAt)
  const from = filters.from === '' ? undefined : localDayMs(filters.from, 'start')
  const to = filters.to === '' ? undefined : localDayMs(filters.to, 'end')
  return (
    (needle === '' || entry.sql.toLowerCase().includes(needle)) &&
    (filters.status === null || entry.status === filters.status) &&
    (filters.engine === null || entry.engine === filters.engine) &&
    (filters.profileId === null || entry.profileId === filters.profileId) &&
    (from === undefined || time >= from) &&
    (to === undefined || time <= to)
  )
}

/** Petición de una página: solo lleva los filtros activos, que main revalida con el schema del contrato. */
export function buildListRequest(filters: HistoryFilters, cursor?: string): HistoryListRequest {
  const search = filters.search.trim().slice(0, HISTORY_LIMITS.searchMaxChars)
  const from = filters.from === '' ? undefined : localDayMs(filters.from, 'start')
  const to = filters.to === '' ? undefined : localDayMs(filters.to, 'end')
  return {
    limit: HISTORY_PAGE_SIZE,
    ...(search === '' ? {} : { search }),
    ...(filters.status === null ? {} : { status: filters.status }),
    ...(filters.engine === null ? {} : { engine: filters.engine }),
    ...(filters.profileId === null ? {} : { profileId: filters.profileId }),
    ...(from === undefined ? {} : { from: new Date(from).toISOString() }),
    ...(to === undefined ? {} : { to: new Date(to).toISOString() }),
    ...(cursor === undefined ? {} : { cursor }),
  }
}
