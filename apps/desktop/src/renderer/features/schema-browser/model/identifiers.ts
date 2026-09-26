import type { Engine, TableRef } from '@strata/contracts'

// Palabras que PostgreSQL no admite como nombre de tabla o columna sin comillas: categorías
// «reserved» y «reserved (can be function or type)» del apéndice C. Las «non-reserved» y
// «non-reserved (cannot be function or type)» (time, int, values…) sí son válidas como ColId.
const POSTGRES_RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check ' +
    'collate collation column concurrently constraint create cross current_catalog current_date ' +
    'current_role current_schema current_time current_timestamp current_user default deferrable ' +
    'desc distinct do else end except false fetch for foreign freeze from full grant group having ' +
    'ilike in initially inner intersect into is isnull join lateral leading left like limit ' +
    'localtime localtimestamp natural not notnull null offset on only or order outer overlaps ' +
    'placing primary references returning right select session_user similar some symmetric ' +
    'system_user table tablesample then to trailing true union unique user using variadic verbose ' +
    'when where window with'
  ).split(' '),
)

// Lista de palabras clave de https://sqlite.org/lang_keywords.html. SQLite tolera muchas como nombre,
// pero citarlas nunca es incorrecto y evita depender del contexto.
const SQLITE_KEYWORDS = new Set(
  (
    'abort action add after all alter always analyze and as asc attach autoincrement before begin ' +
    'between by cascade case cast check collate column commit conflict constraint create cross ' +
    'current current_date current_time current_timestamp database default deferrable deferred delete ' +
    'desc detach distinct do drop each else end escape except exclude exclusive exists explain fail ' +
    'filter first following for foreign from full generated glob group groups having if ignore ' +
    'immediate in index indexed initially inner insert instead intersect into is isnull join key ' +
    'last left like limit match materialized natural no not nothing notnull null nulls of offset on ' +
    'or order others outer over partition plan pragma preceding primary query raise range recursive ' +
    'references regexp reindex release rename replace restrict returning right rollback row rows ' +
    'savepoint select set table temp temporary then ties to transaction trigger unbounded union ' +
    'unique update using vacuum values view virtual when where window with without'
  ).split(' '),
)

// PostgreSQL pliega a minúsculas lo que no lleva comillas: solo el minúsculo simple ASCII es seguro
// (mismo criterio que `quote_ident`). SQLite no distingue mayúsculas en identificadores.
const POSTGRES_SIMPLE = /^[a-z_][a-z0-9_]*$/
const SQLITE_SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Cita `name` con comillas dobles solo si sin ellas dejaría de ser el mismo identificador. */
export function quoteIdentifier(engine: Engine, name: string): string {
  const simple = engine === 'postgres' ? POSTGRES_SIMPLE : SQLITE_SIMPLE
  const reserved = engine === 'postgres' ? POSTGRES_RESERVED : SQLITE_KEYWORDS
  return simple.test(name) && !reserved.has(name.toLowerCase()) ? name : quoted(name)
}

/**
 * Nombre de tabla listo para pegar en una consulta. PostgreSQL siempre lo cualifica con su schema;
 * en SQLite `main` es el ámbito por defecto y se omite (una base adjunta o `temp` sí se cualifica).
 */
export function qualifiedTableName(engine: Engine, table: TableRef): string {
  const name = quoteIdentifier(engine, table.name)
  return engine === 'sqlite' && table.schema === 'main'
    ? name
    : `${quoteIdentifier(engine, table.schema)}.${name}`
}
