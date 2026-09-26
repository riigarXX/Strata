import type { Session, TableDetails, TableInfo } from '@strata/contracts'
import type { ConnectionManager } from '../connection-manager'

/** Lo único de la conexión activa que sale hacia el modelo: nombres, tipos y claves. Nunca filas ni valores de celdas. */
export type SchemaSource = Pick<ConnectionManager, 'listTables' | 'describeTable'>

export interface SchemaLimits {
  /** Tamaño máximo del texto del esquema (caracteres). */
  maxChars: number
  /** Tablas y vistas de las que se pide el detalle: cada una es una consulta al catálogo. */
  maxDescribed: number
  /** Presupuesto aparte para listar solo por nombre lo que no cupo. */
  maxNameChars: number
}

export const DEFAULT_SCHEMA_LIMITS: SchemaLimits = {
  maxChars: 16_000,
  maxDescribed: 150,
  maxNameChars: 1_500,
}

export interface SchemaContext {
  text: string
  /** Hubo objetos que no cupieron (o no se pudieron describir) y se quedaron fuera o solo con su nombre. */
  truncated: boolean
}

const MAX_IDENTIFIER_LENGTH = 64
const MAX_TYPE_LENGTH = 40
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f<>`]/g
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/
// Palabras reservadas que suelen ser nombres de tabla o columna (`user`, `order`, `group`): sin comillas rompen el SQL.
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'all',
  'analyse',
  'analyze',
  'and',
  'any',
  'as',
  'asc',
  'between',
  'by',
  'case',
  'cast',
  'check',
  'collate',
  'column',
  'constraint',
  'create',
  'cross',
  'current_date',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'delete',
  'desc',
  'distinct',
  'drop',
  'else',
  'end',
  'except',
  'exists',
  'false',
  'fetch',
  'for',
  'foreign',
  'from',
  'full',
  'grant',
  'group',
  'having',
  'in',
  'index',
  'inner',
  'insert',
  'intersect',
  'into',
  'is',
  'join',
  'left',
  'like',
  'limit',
  'natural',
  'not',
  'null',
  'offset',
  'on',
  'or',
  'order',
  'outer',
  'primary',
  'references',
  'right',
  'select',
  'session_user',
  'set',
  'some',
  'table',
  'then',
  'to',
  'true',
  'union',
  'unique',
  'update',
  'user',
  'using',
  'values',
  'when',
  'where',
  'window',
  'with',
])

/**
 * Los nombres los escribe quien administra la base de datos, no quien pregunta: pueden llevar instrucciones para
 * el modelo. Se les quita todo lo que rompe el formato (saltos de línea, `<`, `>`, comillas invertidas) y se
 * acotan; los que no son simples van entre comillas dobles, como hay que escribirlos en SQL.
 */
export function safeIdentifier(name: string): string {
  const cleaned = name.replace(UNSAFE_CHARACTERS, '_').slice(0, MAX_IDENTIFIER_LENGTH)
  return PLAIN_IDENTIFIER.test(cleaned) && !RESERVED_WORDS.has(cleaned)
    ? cleaned
    : `"${cleaned.replace(/"/g, '""')}"`
}

function safeType(dataType: string): string {
  return dataType.replace(UNSAFE_CHARACTERS, '_').replace(/\s+/g, ' ').slice(0, MAX_TYPE_LENGTH)
}

// `main` (SQLite) y `public` (PostgreSQL) se omiten: las tablas se escriben sin prefijo.
const DEFAULT_SCHEMAS: ReadonlySet<string> = new Set(['main', 'public'])

function qualified(schema: string, name: string): string {
  return DEFAULT_SCHEMAS.has(schema)
    ? safeIdentifier(name)
    : `${safeIdentifier(schema)}.${safeIdentifier(name)}`
}

function isView(kind: TableInfo['kind']): boolean {
  return kind === 'view' || kind === 'materialized_view'
}

