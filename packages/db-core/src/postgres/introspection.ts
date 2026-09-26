import type {
  ColumnInfo,
  ForeignKey,
  ForeignKeyAction,
  IndexInfo,
  PrimaryKey,
  SchemaInfo,
  TableDetails,
  TableInfo,
  TableKind,
  TableRef,
} from '@strata/contracts'
import type { Client } from 'pg'
import { AdapterError, createNormalizedError } from '../normalization'

// Every name received from outside is only ever bound as a parameter ($1...) against the catalog (threat-model.md).
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast']
// Per-session temporary schemas (pg_temp_3, pg_toast_temp_3...) are noise for a schema browser.
const VISIBLE_SCHEMA = `n.nspname <> ALL($1::text[]) AND n.nspname !~ '^pg_(toast_)?temp_'`
// r table, p partitioned table, f foreign table, v view, m materialized view.
const RELATION_KINDS = `c.relkind IN ('r', 'p', 'f', 'v', 'm')`

const TABLE_KINDS: Readonly<Record<string, TableKind>> = {
  r: 'table',
  p: 'partitioned_table',
  f: 'foreign_table',
  v: 'view',
  m: 'materialized_view',
}

const FOREIGN_KEY_ACTIONS: Readonly<Record<string, ForeignKeyAction>> = {
  a: 'no_action',
  r: 'restrict',
  c: 'cascade',
  n: 'set_null',
  d: 'set_default',
}

interface RelationRow {
  oid: number
  schema: string
  name: string
  relkind: string
}

interface ColumnRow {
  name: string
  data_type: string
  nullable: boolean
  default_value: string | null
}

interface ConstraintRow {
  name: string
  type: string
  columns: string[]
  referenced_schema: string | null
  referenced_table: string | null
  referenced_columns: string[] | null
  update_action: string
  delete_action: string
}

interface IndexRow {
  name: string
  is_unique: boolean
  columns: string[]
}

function notFound(message: string): AdapterError {
  return new AdapterError(createNormalizedError('not_found', message))
}

function kindOf(relkind: string): TableKind {
  return TABLE_KINDS[relkind] ?? 'table'
}

export async function listSchemas(client: Client): Promise<SchemaInfo[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT n.nspname::text AS name FROM pg_namespace n WHERE ${VISIBLE_SCHEMA} ORDER BY n.nspname`,
    [SYSTEM_SCHEMAS],
  )
  return rows.map(({ name }) => ({ name }))
}

export async function listTables(client: Client, schema?: string): Promise<TableInfo[]> {
  const { rows } = await client.query<Omit<RelationRow, 'oid'>>(
    `SELECT n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${RELATION_KINDS} AND ${VISIBLE_SCHEMA} AND ($2::text IS NULL OR n.nspname = $2::text)
     ORDER BY n.nspname, c.relname`,
    [SYSTEM_SCHEMAS, schema ?? null],
  )

  if (rows.length === 0 && schema !== undefined) {
    const known = await client.query(
      `SELECT 1 FROM pg_namespace n WHERE ${VISIBLE_SCHEMA} AND n.nspname = $2`,
      [SYSTEM_SCHEMAS, schema],
    )
    if (known.rowCount === 0) {
      throw notFound('The schema does not exist')
    }
  }

  return rows.map(({ schema: schemaName, name, relkind }) => ({
    schema: schemaName,
    name,
    kind: kindOf(relkind),
  }))
}

async function findRelation(client: Client, table: TableRef): Promise<RelationRow> {
  const { rows } = await client.query<RelationRow>(
    `SELECT c.oid AS oid, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${RELATION_KINDS} AND ${VISIBLE_SCHEMA} AND n.nspname = $2 AND c.relname = $3`,
    [SYSTEM_SCHEMAS, table.schema, table.name],
  )
  const [relation] = rows
  if (!relation) {
    throw notFound('The table or view does not exist')
  }
  return relation
}

async function readColumns(client: Client, oid: number): Promise<ColumnInfo[]> {
  const { rows } = await client.query<ColumnRow>(
    `SELECT a.attname::text AS name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS default_value
     FROM pg_attribute a
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [oid],
  )
  return rows.map((row) => ({
    name: row.name,
    dataType: row.data_type,
    nullable: row.nullable,
    defaultValue: row.default_value,
  }))
}

// Column lists keep the order in which the constraint declares them (conkey is positional), not attnum order.
async function readConstraints(client: Client, oid: number): Promise<ConstraintRow[]> {
  const { rows } = await client.query<ConstraintRow>(
    `SELECT con.conname::text AS name,
            con.contype::text AS type,
            ARRAY(SELECT a.attname::text
                  FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                  ORDER BY k.ord) AS columns,
            rn.nspname::text AS referenced_schema,
            rc.relname::text AS referenced_table,
            CASE WHEN con.contype = 'f' THEN
              ARRAY(SELECT a.attname::text
                    FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                    ORDER BY k.ord)
            END AS referenced_columns,
            con.confupdtype::text AS update_action,
            con.confdeltype::text AS delete_action
     FROM pg_constraint con
     LEFT JOIN pg_class rc ON rc.oid = con.confrelid
     LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
     WHERE con.conrelid = $1 AND con.contype IN ('p', 'f')
     ORDER BY con.conname`,
    [oid],
  )
  return rows
}

// The primary key has its own section, so its index is not repeated here.
async function readIndexes(client: Client, oid: number): Promise<IndexInfo[]> {
  const { rows } = await client.query<IndexRow>(
    `SELECT ic.relname::text AS name,
            i.indisunique AS is_unique,
            ARRAY(SELECT pg_get_indexdef(i.indexrelid, k.n, true)
                  FROM generate_series(1, i.indnkeyatts::int) AS k(n)
                  ORDER BY k.n) AS columns
     FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indrelid = $1 AND NOT i.indisprimary
     ORDER BY ic.relname`,
    [oid],
  )
  return rows.flatMap((row) =>
    row.columns.length === 0
      ? []
      : [{ name: row.name, columns: row.columns, unique: row.is_unique }],
  )
}

function toForeignKey(row: ConstraintRow): ForeignKey[] {
  if (row.referenced_schema === null || row.referenced_table === null) return []
  const referencedColumns = row.referenced_columns ?? []
  if (row.columns.length === 0 || referencedColumns.length === 0) return []
  return [
    {
      name: row.name,
      columns: row.columns,
      referencedTable: { schema: row.referenced_schema, name: row.referenced_table },
      referencedColumns,
      onUpdate: FOREIGN_KEY_ACTIONS[row.update_action] ?? 'no_action',
      onDelete: FOREIGN_KEY_ACTIONS[row.delete_action] ?? 'no_action',
    },
  ]
}

export async function describeTable(client: Client, table: TableRef): Promise<TableDetails> {
  const relation = await findRelation(client, table)
  const columns = await readColumns(client, relation.oid)
  const constraints = await readConstraints(client, relation.oid)
  const indexes = await readIndexes(client, relation.oid)

  const primary = constraints.find((constraint) => constraint.type === 'p')
  const primaryKey: PrimaryKey | null =
    primary && primary.columns.length > 0 ? { name: primary.name, columns: primary.columns } : null

  return {
    table: { schema: relation.schema, name: relation.name, kind: kindOf(relation.relkind) },
    columns,
    primaryKey,
    foreignKeys: constraints.filter((constraint) => constraint.type === 'f').flatMap(toForeignKey),
    indexes,
  }
}
