import type { CellValue, ResultColumn, TruncatedCell } from '@strata/contracts'
import { shallowReactive } from 'vue'

export interface ResultSetView {
  readonly statementIndex: number
  readonly columns: readonly ResultColumn[]
  /** Solo se añaden filas al final, así que un grid puede conservar su posición entre versiones. */
  readonly rows: readonly (readonly CellValue[])[]
  /** Filas que main envió de esta sentencia; mayor que `rows.length` si el búfer descartó las que no cabían. */
  readonly rowsReceived: number
  /**
   * Celdas que main cortó por su tope de bytes. `row` es el índice **absoluto** en `rows` (no el del chunk),
   * así que sigue valiendo aunque lleguen más chunks; solo aparecen las celdas cuya fila se conservó.
   * Append-only, como `rows`.
   */
  readonly truncated: readonly TruncatedCell[]
  /** Índice de `truncated` para consulta O(1): usa `truncatedBytes` en lugar de calcular la clave a mano. */
  readonly truncatedIndex: ReadonlyMap<number, number>
}

/** Bytes originales de la celda si main la cortó; `null` si está completa. */
export function truncatedBytes(
  set: Pick<ResultSetView, 'columns' | 'truncatedIndex'>,
  row: number,
  column: number,
): number | null {
  return set.truncatedIndex.get(row * set.columns.length + column) ?? null
}

export interface ResultSnapshot {
  /** Cambia con cada chunk, descarte o reinicio: leerlo en un `computed` hace reactivo el snapshot. */
  readonly version: number
  /** Identifica la ejecución a la que pertenece el búfer; cambia en cada `begin`, así que sirve para reiniciar estado de UI. */
  readonly generation: number
  readonly sets: readonly ResultSetView[]
  readonly rowsReceived: number
  /** Conjuntos de resultados anteriores que se descartaron para que los últimos quepan en el presupuesto. */
  readonly evictedSets: number
}

export interface ChunkRows {
  readonly statementIndex: number
  readonly columns: readonly ResultColumn[]
  readonly rows: readonly (readonly CellValue[])[]
  /** Con `row` relativo a este chunk, tal como llega de main. */
  readonly truncated?: readonly TruncatedCell[] | undefined
}

interface MutableSet {
  readonly statementIndex: number
  readonly columns: readonly ResultColumn[]
  readonly rows: (readonly CellValue[])[]
  rowsReceived: number
  readonly truncated: TruncatedCell[]
  readonly truncatedIndex: Map<number, number>
}

interface TabBuffer {
  readonly generation: number
  readonly maxRows: number
  readonly sets: MutableSet[]
  stored: number
  received: number
  evicted: number
}

const EMPTY: ResultSnapshot = Object.freeze({
  version: 0,
  generation: 0,
  sets: Object.freeze([]) as readonly ResultSetView[],
  rowsReceived: 0,
  evictedSets: 0,
})

/**
 * Búfer de filas por pestaña, fuera de Pinia (las filas nunca son estado reactivo ni serializable).
 * Interfaz para el grid: `snapshot(tabId)` dentro de un `computed`; los `rows` que devuelve son arrays
 * compartidos y de solo lectura, y `version` avisa de que hay que releerlos.
 *
 * Acotado: entre todos los conjuntos de una ejecución se guardan como mucho `maxRows` filas. Si un
 * conjunto nuevo no cabe se descartan los más antiguos, de modo que el último resultado siempre se conserva.
 */
export class ResultBuffers {
  readonly #tabs = new Map<string, TabBuffer>()
  readonly #versions = shallowReactive(new Map<string, number>())
  #clock = 0
  #generation = 0

  /** Descarta lo anterior de la pestaña y abre un búfer nuevo limitado a `maxRows` filas. */
  begin(tabId: string, maxRows: number): void {
    this.#generation += 1
    this.#tabs.set(tabId, {
      generation: this.#generation,
      maxRows,
      sets: [],
      stored: 0,
      received: 0,
      evicted: 0,
    })
    this.#bump(tabId)
  }

  append(tabId: string, chunk: ChunkRows): void {
    const buffer = this.#tabs.get(tabId)
    if (!buffer) return

    let set = buffer.sets.find((entry) => entry.statementIndex === chunk.statementIndex)
    if (!set) {
      set = {
        statementIndex: chunk.statementIndex,
        columns: chunk.columns,
        rows: [],
        rowsReceived: 0,
        truncated: [],
        truncatedIndex: new Map(),
      }
      buffer.sets.push(set)
    }
    const incoming = chunk.rows.length
    set.rowsReceived += incoming
    buffer.received += incoming

    while (buffer.maxRows - buffer.stored < incoming && buffer.sets[0] !== set) {
      const oldest = buffer.sets.shift()
      if (!oldest) break
      buffer.stored -= oldest.rows.length
      buffer.evicted += 1
    }
    const accepted = Math.max(0, Math.min(incoming, buffer.maxRows - buffer.stored))
    const base = set.rows.length
    for (let index = 0; index < accepted; index += 1) {
      set.rows.push(chunk.rows[index]!)
    }
    for (const cell of chunk.truncated ?? []) {
      if (cell.row >= accepted) continue
      const row = base + cell.row
      set.truncated.push({ row, column: cell.column, originalBytes: cell.originalBytes })
      set.truncatedIndex.set(row * set.columns.length + cell.column, cell.originalBytes)
    }
    buffer.stored += accepted
    this.#bump(tabId)
  }

  /** Olvida la pestaña (cierre); los lectores reciben un snapshot vacío. */
  discard(tabId: string): void {
    this.#tabs.delete(tabId)
    this.#versions.delete(tabId)
  }

  snapshot(tabId: string): ResultSnapshot {
    const version = this.#versions.get(tabId)
    const buffer = this.#tabs.get(tabId)
    if (version === undefined || !buffer) return EMPTY
    return {
      version,
      generation: buffer.generation,
      sets: buffer.sets.map((set) => ({
        statementIndex: set.statementIndex,
        columns: set.columns,
        rows: set.rows,
        rowsReceived: set.rowsReceived,
        truncated: set.truncated,
        truncatedIndex: set.truncatedIndex,
      })),
      rowsReceived: buffer.received,
      evictedSets: buffer.evicted,
    }
  }

  #bump(tabId: string): void {
    this.#clock += 1
    this.#versions.set(tabId, this.#clock)
  }
}

const buffers = new ResultBuffers()

/** Búfer único de la aplicación; los tests lo aíslan con instancias propias de `ResultBuffers`. */
export function useResultBuffers(): ResultBuffers {
  return buffers
}
