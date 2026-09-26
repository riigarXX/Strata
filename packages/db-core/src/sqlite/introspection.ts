import type {
  ColumnInfo,
  ForeignKey,
  ForeignKeyAction,
  IndexInfo,
  SchemaInfo,
  TableDetails,
  TableInfo,
  TableRef,
} from '@strata/contracts'
import type Database from 'better-sqlite3'
import { AdapterError, createNormalizedError } from '../normalization'

const DEFAULT_SCHEMA = 'main'
const EXPRESSION_COLUMN = '(expression)'

// Every name received from outside is checked against the catalog and only ever bound as a parameter (threat-model.md).
// pragma_table_list needs SQLite 3.37; the version is fixed by the bundled driver (3.49), not by the host system.
interface TableListRow {
  name: string
  type: string
}

interface ColumnRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  hidden: number
}

interface ForeignKeyRow {
  id: number
  table: string
  from: string
  to: string | null
  on_update: string
  on_delete: string
}

interface IndexListRow {
  name: string
  unique: number
  origin: string
}

interface IndexColumnRow {
  name: string | null
}

const FOREIGN_KEY_ACTIONS: Readonly<Record<string, ForeignKeyAction>> = {
  'NO ACTION': 'no_action',
  RESTRICT: 'restrict',
  CASCADE: 'cascade',
  'SET NULL': 'set_null',
  'SET DEFAULT': 'set_default',
}

function notFound(message: string): AdapterError {
  return new AdapterError(createNormalizedError('not_found', message))
}

function assertSchemaExists(db: Database.Database, schema: string): void {
  const found = db.prepare('SELECT 1 FROM pragma_database_list WHERE name = ?').pluck().get(schema)
  if (found === undefined) {
    throw notFound('The schema does not exist')
  }
}

export function listSchemas(db: Database.Database): SchemaInfo[] {
  const rows = db
    .prepare<[], { name: string }>('SELECT name FROM pragma_database_list ORDER BY seq')
    .all()
  return rows.map(({ name }) => ({ name }))
}

export function listTables(db: Database.Database, schema: string = DEFAULT_SCHEMA): TableInfo[] {
  assertSchemaExists(db, schema)
  const rows = db
    .prepare<[string], TableListRow>(
      `SELECT name, type FROM pragma_table_list
       WHERE schema = ? AND type IN ('table', 'view', 'virtual') AND name NOT LIKE 'sqlite!_%' ESCAPE '!'
       ORDER BY name`,
    )
    .all(schema)
  return rows.map(({ name, type }) => ({
    schema,
    name,
    kind: type === 'view' ? 'view' : 'table',
  }))
}

function readColumns(db: Database.Database, table: TableRef): ColumnRow[] {
  return db
    .prepare<[string, string], ColumnRow>(
      'SELECT * FROM pragma_table_xinfo(?, ?) WHERE hidden <> 1 ORDER BY cid',
    )
    .all(table.name, table.schema)
}

function primaryKeyColumns(columns: readonly ColumnRow[]): string[] {
  return columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
}

function readForeignKeys(db: Database.Database, table: TableRef): ForeignKey[] {
  const rows = db
    .prepare<[string, string], ForeignKeyRow>(
      'SELECT * FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq',
    )
    .all(table.name, table.schema)

  const groups = new Map<number, ForeignKeyRow[]>()
  for (const row of rows) {
    groups.set(row.id, [...(groups.get(row.id) ?? []), row])
  }

  const foreignKeys: ForeignKey[] = []
  for (const group of groups.values()) {
    const [first] = group
    if (!first) continue
    const explicit = group.map((row) => row.to)
    const referencedColumns = explicit.every((column): column is string => column !== null)
      ? explicit
      : primaryKeyColumns(readColumns(db, { schema: table.schema, name: first.table }))
    // A dangling reference to an unknown primary key cannot be represented, so it is left out.
    if (referencedColumns.length === 0) continue

    foreignKeys.push({
      name: null,
      columns: group.map((row) => row.from),
      referencedTable: { schema: table.schema, name: first.table },
      referencedColumns,
      onUpdate: FOREIGN_KEY_ACTIONS[first.on_update.toUpperCase()] ?? 'no_action',
      onDelete: FOREIGN_KEY_ACTIONS[first.on_delete.toUpperCase()] ?? 'no_action',
    })
  }
  return foreignKeys
}

// The primary key has its own section, so its implicit index (origin 'pk') is not repeated here.
function readIndexes(db: Database.Database, table: TableRef): IndexInfo[] {
  const indexes = db
    .prepare<[string, string], IndexListRow>('SELECT * FROM pragma_index_list(?, ?)')
    .all(table.name, table.schema)
    .filter((index) => index.origin !== 'pk')

  const readIndexColumns = db.prepare<[string, string], IndexColumnRow>(
    'SELECT name FROM pragma_index_xinfo(?, ?) WHERE key = 1 ORDER BY seqno',
  )

  return indexes.flatMap((index) => {
    const columns = readIndexColumns
      .all(index.name, table.schema)
      .map((column) => column.name ?? EXPRESSION_COLUMN)
    return columns.length === 0 ? [] : [{ name: index.name, columns, unique: index.unique === 1 }]
  })
}

export function describeTable(db: Database.Database, table: TableRef): TableDetails {
  const info = db
    .prepare<[string, string], TableListRow>(
      `SELECT name, type FROM pragma_table_list
       WHERE schema = ? AND name = ? AND type IN ('table', 'view', 'virtual')`,
    )
    .get(table.schema, table.name)
  if (!info) {
    throw notFound('The table or view does not exist')
  }

  const columnRows = readColumns(db, table)
  const primaryKey = primaryKeyColumns(columnRows)

  const columns: ColumnInfo[] = columnRows.map((column) => ({
    name: column.name,
    dataType: column.type.trim() || 'ANY',
    // A primary key column is reported as non-nullable: SQLite itself only enforces it for INTEGER PRIMARY KEY and STRICT tables.
    nullable: column.notnull === 0 && column.pk === 0,
    defaultValue: column.dflt_value,
  }))

  return {
    table: { schema: table.schema, name: info.name, kind: info.type === 'view' ? 'view' : 'table' },
    columns,
    primaryKey: primaryKey.length > 0 ? { name: null, columns: primaryKey } : null,
    foreignKeys: readForeignKeys(db, table),
    indexes: readIndexes(db, table),
  }
}
