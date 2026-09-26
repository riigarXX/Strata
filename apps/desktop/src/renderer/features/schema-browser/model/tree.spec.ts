import type { NormalizedError } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { emptySessionCache, type Loadable, type SessionCache } from './cache'
import { groupKey, schemaKey, sectionKey, tableKey } from './node-keys'
import { buildTree, insertText, nodeLabel, type TreeNode } from './tree'
import { POSTGRES_CATALOG, SQLITE_CATALOG, table } from '../testing/catalog'

const ERROR: NormalizedError = { code: 'timeout', message: 'Timed out', retryable: true }

let seq = 0
const ready = <T>(data: T): Loadable<T> => ({ status: 'ready', data, error: null, seq: (seq += 1) })
const loading = <T>(data: T | null = null): Loadable<T> => ({
  status: 'loading',
  data,
  error: null,
  seq: (seq += 1),
})
const failed = <T>(): Loadable<T> => ({
  status: 'error',
  data: null,
  error: ERROR,
  seq: (seq += 1),
})

function cacheOf(patch: Partial<SessionCache> = {}): SessionCache {
  return {
    ...emptySessionCache(),
    schemas: ready(POSTGRES_CATALOG.schemas.map((name) => ({ name }))),
    ...patch,
  }
}

const fullCache = (toggled: Record<string, boolean> = {}) =>
  cacheOf({
    tables: {
      public: ready(POSTGRES_CATALOG.tables['public']!),
      Sales: ready(POSTGRES_CATALOG.tables['Sales']!),
    },
    details: Object.fromEntries(
      POSTGRES_CATALOG.details.map((details) => [tableKey(details.table), ready(details)]),
    ),
    toggled,
  })

const keys = (nodes: readonly TreeNode[]) => nodes.map((node) => node.key)
const find = (nodes: readonly TreeNode[], key: string) => nodes.find((node) => node.key === key)!

describe('root states', () => {
  it('reports idle, loading, error and empty', () => {
    expect(buildTree(null, '').status).toBe('idle')
    expect(buildTree(emptySessionCache(), '').status).toBe('idle')
    expect(buildTree(cacheOf({ schemas: loading() }), '').status).toBe('loading')
    const error = buildTree(cacheOf({ schemas: failed() }), '')
    expect(error).toMatchObject({ status: 'error', error: ERROR, items: [] })
    expect(buildTree(cacheOf({ schemas: ready([]) }), '').status).toBe('empty')
  })

  it('keeps showing the schemas while they reload', () => {
    const tree = buildTree(cacheOf({ schemas: loading([{ name: 'public' }]) }), '')
    expect(tree.status).toBe('ready')
    expect(tree.roots).toHaveLength(1)
  })
})

