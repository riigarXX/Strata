import { TableDetailsSchema, type Session } from '@strata/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { isAdapterError } from '../normalization'
import { createSqliteAdapter } from './adapter'
import {
  collect,
  createTempDatabase,
  queryRequest,
  removeTempDirs,
  sqliteProfile,
} from './test-support'

const SCHEMA = `
  CREATE TABLE authors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    born DATE,
    bio TEXT DEFAULT 'n/a'
  );
  CREATE TABLE books (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE ON UPDATE SET NULL,
    isbn TEXT,
    price NUMERIC(10, 2) DEFAULT 0
  );
  CREATE INDEX idx_books_title ON books (title);
  CREATE UNIQUE INDEX idx_books_isbn_author ON books (isbn, author_id);
  CREATE INDEX idx_books_lower_title ON books (lower(title));
  CREATE TABLE tags (book_id INTEGER, tag TEXT, PRIMARY KEY (tag, book_id),
    FOREIGN KEY (book_id) REFERENCES books);
  CREATE TABLE untyped (a, b);
  CREATE TABLE generated (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL);
  CREATE VIRTUAL TABLE notes USING fts5(body);
  CREATE VIEW book_titles AS SELECT id, title FROM books;
  INSERT INTO authors (name) VALUES ('Ursula');
`

const adapter = createSqliteAdapter()
const sessions: Session[] = []

async function open(setupSql = SCHEMA): Promise<string> {
  const { filePath } = createTempDatabase(setupSql)
  const session = await adapter.connect(sqliteProfile(filePath))
  sessions.push(session)
  return session.sessionId
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (isAdapterError(error)) return error.normalized
    throw error
  }
  throw new Error('expected rejection')
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await adapter.disconnect(session.sessionId)
  }
  removeTempDirs()
})

describe('listSchemas', () => {
  it('lists main only for a plain file', async () => {
    const id = await open()
    expect(await adapter.listSchemas(id)).toEqual([{ name: 'main' }])
  })

  it('includes databases attached by the user', async () => {
    const id = await open()
    const { filePath } = createTempDatabase('CREATE TABLE other (a)')
    await collect(adapter.execute(queryRequest(id, `ATTACH DATABASE '${filePath}' AS extra`)))

    expect((await adapter.listSchemas(id)).map((schema) => schema.name)).toEqual(['main', 'extra'])
    expect(await adapter.listTables(id, 'extra')).toEqual([
      { schema: 'extra', name: 'other', kind: 'table' },
    ])
  })
})

describe('listTables', () => {
  it('lists tables and views, sorted, without internal or shadow tables', async () => {
    const id = await open()
    expect(await adapter.listTables(id)).toEqual([
      { schema: 'main', name: 'authors', kind: 'table' },
      { schema: 'main', name: 'book_titles', kind: 'view' },
      { schema: 'main', name: 'books', kind: 'table' },
      { schema: 'main', name: 'generated', kind: 'table' },
      { schema: 'main', name: 'notes', kind: 'table' },
      { schema: 'main', name: 'tags', kind: 'table' },
      { schema: 'main', name: 'untyped', kind: 'table' },
    ])
  })

  it('hides sqlite_sequence and other sqlite_ tables', async () => {
    const id = await open(
      'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO t DEFAULT VALUES;',
    )
    expect((await adapter.listTables(id)).map((table) => table.name)).toEqual(['t'])
  })

  it('returns an empty list for an empty database', async () => {
    expect(await adapter.listTables(await open(''))).toEqual([])
  })

  it('rejects a schema that is not in the catalog', async () => {
    const id = await open()
    for (const schema of ['nope', `main"; DROP TABLE books; --`, `main' OR '1'='1`]) {
      expect((await rejection(adapter.listTables(id, schema))).code).toBe('not_found')
    }
    expect(await adapter.listTables(id)).toHaveLength(7)
  })
})

