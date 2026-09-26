import type {
  ColumnInfo,
  Engine,
  ForeignKey,
  IndexInfo,
  NormalizedError,
  TableDetails,
  TableInfo,
  TableKind,
  TableRef,
} from '@strata/contracts'
import type { Loadable, SessionCache } from './cache'
import { quoteIdentifier, qualifiedTableName } from './identifiers'
import {
  groupKey,
  leafKey,
  schemaKey,
  sectionKey,
  statusKey,
  tableKey,
  type TableGroup,
  type TableSection,
} from './node-keys'

export const TABLE_KIND_LABELS: Record<TableKind, string> = {
  table: 'tabla',
  partitioned_table: 'particionada',
  foreign_table: 'foránea',
  view: 'vista',
  materialized_view: 'vista materializada',
}

export const GROUP_LABELS: Record<TableGroup, string> = { tables: 'Tablas', views: 'Vistas' }

export const SECTION_LABELS: Record<TableSection, string> = {
  columns: 'Columnas',
  'foreign-keys': 'Claves foráneas',
  indexes: 'Índices',
}

const GROUP_OF_KIND: Record<TableKind, TableGroup> = {
  table: 'tables',
  partitioned_table: 'tables',
  foreign_table: 'tables',
  view: 'views',
  materialized_view: 'views',
}

/** Qué volver a pedir al pulsar «Reintentar» en un nodo con error. */
export type RetryTarget =
  { type: 'schemas' } | { type: 'tables'; schema: string } | { type: 'details'; table: TableRef }

interface NodeBase {
  key: string
  level: number
  /** 1-based entre los hermanos que son `treeitem`; 0 en filas de estado. */
  posInSet: number
  setSize: number
  parentKey: string | null
  expandable: boolean
  expanded: boolean
  children: TreeNode[]
}

export type TreeNode = NodeBase &
  (
    | { kind: 'schema'; schema: string }
    | { kind: 'group'; group: TableGroup; count: number }
    | { kind: 'table'; table: TableInfo }
    | { kind: 'section'; section: TableSection; count: number }
    | { kind: 'column'; column: ColumnInfo; primaryKey: boolean }
    | { kind: 'foreign-key'; foreignKey: ForeignKey }
    | { kind: 'index'; index: IndexInfo }
    | { kind: 'error'; error: NormalizedError; retry: RetryTarget }
    | { kind: 'loading'; what: string }
    | { kind: 'empty'; what: string }
  )

export type SchemaTreeStatus = 'idle' | 'loading' | 'error' | 'empty' | 'ready'

export interface SchemaTree {
  status: SchemaTreeStatus
  error: NormalizedError | null
  roots: TreeNode[]
  /** Nodos navegables (todos los `treeitem` visibles) en orden de pantalla. */
  items: TreeNode[]
  /** Tablas y vistas visibles con filtro activo; `null` sin filtro. */
  matches: number | null
  /** Schemas cuyo listado de tablas aún falta con el filtro activo: el recuento puede crecer. */
  pending: number
}

/** Texto para saltar por escritura y para anunciar el nodo. */
export function nodeLabel(node: TreeNode): string {
  switch (node.kind) {
    case 'schema':
      return node.schema
    case 'group':
      return GROUP_LABELS[node.group]
    case 'table':
      return node.table.name
    case 'section':
      return SECTION_LABELS[node.section]
    case 'column':
      return node.column.name
    case 'foreign-key':
      return node.foreignKey.columns.join(', ')
    case 'index':
      return node.index.name
    case 'error':
      return node.error.message
    case 'loading':
    case 'empty':
      return node.what
  }
}

/** Texto que la acción «insertar en el editor» pega para el nodo, o `null` si no tiene sentido pegarlo. */
export function insertText(engine: Engine, node: TreeNode): string | null {
  switch (node.kind) {
    case 'schema':
      return quoteIdentifier(engine, node.schema)
    case 'table':
      return qualifiedTableName(engine, node.table)
    case 'column':
      return quoteIdentifier(engine, node.column.name)
    case 'foreign-key':
      return qualifiedTableName(engine, node.foreignKey.referencedTable)
    default:
      return null
  }
}