describe('structure', () => {
  it('lists collapsed schemas with WAI-ARIA levels and positions', () => {
    const tree = buildTree(cacheOf(), '')
    expect(
      tree.roots.map((node) => [nodeLabel(node), node.level, node.posInSet, node.setSize]),
    ).toEqual([
      ['public', 1, 1, 2],
      ['Sales', 1, 2, 2],
    ])
    expect(tree.roots.every((node) => node.expandable && !node.expanded)).toBe(true)
    expect(tree.items).toHaveLength(2)
  })

  it('shows a loading row inside an expanded schema until its tables arrive', () => {
    const tree = buildTree(cacheOf({ toggled: { [schemaKey('public')]: true } }), '')
    const [row] = find(tree.roots, schemaKey('public')).children
    expect(row).toMatchObject({ kind: 'loading', what: 'Cargando tablas de public…' })
    expect(tree.items.some((node) => node.kind === 'loading')).toBe(false)
  })

  it('shows a retryable error row when the tables fail to load', () => {
    const tree = buildTree(
      cacheOf({ tables: { public: failed() }, toggled: { [schemaKey('public')]: true } }),
      '',
    )
    const [row] = find(tree.roots, schemaKey('public')).children
    expect(row).toMatchObject({
      kind: 'error',
      error: ERROR,
      retry: { type: 'tables', schema: 'public' },
      level: 2,
    })
    expect(tree.items).toContain(row)
  })

  it('groups tables and views, in catalog order, with their kind', () => {
    const tree = buildTree(fullCache({ [schemaKey('public')]: true }), '')
    const schema = find(tree.roots, schemaKey('public'))
    expect(schema.children.map((group) => [nodeLabel(group), group.expanded])).toEqual([
      ['Tablas', true],
      ['Vistas', true],
    ])
    const [tables, views] = schema.children
    expect(
      tables!.children.map((node) => [
        nodeLabel(node),
        (node as { table: { kind: string } }).table.kind,
      ]),
    ).toEqual([
      ['users', 'table'],
      ['orders', 'table'],
      ['user', 'table'],
      ['events', 'partitioned_table'],
      ['remote_stats', 'foreign_table'],
    ])
    expect(views!.children.map((node) => nodeLabel(node))).toEqual(['active_users', 'totals'])
    expect(tables!.children.map((node) => [node.level, node.posInSet, node.setSize])[1]).toEqual([
      3, 2, 5,
    ])
  })

  it('omits empty groups and says so for an empty schema', () => {
    const only = buildTree(
      cacheOf({
        tables: { Sales: ready([table('Sales', 'v', 'view')]), public: ready([]) },
        toggled: { [schemaKey('public')]: true, [schemaKey('Sales')]: true },
      }),
      '',
    )
    expect(find(only.roots, schemaKey('public')).children).toMatchObject([
      { kind: 'empty', what: 'Sin tablas ni vistas' },
    ])
    expect(find(only.roots, schemaKey('Sales')).children.map(nodeLabel)).toEqual(['Vistas'])
  })

  it('expands a table into columns with primary key, foreign keys and indexes', () => {
    const users = table('public', 'users')
    const orders = table('public', 'orders')
    const tree = buildTree(
      fullCache({
        [schemaKey('public')]: true,
        [tableKey(users)]: true,
        [tableKey(orders)]: true,
      }),
      '',
    )
    const tables = find(tree.roots, schemaKey('public')).children[0]!
    const usersNode = find(tables.children, tableKey(users))
    expect(usersNode.children.map(nodeLabel)).toEqual(['Columnas', 'Índices'])
    const columns = find(usersNode.children, sectionKey(users, 'columns'))
    expect(
      columns.children.map((node) => node.kind === 'column' && [node.column.name, node.primaryKey]),
    ).toEqual([
      ['id', true],
      ['email', false],
      ['Full Name', false],
    ])
    const ordersNode = find(tables.children, tableKey(orders))
    expect(ordersNode.children.map(nodeLabel)).toEqual(['Columnas', 'Claves foráneas', 'Índices'])
    expect(ordersNode.children[1]!.children[0]).toMatchObject({
      kind: 'foreign-key',
      foreignKey: { referencedTable: { schema: 'public', name: 'users' } },
      level: 5,
    })
    expect(ordersNode.children[2]!.children[0]).toMatchObject({
      kind: 'index',
      index: { name: 'orders_user_idx', unique: false, columns: ['user_id', 'id'] },
    })
  })

  it('shows loading and error rows for a table description', () => {
    const users = table('public', 'users')
    const base = {
      tables: { public: ready(POSTGRES_CATALOG.tables['public']!) },
      toggled: { [schemaKey('public')]: true, [tableKey(users)]: true },
    }
    const under = (cache: SessionCache) =>
      find(
        find(buildTree(cache, '').roots, schemaKey('public')).children[0]!.children,
        tableKey(users),
      ).children

    expect(under(cacheOf(base))).toMatchObject([{ kind: 'loading' }])
    expect(under(cacheOf({ ...base, details: { [tableKey(users)]: failed() } }))).toMatchObject([
      { kind: 'error', retry: { type: 'details', table: users } },
    ])
  })

  it('collapses a group or a section on request', () => {
    const users = table('public', 'users')
    const tree = buildTree(
      fullCache({
        [schemaKey('public')]: true,
        [groupKey('public', 'views')]: false,
        [tableKey(users)]: true,
        [sectionKey(users, 'columns')]: false,
      }),
      '',
    )
    const schema = find(tree.roots, schemaKey('public'))
    expect(schema.children[1]).toMatchObject({ expanded: false, children: [] })
    const usersNode = find(schema.children[0]!.children, tableKey(users))
    expect(usersNode.children[0]).toMatchObject({ expanded: false, children: [] })
    expect(tree.items.some((node) => node.kind === 'column')).toBe(false)
  })

  it('lists navigable items in screen order, skipping status rows', () => {
    const tree = buildTree(
      fullCache({ [schemaKey('public')]: true, [schemaKey('Sales')]: true }),
      '',
    )
    expect(tree.items.map(nodeLabel).slice(0, 4)).toEqual(['public', 'Tablas', 'users', 'orders'])
    expect(tree.items.at(-1)).toMatchObject({ kind: 'table', table: { name: 'Invoice Lines' } })
    expect(keys(tree.items)).toEqual([...new Set(keys(tree.items))])
  })
})

