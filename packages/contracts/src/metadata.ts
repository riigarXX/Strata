import { z } from 'zod'
import { SessionIdSchema } from './connections'

const IdentifierSchema = z.string().min(1).max(256)

// Adapters list only user-visible schemas: system catalogs (pg_catalog, information_schema...) are never exposed here.
export const SchemaInfoSchema = z.strictObject({
  name: IdentifierSchema,
})
export type SchemaInfo = z.infer<typeof SchemaInfoSchema>

// SQLite tables use the schema name 'main' (or an attached database name).
export const TableRefSchema = z.strictObject({
  schema: IdentifierSchema,
  name: IdentifierSchema,
})
export type TableRef = z.infer<typeof TableRefSchema>

export const TableKindSchema = z.enum([
  'table',
  'partitioned_table',
  'foreign_table',
  'view',
  'materialized_view',
])
export type TableKind = z.infer<typeof TableKindSchema>

export const TableInfoSchema = TableRefSchema.extend({ kind: TableKindSchema })
export type TableInfo = z.infer<typeof TableInfoSchema>

export const ColumnInfoSchema = z.strictObject({
  name: IdentifierSchema,
  dataType: z.string().min(1).max(256),
  nullable: z.boolean(),
  defaultValue: z.string().nullable(),
})
export type ColumnInfo = z.infer<typeof ColumnInfoSchema>

export const PrimaryKeySchema = z.strictObject({
  name: IdentifierSchema.nullable(),
  columns: z.array(IdentifierSchema).min(1),
})
export type PrimaryKey = z.infer<typeof PrimaryKeySchema>

export const ForeignKeyActionSchema = z.enum([
  'no_action',
  'restrict',
  'cascade',
  'set_null',
  'set_default',
])
export type ForeignKeyAction = z.infer<typeof ForeignKeyActionSchema>

export const ForeignKeySchema = z.strictObject({
  name: IdentifierSchema.nullable(),
  columns: z.array(IdentifierSchema).min(1),
  referencedTable: TableRefSchema,
  referencedColumns: z.array(IdentifierSchema).min(1),
  onUpdate: ForeignKeyActionSchema,
  onDelete: ForeignKeyActionSchema,
})
export type ForeignKey = z.infer<typeof ForeignKeySchema>

export const IndexInfoSchema = z.strictObject({
  name: IdentifierSchema,
  columns: z.array(z.string().min(1).max(1024)).min(1),
  unique: z.boolean(),
})
export type IndexInfo = z.infer<typeof IndexInfoSchema>

export const TableDetailsSchema = z.strictObject({
  table: TableInfoSchema,
  columns: z.array(ColumnInfoSchema),
  primaryKey: PrimaryKeySchema.nullable(),
  foreignKeys: z.array(ForeignKeySchema),
  indexes: z.array(IndexInfoSchema),
})
export type TableDetails = z.infer<typeof TableDetailsSchema>

export const ListSchemasRequestSchema = z.strictObject({ sessionId: SessionIdSchema })
export type ListSchemasRequest = z.infer<typeof ListSchemasRequestSchema>

export const ListTablesRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  schema: IdentifierSchema.optional(),
})
export type ListTablesRequest = z.infer<typeof ListTablesRequestSchema>

export const DescribeTableRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  table: TableRefSchema,
})
export type DescribeTableRequest = z.infer<typeof DescribeTableRequestSchema>
