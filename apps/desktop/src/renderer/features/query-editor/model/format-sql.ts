import { formatterDialect, type SqlEngine } from './dialects'

/**
 * Formatea con `sql-formatter`. Se importa bajo demanda (y solo los dialectos usados, vía
 * `formatDialect`) para que el formateador quede en su propio chunk y no pese en el arranque.
 */
export async function formatSql(text: string, engine: SqlEngine | null): Promise<string> {
  const { formatDialect, postgresql, sqlite, sql } = await import('sql-formatter')
  const dialects = { postgresql, sqlite, sql }
  return formatDialect(text, { dialect: dialects[formatterDialect(engine)] })
}
