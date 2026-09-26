import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useLiveConnections } from '../../workspace/composables/use-active-connection'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { describeMatches } from '../model/announcements'
import { groupKey, schemaKey, tableKey } from '../model/node-keys'
import { buildTree, insertText, type TreeNode } from '../model/tree'
import { useSchemaCacheStore } from '../stores/schema-cache'
import type { SchemaTarget } from './schema-port'

// Pausa tras la última pulsación antes de anunciar el recuento: evita leer cada letra del filtro.
const ANNOUNCE_DELAY_MS = 300

/**
 * Estado del explorador: sesión de la pestaña activa, árbol filtrado y acciones (expandir con carga
 * perezosa, reintentar, refrescar, insertar en el editor). El árbol solo se pinta; aquí vive la lógica.
 */
export function useSchemaBrowser() {
  const workspace = useWorkspaceStore()
  const live = useLiveConnections()
  const cache = useSchemaCacheStore()

  const filter = ref('')
  const activeKey = ref<string | null>(null)
  const matchesAnnouncement = ref('')

  const connection = computed(() => {
    const sessionId = workspace.activeTab?.sessionId
    return live.value.find((entry) => entry.session.sessionId === sessionId) ?? null
  })
  const sessionId = computed(() => connection.value?.session.sessionId ?? null)
  const engine = computed(() => connection.value?.session.engine ?? null)

  const tree = computed(() =>
    buildTree(sessionId.value ? (cache.sessions[sessionId.value] ?? null) : null, filter.value),
  )
  const filtering = computed(() => filter.value.trim() !== '')

  // Tabindex móvil: si el nodo activo ya no es visible (colapsado, filtrado), el primero hace de entrada.
  const focusKey = computed(() => {
    const { items } = tree.value
    return items.some((item) => item.key === activeKey.value)
      ? activeKey.value
      : (items[0]?.key ?? null)
  })
  const activeNode = computed(
    () => tree.value.items.find((item) => item.key === focusKey.value) ?? null,
  )
  const canInsert = computed(
    () =>
      engine.value !== null && activeNode.value !== null && insertTextOf(activeNode.value) !== null,
  )

  function insertTextOf(node: TreeNode): string | null {
    return engine.value ? insertText(engine.value, node) : null
  }

  function loadFor(node: TreeNode): void {
    const id = sessionId.value
    if (!id) return
    if (node.kind === 'schema') void cache.ensureTables(id, node.schema)
    else if (node.kind === 'table') void cache.ensureDetails(id, node.table)
  }

  function toggle(node: TreeNode, expanded = !node.expanded): void {
    const id = sessionId.value
    if (!id || !node.expandable) return
    cache.setExpanded(id, node.key, expanded)
    if (expanded) loadFor(node)
  }

  function retry(node: TreeNode): void {
    const id = sessionId.value
    if (!id || node.kind !== 'error') return
    const { retry: target } = node
    if (target.type === 'schemas') void cache.ensureSchemas(id)
    else if (target.type === 'tables') void cache.ensureTables(id, target.schema)
    else void cache.ensureDetails(id, target.table)
  }

  function retrySchemas(): void {
    if (sessionId.value) void cache.ensureSchemas(sessionId.value)
  }

  function refresh(): void {
    if (sessionId.value) void cache.refresh(sessionId.value)
  }

  /** Pega el nombre del nodo en el cursor del editor, que recupera el foco. */
  function insert(node: TreeNode | null = activeNode.value): boolean {
    const text = node ? insertTextOf(node) : null
    if (text === null) return false
    workspace.requestInsert(text)
    return true
  }

  /** Enter sobre un nodo: despliega los que tienen hijos, reintenta los errores y pega columnas y referencias. */
  function activate(node: TreeNode): void {
    if (node.expandable) toggle(node)
    else if (node.kind === 'error') retry(node)
    else insert(node)
  }

  /**
   * Prepara el árbol para mostrar `target`: quita el filtro, expande el schema (y la tabla) y lo marca como
   * nodo activo. El foco lo pone quien pinta el árbol. `false` si la pestaña no tiene sesión.
   */
  async function reveal(target: SchemaTarget | null): Promise<boolean> {
    const id = sessionId.value
    if (!id) return false
    filter.value = ''
    await cache.ensureSchemas(id)
    if (!target) {
      activeKey.value = null
      return true
    }
    cache.setExpanded(id, schemaKey(target.schema), true)
    void cache.ensureTables(id, target.schema)
    if (target.table === undefined) {
      activeKey.value = schemaKey(target.schema)
      return true
    }
    const table = { schema: target.schema, name: target.table }
    for (const group of ['tables', 'views'] as const) {
      cache.setExpanded(id, groupKey(target.schema, group), true)
    }
    cache.setExpanded(id, tableKey(table), true)
    void cache.ensureDetails(id, table)
    activeKey.value = tableKey(table)
    return true
  }

  watch(
    sessionId,
    (id) => {
      filter.value = ''
      activeKey.value = null
      if (id) void cache.ensureSchemas(id)
    },
    { immediate: true },
  )

  watch(
    () => live.value.map((entry) => entry.session.sessionId),
    (ids) => cache.retainSessions(new Set(ids)),
  )

  // Filtrar necesita saber qué tablas hay en cada schema: se piden todos los listados (son baratos, no el detalle).
  watch(
    [filtering, () => (sessionId.value ? cache.sessions[sessionId.value]?.schemas?.data : null)],
    ([active, schemas]) => {
      const id = sessionId.value
      if (!active || !id || !schemas) return
      for (const schema of schemas) void cache.ensureTables(id, schema.name)
    },
    { immediate: true },
  )

  let announceTimer: ReturnType<typeof setTimeout> | undefined
  watch(
    () => describeMatches(tree.value.matches, tree.value.pending, filter.value),
    (message) => {
      clearTimeout(announceTimer)
      if (message === '') {
        matchesAnnouncement.value = ''
        return
      }
      announceTimer = setTimeout(() => {
        matchesAnnouncement.value = message
      }, ANNOUNCE_DELAY_MS)
    },
  )
  onBeforeUnmount(() => clearTimeout(announceTimer))

  return {
    connection,
    engine,
    filter,
    filtering,
    tree,
    activeKey,
    focusKey,
    canInsert,
    matchesAnnouncement,
    notice: computed(() => cache.notice),
    toggle,
    activate,
    retry,
    retrySchemas,
    refresh,
    insert,
    reveal,
  }
}