export function describeForeignKey(foreignKey: ForeignKey): string {
  const target = `${foreignKey.referencedTable.schema}.${foreignKey.referencedTable.name}`
  return `${foreignKey.columns.join(', ')} → ${target} (${foreignKey.referencedColumns.join(', ')})`
}

type Derived =
  'posInSet' | 'setSize' | 'level' | 'parentKey' | 'children' | 'expanded' | 'expandable'
type Shape<T = TreeNode> = T extends unknown ? Omit<T, Derived> : never

interface Context {
  cache: SessionCache
  query: string
}

function node(
  parent: TreeNode | null,
  shape: Shape,
  extras: { expandable?: boolean; expanded?: boolean; children?: TreeNode[] } = {},
): TreeNode {
  return {
    ...shape,
    level: (parent?.level ?? 0) + 1,
    parentKey: parent?.key ?? null,
    posInSet: 0,
    setSize: 0,
    expandable: extras.expandable ?? false,
    expanded: extras.expanded ?? false,
    children: extras.children ?? [],
  } as TreeNode
}

function numberSiblings(nodes: TreeNode[]): void {
  const items = nodes.filter((entry) => entry.kind !== 'loading' && entry.kind !== 'empty')
  items.forEach((entry, index) => {
    entry.posInSet = index + 1
    entry.setSize = items.length
  })
}

function contains(name: string, query: string): boolean {
  return query === '' || name.toLocaleLowerCase().includes(query)
}

function statusRow(
  parent: TreeNode,
  slot: Loadable<unknown> | undefined,
  what: string,
  retry: RetryTarget,
): TreeNode | null {
  if (slot?.status === 'error' && slot.error) {
    return node(parent, {
      kind: 'error',
      key: statusKey(parent.key, 'error'),
      error: slot.error,
      retry,
    })
  }
  if (!slot || (slot.status === 'loading' && slot.data === null)) {
    return node(parent, { kind: 'loading', key: statusKey(parent.key, 'loading'), what })
  }
  return null
}

function detailChildren(
  parent: TreeNode,
  table: TableRef,
  details: TableDetails,
  context: Context,
): TreeNode[] {
  const primary = new Set(details.primaryKey?.columns ?? [])
  const sections: TreeNode[] = []

  const section = (
    kind: TableSection,
    count: number,
    build: (self: TreeNode) => TreeNode[],
  ): void => {
    if (count === 0 && kind !== 'columns') return
    const key = sectionKey(table, kind)
    const self = node(
      parent,
      { kind: 'section', key, section: kind, count },
      { expandable: true, expanded: context.cache.toggled[key] ?? true },
    )
    if (self.expanded) {
      self.children = build(self)
      numberSiblings(self.children)
    }
    sections.push(self)
  }

  section('columns', details.columns.length, (self) =>
    details.columns.map((column, index) =>
      node(self, {
        kind: 'column',
        key: leafKey(table, 'columns', index),
        column,
        primaryKey: primary.has(column.name),
      }),
    ),
  )
  section('foreign-keys', details.foreignKeys.length, (self) =>
    details.foreignKeys.map((foreignKey, index) =>
      node(self, { kind: 'foreign-key', key: leafKey(table, 'foreign-keys', index), foreignKey }),
    ),
  )
  section('indexes', details.indexes.length, (self) =>
    details.indexes.map((index, position) =>
      node(self, { kind: 'index', key: leafKey(table, 'indexes', position), index }),
    ),
  )
  return sections
}

