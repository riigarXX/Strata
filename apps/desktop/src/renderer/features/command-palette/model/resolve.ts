import { closestMatches } from '@strata/commands'
import type { ConnectionSummary, SchemaSummary, TableSummary } from './context'

export type Resolution<T> = { ok: true; value: T } | { ok: false; message: string }

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const quoted = (names: readonly string[]): string => names.map((name) => `«${name}»`).join(', ')

/**
 * Elige un elemento por lo que escribió el usuario: coincidencia exacta, luego por prefijo y luego por
 * subcadena, sin distinguir mayúsculas ni tildes. Devuelve `null` si nada coincide y el conjunto si hay varios.
 */
function pick<T>(
  items: readonly T[],
  query: string,
  names: (item: T) => readonly string[],
): T[] | null {
  const wanted = fold(query.trim())
  if (wanted === '') return null
  const tiers: ((name: string) => boolean)[] = [
    (name) => name === wanted,
    (name) => name.startsWith(wanted),
    (name) => name.includes(wanted),
  ]
  for (const matches of tiers) {
    const found = items.filter((item) => names(item).some((name) => matches(fold(name))))
    if (found.length > 0) return found
  }
  return null
}

export function resolveConnection(
  connections: readonly ConnectionSummary[],
  query: string,
): Resolution<ConnectionSummary> {
  if (connections.length === 0) return { ok: false, message: 'No hay conexiones guardadas.' }
  const found = pick(connections, query, (connection) => [connection.name])
  if (!found) {
    return {
      ok: false,
      message: `No hay ninguna conexión llamada «${query}». Disponibles: ${quoted(connections.map((connection) => connection.name))}.`,
    }
  }
  const [only] = found
  if (found.length === 1 && only) return { ok: true, value: only }
  return {
    ok: false,
    message: `«${query}» coincide con varias conexiones: ${quoted(found.map((connection) => connection.name))}. Escribe el nombre completo.`,
  }
}

export function resolveSchema(schema: SchemaSummary | null, query: string): Resolution<string> {
  if (!schema) return { ok: false, message: 'No hay un esquema cargado: conecta primero.' }
  const found = pick(schema.schemas, query, (name) => [name])
  if (!found) {
    const near = closestMatches(query, schema.schemas)
    return {
      ok: false,
      message: `No se encontró el esquema «${query}».${near.length > 0 ? ` ¿Quisiste decir ${quoted(near)}?` : ` Esquemas: ${quoted(schema.schemas)}.`}`,
    }
  }
  const [only] = found
  if (found.length === 1 && only !== undefined) return { ok: true, value: only }
  return {
    ok: false,
    message: `«${query}» coincide con varios esquemas: ${quoted(found)}. Escribe el nombre completo.`,
  }
}

export const qualified = (table: Pick<TableSummary, 'schema' | 'name'>): string =>
  `${table.schema}.${table.name}`

/** `schema.tabla` o solo `tabla`, entre las tablas y vistas ya cargadas en la caché. */
export function resolveTable(
  schema: SchemaSummary | null,
  query: string,
): Resolution<TableSummary> {
  if (!schema) return { ok: false, message: 'No hay un esquema cargado: conecta primero.' }
  const text = query.trim()
  const byQualified = schema.tables.filter((table) => fold(qualified(table)) === fold(text))
  const bare = schema.tables.filter((table) => fold(table.name) === fold(text))
  const found = byQualified.length > 0 ? byQualified : bare.length > 0 ? bare : null
  if (found) {
    const [only] = found
    if (found.length === 1 && only) return { ok: true, value: only }
    return {
      ok: false,
      message: `«${query}» existe en varios esquemas: ${quoted(found.map(qualified))}. Escribe schema.tabla.`,
    }
  }
  const near = closestMatches(text, schema.tables.map(qualified))
  return {
    ok: false,
    message: `No se encontró «${query}» entre las tablas ya cargadas.${near.length > 0 ? ` ¿Quisiste decir ${quoted(near)}?` : ''} Expande el esquema en el explorador para cargar sus tablas.`,
  }
}