describe('describeTable', () => {
  it('describes columns, defaults and nullability', async () => {
    const id = await open()
    const details = await adapter.describeTable(id, { schema: 'main', name: 'authors' })
    expect(TableDetailsSchema.safeParse(details).success).toBe(true)
    expect(details.table).toEqual({ schema: 'main', name: 'authors', kind: 'table' })
    expect(details.columns).toEqual([
      { name: 'id', dataType: 'INTEGER', nullable: false, defaultValue: null },
      { name: 'name', dataType: 'TEXT', nullable: false, defaultValue: null },
      { name: 'born', dataType: 'DATE', nullable: true, defaultValue: null },
      { name: 'bio', dataType: 'TEXT', nullable: true, defaultValue: "'n/a'" },
    ])
    expect(details.primaryKey).toEqual({ name: null, columns: ['id'] })
  })

  it('describes foreign keys with their actions', async () => {
    const id = await open()
    const { foreignKeys } = await adapter.describeTable(id, { schema: 'main', name: 'books' })
    expect(foreignKeys).toEqual([
      {
        name: null,
        columns: ['author_id'],
        referencedTable: { schema: 'main', name: 'authors' },
        referencedColumns: ['id'],
        onUpdate: 'set_null',
        onDelete: 'cascade',
      },
    ])
  })

  it('resolves an implicit foreign key target to the referenced primary key', async () => {
    const id = await open()
    const { foreignKeys } = await adapter.describeTable(id, { schema: 'main', name: 'tags' })
    expect(foreignKeys).toMatchObject([
      {
        columns: ['book_id'],
        referencedTable: { name: 'books' },
        referencedColumns: ['id'],
        onUpdate: 'no_action',
        onDelete: 'no_action',
      },
    ])
  })

  it('keeps composite primary keys in key order', async () => {
    const id = await open()
    const { primaryKey, columns } = await adapter.describeTable(id, {
      schema: 'main',
      name: 'tags',
    })
    expect(primaryKey).toEqual({ name: null, columns: ['tag', 'book_id'] })
    expect(columns.every((column) => !column.nullable)).toBe(true)
  })

  it('describes indexes, including unique, composite and expression ones, but not the primary key', async () => {
    const id = await open()
    const { indexes } = await adapter.describeTable(id, { schema: 'main', name: 'books' })
    expect(indexes).toHaveLength(3)
    expect(indexes).toEqual(
      expect.arrayContaining([
        { name: 'idx_books_title', columns: ['title'], unique: false },
        { name: 'idx_books_isbn_author', columns: ['isbn', 'author_id'], unique: true },
        { name: 'idx_books_lower_title', columns: ['(expression)'], unique: false },
      ]),
    )

    const authors = await adapter.describeTable(id, { schema: 'main', name: 'authors' })
    expect(authors.indexes).toEqual([
      {
        name: expect.stringMatching(/^sqlite_autoindex_authors_/),
        columns: ['name'],
        unique: true,
      },
    ])
  })

  it('reports untyped columns as ANY and includes generated ones', async () => {
    const id = await open()
    const untyped = await adapter.describeTable(id, { schema: 'main', name: 'untyped' })
    expect(untyped.columns.map((column) => column.dataType)).toEqual(['ANY', 'ANY'])
    expect(untyped.primaryKey).toBeNull()

    const generated = await adapter.describeTable(id, { schema: 'main', name: 'generated' })
    expect(generated.columns.map((column) => column.name)).toEqual(['a', 'b'])
  })

  it('describes views without keys or indexes', async () => {
    const id = await open()
    const view = await adapter.describeTable(id, { schema: 'main', name: 'book_titles' })
    expect(view.table.kind).toBe('view')
    expect(view.columns.map((column) => column.name)).toEqual(['id', 'title'])
    expect(view.primaryKey).toBeNull()
    expect(view.foreignKeys).toEqual([])
    expect(view.indexes).toEqual([])
  })

  it('never interpolates the received names: unknown or hostile names are rejected and change nothing', async () => {
    const id = await open()
    const hostile = [
      { schema: 'main', name: 'missing' },
      { schema: 'nope', name: 'books' },
      { schema: 'main', name: `books'); DROP TABLE books; --` },
      { schema: 'main', name: 'books" WHERE 1=1; --' },
      { schema: `main"; DROP TABLE books; --`, name: 'books' },
      { schema: 'main', name: 'sqlite_master' },
    ]
    for (const table of hostile) {
      expect((await rejection(adapter.describeTable(id, table))).code).toBe('not_found')
    }
    const details = await adapter.describeTable(id, { schema: 'main', name: 'books' })
    expect(details.columns).toHaveLength(5)
  })

  it('fails with no_session for an unknown session', async () => {
    expect(
      (await rejection(adapter.describeTable('ghost', { schema: 'main', name: 't' }))).code,
    ).toBe('no_session')
  })
})
