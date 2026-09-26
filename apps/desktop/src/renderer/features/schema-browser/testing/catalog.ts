import type { ColumnInfo, Session, TableDetails, TableInfo, TableKind } from '@strata/contracts'
import type { FakeCatalog } from '../../connections/testing/fake-db'

export const table = (schema: string, name: string, kind: TableKind = 'table'): TableInfo => ({
  schema,
  name,
  kind,
})

export const column = (name: string, dataType: string, nullable = true): ColumnInfo => ({
  name,
  dataType,
  nullable,
  defaultValue: null,
})

const usersDetails: TableDetails = {
  table: table('public', 'users'),
  columns: [
    column('id', 'integer', false),
    column('email', 'text', false),
    column('Full Name', 'text'),
  ],
  primaryKey: { name: 'users_pkey', columns: ['id'] },
  foreignKeys: [],
  indexes: [{ name: 'users_email_key', columns: ['email'], unique: true }],
}

const ordersDetails: TableDetails = {
  table: table('public', 'orders'),
  columns: [column('id', 'integer', false), column('user_id', 'integer', false)],
  primaryKey: { name: 'orders_pkey', columns: ['id'] },
  foreignKeys: [
    {
      name: 'orders_user_fk',
      columns: ['user_id'],
      referencedTable: { schema: 'public', name: 'users' },
      referencedColumns: ['id'],
      onUpdate: 'no_action',
      onDelete: 'cascade',
    },
  ],
  indexes: [{ name: 'orders_user_idx', columns: ['user_id', 'id'], unique: false }],
}

/** Dos schemas, un nombre con mayúsculas y espacios, una palabra reservada y los cinco tipos de tabla. */
export const POSTGRES_CATALOG: FakeCatalog = {
  schemas: ['public', 'Sales'],
  tables: {
    public: [
      table('public', 'users'),
      table('public', 'orders'),
      table('public', 'user', 'table'),
      table('public', 'active_users', 'view'),
      table('public', 'totals', 'materialized_view'),
      table('public', 'events', 'partitioned_table'),
      table('public', 'remote_stats', 'foreign_table'),
    ],
    Sales: [table('Sales', 'Invoice Lines')],
  },
  details: [
    usersDetails,
    ordersDetails,
    {
      table: table('Sales', 'Invoice Lines'),
      columns: [column('Line-No', 'integer', false), column('order', 'text')],
      primaryKey: null,
      foreignKeys: [],
      indexes: [],
    },
  ],
}

export const SQLITE_CATALOG: FakeCatalog = {
  schemas: ['main'],
  tables: {
    main: [
      table('main', 'Customers'),
      table('main', 'order items'),
      table('main', 'recent', 'view'),
    ],
  },
  details: [
    {
      table: table('main', 'Customers'),
      columns: [column('id', 'INTEGER', false), column('name', 'TEXT')],
      primaryKey: { name: null, columns: ['id'] },
      foreignKeys: [],
      indexes: [],
    },
  ],
}

export const postgresSession: Session = {
  sessionId: 's-pg',
  profileId: 'pg1',
  engine: 'postgres',
  serverVersion: '17.0',
  readOnly: false,
  transaction: 'none',
}

export const sqliteSession: Session = {
  sessionId: 's-sq',
  profileId: 'sq1',
  engine: 'sqlite',
  serverVersion: '3.46.0',
  readOnly: false,
  transaction: 'none',
}
