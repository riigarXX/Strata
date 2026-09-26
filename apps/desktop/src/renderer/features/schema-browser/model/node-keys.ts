import type { TableRef } from '@strata/contracts'

export type TableGroup = 'tables' | 'views'
export type TableSection = 'columns' | 'foreign-keys' | 'indexes'

// Las claves identifican nodos entre refrescos (expansión, foco): se serializan como JSON para que
// ningún nombre de schema o tabla, sea cual sea su contenido, pueda colisionar con otro.
const key = (...parts: (string | number)[]): string => JSON.stringify(parts)

export const schemaKey = (schema: string): string => key('schema', schema)
export const groupKey = (schema: string, group: TableGroup): string => key('group', schema, group)
export const tableKey = (table: TableRef): string => key('table', table.schema, table.name)
export const sectionKey = (table: TableRef, section: TableSection): string =>
  key('section', table.schema, table.name, section)
export const leafKey = (table: TableRef, section: TableSection, index: number): string =>
  key('leaf', table.schema, table.name, section, index)
export const statusKey = (parent: string, status: 'error' | 'loading' | 'empty'): string =>
  key(status, parent)

/** Inversa de `tableKey`, para recargar tablas ya cargadas sin guardar la referencia aparte. */
export function tableRefFromKey(value: string): TableRef | null {
  try {
    const parts: unknown = JSON.parse(value)
    if (Array.isArray(parts) && parts[0] === 'table') {
      const [, schema, name] = parts
      if (typeof schema === 'string' && typeof name === 'string') return { schema, name }
    }
  } catch {
    return null
  }
  return null
}
