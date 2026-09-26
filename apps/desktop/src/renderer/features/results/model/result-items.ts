import type { ResultSetView } from '../../execution/model/result-buffers'
import type { StatementSummary } from '../../execution/stores/execution'

/** Una sentencia del script tal como la lista el selector: con filas (o columnas) o sin ellas. */
export interface ResultItem {
  statementIndex: number
  set: ResultSetView | null
  summary: StatementSummary | null
}

/**
 * Une los conjuntos de filas del búfer con los resúmenes por sentencia del store. Una sentencia puede tener
 * solo resumen (no devuelve filas o se descartó), solo conjunto (aún ejecutándose) o ambos.
 */
export function buildResultItems(
  sets: readonly ResultSetView[],
  statements: readonly StatementSummary[],
): ResultItem[] {
  const items = new Map<number, ResultItem>()
  for (const summary of statements) {
    items.set(summary.statementIndex, {
      statementIndex: summary.statementIndex,
      set: null,
      summary,
    })
  }
  for (const set of sets) {
    const existing = items.get(set.statementIndex)
    items.set(set.statementIndex, {
      statementIndex: set.statementIndex,
      set,
      summary: existing?.summary ?? null,
    })
  }
  return [...items.values()].sort((a, b) => a.statementIndex - b.statementIndex)
}

/** Lo que se muestra por defecto: la última sentencia que devolvió filas y, si ninguna, la última. */
export function defaultItem(items: readonly ResultItem[]): ResultItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.set !== null) return items[index]!
  }
  return items.at(-1) ?? null
}
