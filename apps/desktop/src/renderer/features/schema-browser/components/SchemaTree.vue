<script setup lang="ts">
import { computed, ref } from 'vue'
import { nodeLabel, type TreeNode } from '../model/tree'
import { Typeahead } from '../model/typeahead'
import SchemaTreeItem from './SchemaTreeItem.vue'

const props = defineProps<{
  roots: readonly TreeNode[]
  /** Nodos navegables en orden de pantalla (los `treeitem` visibles). */
  items: readonly TreeNode[]
  focusKey: string | null
  activeKey: string | null
  label: string
  describedBy?: string
}>()

const emit = defineEmits<{
  focusNode: [key: string]
  toggle: [node: TreeNode, expanded: boolean]
  activate: [node: TreeNode]
  insert: [node: TreeNode]
  retry: [node: TreeNode]
  refresh: []
  focusFilter: []
}>()

const root = ref<HTMLElement | null>(null)
const typeahead = new Typeahead()
const byKey = computed(() => new Map(props.items.map((item) => [item.key, item])))

function element(key: string): HTMLElement | null {
  const candidates = root.value?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []
  return Array.from(candidates).find((candidate) => candidate.dataset.nodeKey === key) ?? null
}

function focusItem(key: string | null | undefined): void {
  if (key) element(key)?.focus()
}

function focusAt(index: number): void {
  focusItem(props.items[Math.min(Math.max(index, 0), props.items.length - 1)]?.key)
}

/** Entrada por teclado al árbol (desde el filtro): el nodo con tabindex 0. */
function focusActive(): void {
  focusItem(props.focusKey)
}

defineExpose({ focusActive })

function nodeOf(target: EventTarget | null): TreeNode | null {
  const item = (target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]')
  return (item?.dataset.nodeKey ? byKey.value.get(item.dataset.nodeKey) : null) ?? null
}

function firstChildItem(node: TreeNode): TreeNode | undefined {
  return node.children.find((child) => child.kind !== 'loading' && child.kind !== 'empty')
}

// Patrón WAI-ARIA «Tree View» (foco en el nodo, tabindex móvil). Las combinaciones con Cmd/Ctrl/Alt
// no se tocan para no pisar los atajos globales, salvo Cmd/Ctrl+F (filtrar) dentro del árbol.
function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || (event.target as HTMLElement).getAttribute('role') !== 'treeitem') return
  const node = nodeOf(event.target)
  if (!node) return

  if (event.metaKey || event.ctrlKey || event.altKey) {
    if (!event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      emit('focusFilter')
    }
    return
  }

  const index = props.items.indexOf(node)
  switch (event.key) {
    case 'ArrowDown':
      focusAt(index + 1)
      break
    case 'ArrowUp':
      focusAt(index - 1)
      break
    case 'Home':
      focusAt(0)
      break
    case 'End':
      focusAt(props.items.length - 1)
      break
    case 'ArrowRight':
      if (!node.expandable) return
      if (!node.expanded) emit('toggle', node, true)
      else focusItem(firstChildItem(node)?.key)
      break
    case 'ArrowLeft':
      if (node.expandable && node.expanded) emit('toggle', node, false)
      else focusItem(node.parentKey)
      break
    case 'Enter':
      if (event.shiftKey) emit('insert', node)
      else emit('activate', node)
      break
    case 'F5':
      emit('refresh')
      break
    default: {
      const printable = event.key.length === 1
      if (!printable) return
      if (event.key === ' ' && !typeahead.active) {
        emit('activate', node)
        break
      }
      const labels = props.items.map(nodeLabel)
      const target = typeahead.push(event.key, labels, index, Date.now())
      if (target !== null) focusAt(target)
    }
  }
  event.preventDefault()
}

function onFocusin(event: FocusEvent): void {
  const node = nodeOf(event.target)
  if (node && (event.target as HTMLElement).getAttribute('role') === 'treeitem') {
    emit('focusNode', node.key)
  }
}

function onClick(event: MouseEvent): void {
  const node = nodeOf(event.target)
  if (!node) return
  if ((event.target as HTMLElement).closest('[data-action="retry"]')) {
    emit('retry', node)
    return
  }
  element(node.key)?.focus()
  // El segundo clic de un doble clic no vuelve a alternar: el doble clic inserta.
  if (node.expandable && event.detail <= 1) emit('toggle', node, !node.expanded)
}

function onDblclick(event: MouseEvent): void {
  const node = nodeOf(event.target)
  if (node && !(event.target as HTMLElement).closest('[data-action="retry"]')) emit('insert', node)
}
</script>

<template>
  <ul
    ref="root"
    role="tree"
    class="schema-tree"
    :aria-label="label"
    :aria-describedby="describedBy"
    @keydown="onKeydown"
    @focusin="onFocusin"
    @click="onClick"
    @dblclick="onDblclick"
  >
    <SchemaTreeItem
      v-for="node in roots"
      :key="node.key"
      :node="node"
      :focus-key="focusKey"
      :active-key="activeKey"
    />
  </ul>
</template>

<style scoped>
/* `position: relative`: los `.visually-hidden` de los nodos (absolutos) se recortan y desplazan con el árbol. */
.schema-tree {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
</style>
