import type { Engine } from '@strata/contracts'
import { analyzeSql, type AnalyzedStatement } from '@strata/db-core'

/**
 * Sentencias del texto que la heurística de ADR 0004 considera destructivas. Es una ayuda de UX, no una
 * barrera: el bloqueo real de los perfiles de solo lectura lo hace main.
 */
export function findDestructiveStatements(engine: Engine, sql: string): AnalyzedStatement[] {
  return analyzeSql(engine, sql).filter((statement) => statement.isDestructive)
}

const REASONS: Record<string, string> = {
  DROP: 'Elimina objetos de la base de datos',
  TRUNCATE: 'Vacía la tabla entera',
  DELETE: 'Borra filas sin cláusula WHERE',
  UPDATE: 'Modifica todas las filas: no tiene cláusula WHERE',
  ALTER: 'Elimina columnas u otros elementos de la estructura',
}

export function describeDestructive(statement: Pick<AnalyzedStatement, 'command'>): string {
  return REASONS[statement.command] ?? 'Puede eliminar datos o cambiar la estructura'
}
