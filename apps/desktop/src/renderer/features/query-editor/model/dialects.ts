import { PostgreSQL, SQLite, StandardSQL, type SQLDialect } from '@codemirror/lang-sql'
import type { Session } from '@strata/contracts'

export type SqlEngine = Session['engine']

export type FormatterDialect = 'postgresql' | 'sqlite' | 'sql'

/** Dialecto de resaltado para el motor de la sesión; sin sesión, SQL estándar. */
export function highlightDialect(engine: SqlEngine | null): SQLDialect {
  if (engine === 'postgres') return PostgreSQL
  if (engine === 'sqlite') return SQLite
  return StandardSQL
}

export function formatterDialect(engine: SqlEngine | null): FormatterDialect {
  if (engine === 'postgres') return 'postgresql'
  if (engine === 'sqlite') return 'sqlite'
  return 'sql'
}
