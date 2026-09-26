import { describe, expect, it } from 'vitest'
import {
  DescribeTableRequestSchema,
  ListTablesRequestSchema,
  SchemaInfoSchema,
  TableDetailsSchema,
  TableInfoSchema,
} from './metadata'

const table = { schema: 'public', name: 'users', kind: 'table' }

describe('metadata schemas', () => {
  it('parses table details with keys and indexes', () => {
    const details = {
      table,
      columns: [
        {
          name: 'id',
          dataType: 'integer',
          nullable: false,
          defaultValue: "nextval('users_id_seq')",
        },
        { name: 'org_id', dataType: 'integer', nullable: true, defaultValue: null },
      ],
      primaryKey: { name: 'users_pkey', columns: ['id'] },
      foreignKeys: [
        {
          name: 'users_org_fk',
          columns: ['org_id'],
          referencedTable: { schema: 'public', name: 'orgs' },
          referencedColumns: ['id'],
          onUpdate: 'no_action',
          onDelete: 'cascade',
        },
      ],
      indexes: [{ name: 'users_pkey', columns: ['id'], unique: true }],
    }
    expect(TableDetailsSchema.parse(details)).toEqual(details)
    expect(TableDetailsSchema.safeParse({ ...details, primaryKey: null }).success).toBe(true)
  })

  it('rejects unknown table kinds and unknown keys', () => {
    expect(TableInfoSchema.safeParse({ ...table, kind: 'sequence' }).success).toBe(false)
    expect(TableInfoSchema.safeParse({ ...table, extra: 1 }).success).toBe(false)
  })

  it('distinguishes partitioned and foreign tables', () => {
    for (const kind of ['partitioned_table', 'foreign_table']) {
      expect(TableInfoSchema.safeParse({ ...table, kind }).success).toBe(true)
    }
  })

  it('lists a schema by name only', () => {
    expect(SchemaInfoSchema.safeParse({ name: 'public' }).success).toBe(true)
    expect(SchemaInfoSchema.safeParse({ name: 'public', isSystem: false }).success).toBe(false)
  })

  it('validates requests strictly', () => {
    expect(ListTablesRequestSchema.safeParse({ sessionId: 's1' }).success).toBe(true)
    expect(ListTablesRequestSchema.safeParse({ sessionId: 's1', schema: 'public' }).success).toBe(
      true,
    )
    expect(ListTablesRequestSchema.safeParse({ sessionId: 's1', schema: '' }).success).toBe(false)
    expect(
      DescribeTableRequestSchema.safeParse({
        sessionId: 's1',
        table: { schema: 'public', name: 'users' },
      }).success,
    ).toBe(true)
    expect(
      DescribeTableRequestSchema.safeParse({ sessionId: 's1', table: { name: 'users' } }).success,
    ).toBe(false)
    expect(
      DescribeTableRequestSchema.safeParse({
        sessionId: 's1',
        table: { schema: 'public', name: 'users' },
        extra: 1,
      }).success,
    ).toBe(false)
  })
})
