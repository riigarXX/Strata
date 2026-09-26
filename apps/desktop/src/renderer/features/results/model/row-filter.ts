import type { CellValue } from '@strata/contracts'

type Rows = readonly (readonly CellValue[])[]

/** Cada cuántas filas se consulta el reloj: el coste de `performance.now()` no se nota y el presupuesto se respeta. */
const CLOCK_EVERY = 256

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

/** ¿Alguna celda contiene `needle` (ya en minúsculas)? `NULL` no es un valor y nunca coincide. */
export function rowMatches(row: readonly CellValue[], needle: string): boolean {
  for (let index = 0; index < row.length; index += 1) {
    const value = row[index]
    if (value === null || value === undefined) continue
    const text = typeof value === 'string' ? value : String(value)
    if (text.length >= needle.length && text.toLowerCase().includes(needle)) return true
  }
  return false
}

/**
 * Filtro de subcadena sin distinguir mayúsculas, incremental: recorre las filas por tandas con un presupuesto
 * de tiempo y recuerda hasta dónde llegó, así que las filas que se añadan después (el resultado sigue
 * llegando) solo cuestan las nuevas. `matches` guarda índices de fila en orden ascendente.
 */
export class RowFilter {
  readonly needle: string
  readonly matches: number[] = []
  #scanned = 0

  constructor(query: string) {
    this.needle = normalizeQuery(query)
  }

  get scanned(): number {
    return this.#scanned
  }

  isComplete(rowCount: number): boolean {
    return this.#scanned >= rowCount
  }

  /** Avanza mientras quede presupuesto (ms) y filas; devuelve cuántas filas revisó. */
  step(rows: Rows, budgetMs: number, now: () => number = () => performance.now()): number {
    const deadline = now() + budgetMs
    const startedAt = this.#scanned
    const end = rows.length
    let index = this.#scanned
    while (index < end) {
      if (rowMatches(rows[index]!, this.needle)) this.matches.push(index)
      index += 1
      if (index % CLOCK_EVERY === 0 && now() >= deadline) break
    }
    this.#scanned = index
    return index - startedAt
  }
}
