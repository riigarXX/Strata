import {
  SchemaInfoSchema,
  TableDetailsSchema,
  TableInfoSchema,
  type Session,
} from '@strata/contracts'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createPostgresAdapter } from '../adapter'
import {
  asAdmin,
  asApp,
  createSchema,
  describeEachTarget,
  dropSchema,
  profileFor,
  rejection,
  run,
  type PgTarget,
} from './support'

const adapter = createPostgresAdapter()
const sessions: Session[] = []

async function open(target: PgTarget) {
  const session = await adapter.connect(profileFor(target))
  sessions.push(session)
  return session
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await adapter.disconnect(session.sessionId)
  }
})

describeEachTarget('PostgreSQL introspection', (target) => {
  let schema = ''
  let hasForeignTable = false
  const server = `strata_srv_${Math.random().toString(36).slice(2, 8)}`
  const quotedSchema = `Strata Odd ${Math.random().toString(36).slice(2, 8)}`

  beforeAll(async () => {
    schema = await createSchema(
      target,
      `CREATE TABLE $SCHEMA.parent (
         id serial PRIMARY KEY,
         code text NOT NULL,
         note text DEFAULT 'n/a',
         CONSTRAINT parent_code_key UNIQUE (code)
       );
       CREATE TABLE $SCHEMA.pair (x integer, y integer, PRIMARY KEY (x, y));
       CREATE TABLE $SCHEMA.child (
         seq integer,
         id integer,
         parent_id integer NOT NULL REFERENCES $SCHEMA.parent (id) ON DELETE CASCADE ON UPDATE RESTRICT,
         px integer,
         py integer,
         price numeric(10, 2) DEFAULT 0,
         label text,
         CONSTRAINT child_pk PRIMARY KEY (id, seq),
         CONSTRAINT child_pair_fk FOREIGN KEY (py, px) REFERENCES $SCHEMA.pair (y, x) ON DELETE SET NULL
       );
       CREATE UNIQUE INDEX child_label_parent_uq ON $SCHEMA.child (label, parent_id);
       CREATE INDEX child_lower_label_idx ON $SCHEMA.child (lower(label));
       CREATE VIEW $SCHEMA.child_view AS SELECT id, label FROM $SCHEMA.child;
       CREATE MATERIALIZED VIEW $SCHEMA.child_mv AS SELECT id, label FROM $SCHEMA.child;
       CREATE UNIQUE INDEX child_mv_id_idx ON $SCHEMA.child_mv (id);
       CREATE TABLE $SCHEMA.events (id integer, at timestamptz NOT NULL) PARTITION BY RANGE (at);
       CREATE TABLE $SCHEMA.events_2024 PARTITION OF $SCHEMA.events
         FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');`,
    )

    // A foreign table needs a superuser to create the wrapper; it is optional so a restricted external server can still run the rest.
    try {
      await asAdmin(target, async (client) => {
        await client.query('CREATE EXTENSION IF NOT EXISTS postgres_fdw')
        await client.query(`CREATE SERVER ${server} FOREIGN DATA WRAPPER postgres_fdw`)
        await client.query(`GRANT USAGE ON FOREIGN SERVER ${server} TO ${target.appUser}`)
      })
      await asApp(target, (client) =>
        client.query(
          `CREATE FOREIGN TABLE ${schema}.remote_things (id integer) SERVER ${server} OPTIONS (table_name 'things')`,
        ),
      )
      hasForeignTable = true
    } catch {
      hasForeignTable = false
    }

    await asApp(target, async (client) => {
      await client.query(`CREATE SCHEMA "${quotedSchema}"`)
      await client.query(`CREATE TABLE "${quotedSchema}"."Mixed Case" ("Odd Column" integer)`)
    })
  })

  afterAll(async () => {
    await asApp(target, (client) => client.query(`DROP SCHEMA IF EXISTS "${quotedSchema}" CASCADE`))
    await dropSchema(target, schema)
    await asAdmin(target, (client) => client.query(`DROP SERVER IF EXISTS ${server} CASCADE`))
  })

  it('lists user schemas and leaves out the system ones', async () => {
    const session = await open(target)
    const schemas = await adapter.listSchemas(session.sessionId)
    const names = schemas.map((info) => info.name)
    expect(names).toContain(schema)
    expect(names).toContain('public')
    for (const system of ['pg_catalog', 'information_schema', 'pg_toast']) {
      expect(names).not.toContain(system)
    }
    expect(names.some((name) => /^pg_(toast_)?temp_/.test(name))).toBe(false)
    expect(names).toEqual([...names].sort())
    for (const info of schemas) {
      expect(SchemaInfoSchema.parse(info)).toEqual(info)
      expect(Object.keys(info)).toEqual(['name'])
    }
  })

  it('lists tables, views, materialized views, partitioned and foreign tables of a schema', async () => {
    const session = await open(target)
    const tables = await adapter.listTables(session.sessionId, schema)
    const expected = [
      ['child', 'table'],
      ['child_mv', 'materialized_view'],
      ['child_view', 'view'],
      ['events', 'partitioned_table'],
      ['events_2024', 'table'],
      ['pair', 'table'],
      ['parent', 'table'],
      ...(hasForeignTable ? [['remote_things', 'foreign_table']] : []),
    ]
    expect(tables.map((table) => [table.name, table.kind])).toEqual(expected)
    expect(tables.every((table) => table.schema === schema)).toBe(true)
    for (const table of tables) {
      expect(TableInfoSchema.parse(table)).toEqual(table)
    }
  })

  it('lists tables across every user schema when none is given, never the system catalogs', async () => {
    const session = await open(target)
    const tables = await adapter.listTables(session.sessionId)
    const schemas = new Set(tables.map((table) => table.schema))
    expect(schemas).toContain(schema)
    expect(schemas).toContain(quotedSchema)
    for (const system of ['pg_catalog', 'information_schema', 'pg_toast']) {
      expect(schemas).not.toContain(system)
    }
  })

  it('rejects an unknown or system schema', async () => {
    const session = await open(target)
    for (const name of ['strata_no_such_schema', 'pg_catalog', 'information_schema']) {
      expect(await rejection(adapter.listTables(session.sessionId, name))).toMatchObject({
        code: 'not_found',
      })
    }
  })

  it('returns an empty list for an existing schema without tables', async () => {
    const empty = await createSchema(target)
    try {
      const session = await open(target)
      expect(await adapter.listTables(session.sessionId, empty)).toEqual([])
    } finally {
      await dropSchema(target, empty)
    }
  })

  it('describes columns, types, defaults and nullability', async () => {
    const session = await open(target)
    const details = await adapter.describeTable(session.sessionId, { schema, name: 'parent' })
    expect(TableDetailsSchema.parse(details)).toEqual(details)
    expect(details.table).toEqual({ schema, name: 'parent', kind: 'table' })
    expect(details.columns).toEqual([
      {
        name: 'id',
        dataType: 'integer',
        nullable: false,
        defaultValue: expect.stringContaining('nextval'),
      },
      { name: 'code', dataType: 'text', nullable: false, defaultValue: null },
      { name: 'note', dataType: 'text', nullable: true, defaultValue: "'n/a'::text" },
    ])
  })

  it('describes primary keys (composite, in declared order), foreign keys and indexes', async () => {
    const session = await open(target)
    const details = await adapter.describeTable(session.sessionId, { schema, name: 'child' })
    expect(TableDetailsSchema.parse(details)).toEqual(details)

    expect(details.columns.find((column) => column.name === 'price')).toEqual({
      name: 'price',
      dataType: 'numeric(10,2)',
      nullable: true,
      defaultValue: '0',
    })
    expect(details.primaryKey).toEqual({ name: 'child_pk', columns: ['id', 'seq'] })
    expect(details.foreignKeys).toEqual([
      {
        name: 'child_pair_fk',
        columns: ['py', 'px'],
        referencedTable: { schema, name: 'pair' },
        referencedColumns: ['y', 'x'],
        onUpdate: 'no_action',
        onDelete: 'set_null',
      },
      {
        name: 'child_parent_id_fkey',
        columns: ['parent_id'],
        referencedTable: { schema, name: 'parent' },
        referencedColumns: ['id'],
        onUpdate: 'restrict',
        onDelete: 'cascade',
      },
    ])
    expect(details.indexes).toEqual([
      { name: 'child_label_parent_uq', columns: ['label', 'parent_id'], unique: true },
      { name: 'child_lower_label_idx', columns: ['lower(label)'], unique: false },
    ])
  })

  it('reports unique constraints as indexes and leaves the primary key index out', async () => {
    const session = await open(target)
    const details = await adapter.describeTable(session.sessionId, { schema, name: 'parent' })
    expect(details.primaryKey).toEqual({ name: 'parent_pkey', columns: ['id'] })
    expect(details.indexes).toEqual([{ name: 'parent_code_key', columns: ['code'], unique: true }])
  })

  it('describes views, materialized views, partitioned and foreign tables', async () => {
    const session = await open(target)
    const view = await adapter.describeTable(session.sessionId, { schema, name: 'child_view' })
    expect(view.table.kind).toBe('view')
    expect(view.columns.map((column) => column.name)).toEqual(['id', 'label'])
    expect(view).toMatchObject({ primaryKey: null, foreignKeys: [], indexes: [] })

    const materialized = await adapter.describeTable(session.sessionId, {
      schema,
      name: 'child_mv',
    })
    expect(materialized.table.kind).toBe('materialized_view')
    expect(materialized.indexes).toEqual([
      { name: 'child_mv_id_idx', columns: ['id'], unique: true },
    ])

    const partitioned = await adapter.describeTable(session.sessionId, { schema, name: 'events' })
    expect(partitioned.table.kind).toBe('partitioned_table')
    expect(partitioned.columns.map((column) => column.dataType)).toEqual([
      'integer',
      'timestamp with time zone',
    ])

    if (hasForeignTable) {
      const foreign = await adapter.describeTable(session.sessionId, {
        schema,
        name: 'remote_things',
      })
      expect(foreign.table.kind).toBe('foreign_table')
      expect(foreign.columns.map((column) => column.name)).toEqual(['id'])
    }
  })

  it('handles identifiers that need quoting without interpolating them', async () => {
    const session = await open(target)
    const details = await adapter.describeTable(session.sessionId, {
      schema: quotedSchema,
      name: 'Mixed Case',
    })
    expect(details.columns.map((column) => column.name)).toEqual(['Odd Column'])
    expect(await adapter.listTables(session.sessionId, quotedSchema)).toEqual([
      { schema: quotedSchema, name: 'Mixed Case', kind: 'table' },
    ])
  })

  it('treats hostile names as plain data and reports the table as missing', async () => {
    const session = await open(target)
    const hostile = [
      `parent'; DROP TABLE ${schema}.parent; --`,
      `parent" OR "1"="1`,
      `parent\\'; DROP TABLE ${schema}.parent; --`,
    ]
    for (const name of hostile) {
      expect(
        await rejection(adapter.describeTable(session.sessionId, { schema, name })),
      ).toMatchObject({
        code: 'not_found',
        message: 'The table or view does not exist',
      })
      expect(
        await rejection(adapter.describeTable(session.sessionId, { schema: name, name: 'parent' })),
      ).toMatchObject({ code: 'not_found' })
      expect(await rejection(adapter.listTables(session.sessionId, name))).toMatchObject({
        code: 'not_found',
      })
    }
    const still = await adapter.listTables(session.sessionId, schema)
    expect(still.map((table) => table.name)).toContain('parent')
  })

  it('does not expose system catalog relations', async () => {
    const session = await open(target)
    expect(
      await rejection(
        adapter.describeTable(session.sessionId, { schema: 'pg_catalog', name: 'pg_class' }),
      ),
    ).toMatchObject({ code: 'not_found' })
  })

  it('rejects unknown sessions', async () => {
    expect(await rejection(adapter.listSchemas('missing'))).toMatchObject({ code: 'no_session' })
    expect(await rejection(adapter.listTables('missing'))).toMatchObject({ code: 'no_session' })
    expect(
      await rejection(adapter.describeTable('missing', { schema: 'public', name: 'x' })),
    ).toMatchObject({ code: 'no_session' })
  })

  it('reads the catalog inside an open transaction and leaves it open', async () => {
    const session = await open(target)
    await run(adapter, session, 'BEGIN')
    const tables = await adapter.listTables(session.sessionId, schema)
    expect(tables.length).toBeGreaterThan(0)
    const details = await adapter.describeTable(session.sessionId, { schema, name: 'child' })
    expect(details.columns.length).toBeGreaterThan(0)
    expect(adapter.transactionState(session.sessionId)).toBe('active')
    await adapter.rollback(session.sessionId)
  })

  it('cannot read the catalog inside an aborted transaction: the server answers 25P02', async () => {
    const session = await open(target)
    await run(adapter, session, 'BEGIN; SELECT 1 / 0')
    expect(adapter.transactionState(session.sessionId)).toBe('aborted')

    const expected = { code: 'validation_failed', message: expect.stringContaining('aborted') }
    expect(await rejection(adapter.listTables(session.sessionId, schema))).toMatchObject(expected)
    expect(
      await rejection(adapter.describeTable(session.sessionId, { schema, name: 'child' })),
    ).toMatchObject(expected)
    expect(adapter.transactionState(session.sessionId)).toBe('aborted')

    await adapter.rollback(session.sessionId)
    expect((await adapter.listTables(session.sessionId, schema)).length).toBeGreaterThan(0)
  })
})