function tableNode(parent: TreeNode, table: TableInfo, context: Context): TreeNode {
  const key = tableKey(table)
  const expanded = context.cache.toggled[key] ?? false
  const self = node(parent, { kind: 'table', key, table }, { expandable: true, expanded })
  if (expanded) {
    const slot = context.cache.details[key]
    const status = statusRow(self, slot, `Cargando ${table.name}…`, { type: 'details', table })
    self.children = status
      ? [status]
      : slot?.data
        ? detailChildren(self, table, slot.data, context)
        : []
    numberSiblings(self.children)
  }
  return self
}

function schemaChildren(parent: TreeNode, schema: string, tables: TableInfo[], context: Context) {
  const children: TreeNode[] = []
  for (const group of ['tables', 'views'] as const) {
    const members = tables.filter((table) => GROUP_OF_KIND[table.kind] === group)
    if (members.length === 0) continue
    const self = node(
      parent,
      { kind: 'group', key: groupKey(schema, group), group, count: members.length },
      { expandable: true, expanded: context.cache.toggled[groupKey(schema, group)] ?? true },
    )
    if (self.expanded) {
      self.children = members.map((table) => tableNode(self, table, context))
      numberSiblings(self.children)
    }
    children.push(self)
  }
  return children
}

/** Tablas del schema que pasan el filtro: si el schema coincide, todas las suyas. */
function visibleTables(schema: string, context: Context): TableInfo[] {
  const schemaMatches = contains(schema, context.query)
  return (context.cache.tables[schema]?.data ?? []).filter(
    (table) => schemaMatches || contains(table.name, context.query),
  )
}

function schemaNode(schema: string, context: Context): TreeNode | null {
  const key = schemaKey(schema)
  const filtering = context.query !== ''
  const slot = context.cache.tables[schema]
  const tables = visibleTables(schema, context)
  const schemaMatches = contains(schema, context.query)
  if (filtering && !schemaMatches && tables.length === 0 && slot?.status !== 'error') return null

  const expanded = context.cache.toggled[key] ?? filtering
  const self = node(null, { kind: 'schema', key, schema }, { expandable: true, expanded })
  if (!expanded) return self

  const status = statusRow(self, slot, `Cargando tablas de ${schema}…`, { type: 'tables', schema })
  if (status) self.children = [status]
  else if (tables.length === 0) {
    self.children = [
      node(self, { kind: 'empty', key: statusKey(key, 'empty'), what: 'Sin tablas ni vistas' }),
    ]
  } else self.children = schemaChildren(self, schema, tables, context)
  numberSiblings(self.children)
  return self
}

function collectItems(nodes: TreeNode[], into: TreeNode[]): TreeNode[] {
  for (const entry of nodes) {
    if (entry.kind === 'loading' || entry.kind === 'empty') continue
    into.push(entry)
    collectItems(entry.children, into)
  }
  return into
}

/**
 * Proyección pura del caché de una sesión a árbol visible: aplica expansión, filtro (subcadena sin
 * distinguir mayúsculas sobre schemas, tablas y vistas) y filas de carga/error/vacío.
 */
export function buildTree(cache: SessionCache | null, filter: string): SchemaTree {
  const none = { roots: [], items: [], matches: null, pending: 0 }
  const slot = cache?.schemas
  if (!cache || !slot) return { status: 'idle', error: null, ...none }
  if (slot.status === 'error') return { status: 'error', error: slot.error, ...none }
  if (slot.data === null) return { status: 'loading', error: null, ...none }
  if (slot.data.length === 0) return { status: 'empty', error: null, ...none }

  const query = filter.trim().toLocaleLowerCase()
  const context: Context = { cache, query }
  const roots = slot.data.flatMap((schema) => {
    const built = schemaNode(schema.name, context)
    return built ? [built] : []
  })
  numberSiblings(roots)

  const pending =
    query === '' ? 0 : slot.data.filter((schema) => cache.tables[schema.name]?.data == null).length
  return {
    status: 'ready',
    error: null,
    roots,
    items: collectItems(roots, []),
    matches:
      query === ''
        ? null
        : slot.data.reduce(
            (total, schema) => total + visibleTables(schema.name, context).length,
            0,
          ),
    pending,
  }
}