/** Una línea por tabla: `TABLE users(id integer PK, org_id integer NOT NULL FK->orgs.id, email text NOT NULL)`. */
export function renderTable(details: TableDetails): string {
  const primary = new Set(details.primaryKey?.columns ?? [])
  const references = new Map<string, string>()
  for (const key of details.foreignKeys) {
    key.columns.forEach((column, index) => {
      const target = key.referencedColumns[index]
      if (target === undefined) return
      const { schema, name } = key.referencedTable
      references.set(column, `${qualified(schema, name)}.${safeIdentifier(target)}`)
    })
  }
  const columns = details.columns.map((column) => {
    const parts = [safeIdentifier(column.name), safeType(column.dataType)]
    if (primary.has(column.name)) parts.push('PK')
    else if (!column.nullable) parts.push('NOT NULL')
    const target = references.get(column.name)
    if (target !== undefined) parts.push(`FK->${target}`)
    return parts.join(' ')
  })
  const { schema, name, kind } = details.table
  return `${isView(kind) ? 'VIEW' : 'TABLE'} ${qualified(schema, name)}(${columns.join(', ')})`
}

const questionWords = (question: string): string[] => [
  ...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
]

// Sin la `s` o `es` final, para que «users» encuentre `user` y «orders», `order`.
const stem = (word: string): string => word.replace(/(?:es|s)$/, '')

/** Cuántas palabras de la pregunta aparecen en el nombre de la tabla: lo que se describe primero cuando no cabe todo. */
function relevance(table: TableInfo, words: readonly string[]): number {
  const name = table.name.toLowerCase()
  return words.filter((word) => name.includes(word) || name.includes(stem(word))).length
}

const KIND_ORDER: Readonly<Record<TableInfo['kind'], number>> = {
  table: 0,
  partitioned_table: 0,
  foreign_table: 1,
  view: 2,
  materialized_view: 2,
}

/** Orden estable y reproducible: relevancia para la pregunta, tablas antes que vistas, esquema y nombre. */
function order(tables: readonly TableInfo[], question: string): TableInfo[] {
  const words = questionWords(question)
  return tables
    .map((table) => ({ table, score: relevance(table, words) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        KIND_ORDER[a.table.kind] - KIND_ORDER[b.table.kind] ||
        a.table.schema.localeCompare(b.table.schema) ||
        a.table.name.localeCompare(b.table.name),
    )
    .map(({ table }) => table)
}

/**
 * Recoge el esquema de la sesión con los servicios de metadatos existentes y lo deja como texto compacto dentro
 * del presupuesto. Trunca de forma ordenada: primero lo más relevante para la pregunta; lo que no cabe se lista
 * solo por nombre y, pasado eso, se omite.
 */
export async function buildSchemaContext(
  source: SchemaSource,
  session: Pick<Session, 'sessionId'>,
  question: string,
  signal: AbortSignal,
  limits: SchemaLimits = DEFAULT_SCHEMA_LIMITS,
): Promise<SchemaContext> {
  const ordered = order(await source.listTables({ sessionId: session.sessionId }), question)
  const lines: string[] = []
  const nameOnly: TableInfo[] = []
  let used = 0
  let described = 0
  let full = false

  for (const table of ordered) {
    signal.throwIfAborted()
    if (full || described >= limits.maxDescribed) {
      nameOnly.push(table)
      continue
    }
    described++
    let line: string
    try {
      line = renderTable(
        await source.describeTable({
          sessionId: session.sessionId,
          table: { schema: table.schema, name: table.name },
        }),
      )
    } catch {
      // Un objeto que no se puede describir (permisos, se borró) no debe impedir preguntar por el resto.
      nameOnly.push(table)
      continue
    }
    if (used + line.length + 1 > limits.maxChars) {
      full = true
      nameOnly.push(table)
      continue
    }
    lines.push(line)
    used += line.length + 1
  }

  let truncated = false
  if (nameOnly.length > 0) {
    truncated = true
    const names: string[] = []
    let nameChars = 0
    for (const table of nameOnly) {
      const name = qualified(table.schema, table.name)
      if (nameChars + name.length + 2 > limits.maxNameChars) break
      names.push(name)
      nameChars += name.length + 2
    }
    if (names.length > 0) lines.push(`OTHER OBJECTS (columns omitted): ${names.join(', ')}`)
  }

  return { text: lines.join('\n'), truncated }
}