describe('filter', () => {
  it('matches table and view names as a case-insensitive substring and opens the schemas', () => {
    const tree = buildTree(fullCache(), 'USER')
    expect(tree.roots.map(nodeLabel)).toEqual(['public'])
    const schema = tree.roots[0]!
    expect(schema.expanded).toBe(true)
    const names = schema.children.flatMap((group) => group.children.map(nodeLabel))
    expect(names).toEqual(['users', 'user', 'active_users'])
    expect(tree.matches).toBe(3)
    expect(tree.pending).toBe(0)
  })

  it('keeps every table of a schema whose own name matches', () => {
    const tree = buildTree(fullCache(), 'sales')
    expect(tree.roots.map(nodeLabel)).toEqual(['Sales'])
    expect(tree.matches).toBe(1)
  })

  it('ignores surrounding whitespace and treats a blank filter as none', () => {
    expect(buildTree(fullCache(), '   ').matches).toBeNull()
    expect(buildTree(fullCache(), ' remote ').matches).toBe(1)
  })

  it('returns no roots when nothing matches', () => {
    const tree = buildTree(fullCache(), 'zzz')
    expect(tree).toMatchObject({ status: 'ready', roots: [], items: [], matches: 0 })
  })

  it('counts schemas whose tables are not known yet and hides them unless their name matches', () => {
    const cache = cacheOf({ tables: { public: ready(POSTGRES_CATALOG.tables['public']!) } })
    const tree = buildTree(cache, 'orders')
    expect(tree.pending).toBe(1)
    expect(tree.roots.map(nodeLabel)).toEqual(['public'])
    expect(buildTree(cache, 'sales').roots.map(nodeLabel)).toEqual(['Sales'])
  })

  it('keeps a schema with a failed listing visible so that it can be retried', () => {
    const tree = buildTree(cacheOf({ tables: { public: ready([]), Sales: failed() } }), 'orders')
    expect(tree.roots.map(nodeLabel)).toEqual(['Sales'])
    expect(tree.roots[0]!.children[0]).toMatchObject({ kind: 'error' })
  })

  it('respects a schema the user collapsed while filtering', () => {
    const tree = buildTree(fullCache({ [schemaKey('public')]: false }), 'users')
    expect(tree.roots[0]).toMatchObject({ expanded: false, children: [] })
    expect(tree.matches).toBe(2)
  })

  it('does not touch the expansion of tables', () => {
    const users = table('public', 'users')
    const tree = buildTree(fullCache({ [tableKey(users)]: true }), 'users')
    const tables = tree.roots[0]!.children[0]!
    expect(tables.children[0]).toMatchObject({ expanded: true })
    expect(tables.children[0]!.children.length).toBeGreaterThan(0)
  })
})

describe('insertText', () => {
  const tree = buildTree(
    fullCache({
      [schemaKey('public')]: true,
      [schemaKey('Sales')]: true,
      [tableKey(table('public', 'orders'))]: true,
      [tableKey(table('Sales', 'Invoice Lines'))]: true,
    }),
    '',
  )
  const flat = (nodes: readonly TreeNode[]): TreeNode[] =>
    nodes.flatMap((node) => [node, ...flat(node.children)])
  const textOf = (engine: 'postgres' | 'sqlite', predicate: (node: TreeNode) => boolean) =>
    insertText(engine, flat(tree.roots).find(predicate)!)

  it('quotes schemas and qualifies tables by dialect', () => {
    expect(textOf('postgres', (n) => n.kind === 'schema' && n.schema === 'Sales')).toBe('"Sales"')
    expect(textOf('postgres', (n) => n.kind === 'table' && n.table.name === 'orders')).toBe(
      'public.orders',
    )
    expect(textOf('postgres', (n) => n.kind === 'table' && n.table.name === 'user')).toBe(
      'public."user"',
    )
    expect(textOf('postgres', (n) => n.kind === 'table' && n.table.name === 'Invoice Lines')).toBe(
      '"Sales"."Invoice Lines"',
    )
  })

  it('inserts the bare, minimally quoted column name', () => {
    expect(textOf('postgres', (n) => n.kind === 'column' && n.column.name === 'user_id')).toBe(
      'user_id',
    )
    expect(textOf('postgres', (n) => n.kind === 'column' && n.column.name === 'Line-No')).toBe(
      '"Line-No"',
    )
    expect(textOf('postgres', (n) => n.kind === 'column' && n.column.name === 'order')).toBe(
      '"order"',
    )
  })

  it('inserts the referenced table of a foreign key', () => {
    expect(textOf('postgres', (n) => n.kind === 'foreign-key')).toBe('public.users')
  })

  it('is null for nodes that have no name to paste', () => {
    for (const kind of ['group', 'section', 'index'] as const) {
      expect(textOf('postgres', (n) => n.kind === kind)).toBeNull()
    }
  })

  it('omits `main` in sqlite', () => {
    const sqlite = buildTree(
      cacheOf({
        schemas: ready([{ name: 'main' }]),
        tables: { main: ready(SQLITE_CATALOG.tables['main']!) },
        toggled: { [schemaKey('main')]: true },
      }),
      '',
    )
    const tables = sqlite.roots[0]!.children[0]!.children
    expect(tables.map((node) => insertText('sqlite', node))).toEqual(['Customers', '"order items"'])
  })
})
