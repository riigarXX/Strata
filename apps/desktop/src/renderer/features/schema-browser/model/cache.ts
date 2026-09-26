import type { NormalizedError, SchemaInfo, TableDetails, TableInfo } from '@strata/contracts'

/**
 * Resultado de una carga de metadatos. Mientras se recarga conserva el `data` anterior para que el árbol
 * no parpadee; `seq` identifica la petición vigente y descarta respuestas superadas por un refresco.
 */
export interface Loadable<T> {
  status: 'loading' | 'ready' | 'error'
  data: T | null
  error: NormalizedError | null
  seq: number
}

/** Metadatos de una sesión: catálogo del servidor y estado de expansión. Nunca credenciales ni filas. */
export interface SessionCache {
  schemas: Loadable<SchemaInfo[]> | null
  /** Por nombre de schema. */
  tables: Record<string, Loadable<TableInfo[]>>
  /** Por `tableKey`. */
  details: Record<string, Loadable<TableDetails>>
  /** Expansión decidida por el usuario, por clave de nodo; lo no decidido usa el valor por defecto. */
  toggled: Record<string, boolean>
}

export function emptySessionCache(): SessionCache {
  return { schemas: null, tables: {}, details: {}, toggled: {} }
}
