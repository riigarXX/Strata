<script setup lang="ts">
import { describeForeignKey, GROUP_LABELS, SECTION_LABELS, TABLE_KIND_LABELS } from '../model/tree'
import type { TreeNode } from '../model/tree'

// Presentacional: teclado y ratón se gestionan por delegación en `SchemaTree`, que localiza el nodo
// por `data-node-key`.
defineProps<{ node: TreeNode; focusKey: string | null; activeKey: string | null }>()
</script>

<template>
  <li v-if="node.kind === 'loading' || node.kind === 'empty'" role="none" class="tree-status">
    <span role="status" class="tree-status__text" :data-status="node.kind">{{ node.what }}</span>
  </li>

  <li
    v-else
    role="treeitem"
    class="tree-item"
    :data-node-key="node.key"
    :data-kind="node.kind"
    :aria-level="node.level"
    :aria-posinset="node.posInSet"
    :aria-setsize="node.setSize"
    :aria-expanded="node.expandable ? (node.expanded ? 'true' : 'false') : undefined"
    :aria-selected="node.key === activeKey ? 'true' : 'false'"
    :tabindex="node.key === focusKey ? 0 : -1"
  >
    <div class="tree-row" :style="{ '--tree-level': node.level }">
      <span class="tree-row__chevron" aria-hidden="true">{{
        node.expandable ? (node.expanded ? '▾' : '▸') : ''
      }}</span>

      <template v-if="node.kind === 'schema'">
        <span class="tree-row__name">{{ node.schema }}</span>
      </template>

      <template v-else-if="node.kind === 'group'">
        <span class="tree-row__name">{{ GROUP_LABELS[node.group] }}</span>
        <span class="tree-row__meta">({{ node.count }})</span>
      </template>

      <template v-else-if="node.kind === 'table'">
        <span class="tree-row__name">{{ node.table.name }}</span>
        <span class="tree-row__meta" data-part="kind">{{
          TABLE_KIND_LABELS[node.table.kind]
        }}</span>
      </template>

      <template v-else-if="node.kind === 'section'">
        <span class="tree-row__name">{{ SECTION_LABELS[node.section] }}</span>
        <span class="tree-row__meta">({{ node.count }})</span>
      </template>

      <template v-else-if="node.kind === 'column'">
        <span class="tree-row__name">{{ node.column.name }}</span>
        <span class="tree-row__meta mono" data-part="type">{{ node.column.dataType }}</span>
        <template v-if="node.primaryKey">
          <span class="tree-row__badge" data-part="primary-key" aria-hidden="true">PK</span>
          <span class="visually-hidden">clave primaria</span>
        </template>
        <span class="tree-row__meta" data-part="nullable">{{
          node.column.nullable ? 'NULL' : 'NOT NULL'
        }}</span>
      </template>

      <template v-else-if="node.kind === 'foreign-key'">
        <span class="tree-row__name" data-part="foreign-key">{{
          describeForeignKey(node.foreignKey)
        }}</span>
      </template>

      <template v-else-if="node.kind === 'index'">
        <span class="tree-row__name">{{ node.index.name }}</span>
        <span class="tree-row__meta mono" data-part="columns"
          >({{ node.index.columns.join(', ') }})</span
        >
        <span v-if="node.index.unique" class="tree-row__badge" data-part="unique">única</span>
      </template>

      <template v-else-if="node.kind === 'error'">
        <span class="tree-row__error" role="alert" data-part="error">{{ node.error.message }}</span>
        <button
          type="button"
          class="btn btn--secondary tree-row__retry"
          data-action="retry"
          tabindex="-1"
        >
          Reintentar
        </button>
      </template>
    </div>

    <ul v-if="node.expandable && node.expanded && node.children.length > 0" role="group">
      <SchemaTreeItem
        v-for="child in node.children"
        :key="child.key"
        :node="child"
        :focus-key="focusKey"
        :active-key="activeKey"
      />
    </ul>
  </li>
</template>

<style scoped>
.tree-item {
  list-style: none;
}

/* El foco lo tiene el `li` (que contiene a sus hijos): se dibuja solo sobre su fila. */
.tree-item:focus-visible {
  outline: none;
}

.tree-item:focus-visible > .tree-row {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}

/* El chevron sale del flujo y el relleno reserva su hueco: al partirse la fila, las líneas siguientes
   quedan alineadas con el nombre y no bajo el chevron. */
.tree-row {
  --tree-indent: calc((var(--tree-level) - 1) * var(--spacing-3) + var(--spacing-1));
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 var(--spacing-1);
  min-height: 24px;
  padding-block: 2px;
  padding-inline: calc(var(--tree-indent) + 1em + var(--spacing-1)) var(--spacing-1);
  border-radius: var(--radius-xs);
  cursor: default;
  user-select: none;
}

.tree-row:hover {
  background: var(--surface-muted);
}

/* La selección no depende solo del color: lleva además una barra de acento en el borde. */
.tree-item[aria-selected='true'] > .tree-row {
  background: var(--surface-secondary);
  box-shadow: inset 2px 0 0 var(--action-primary);
  color: var(--text-on-secondary);
}

/* Los textos atenuados no alcanzan AA sobre el fondo de la fila seleccionada. */
.tree-item[aria-selected='true'] > .tree-row .tree-row__meta,
.tree-item[aria-selected='true'] > .tree-row .tree-row__chevron {
  color: inherit;
}

.tree-row__chevron {
  position: absolute;
  inset-block-start: 2px;
  inset-inline-start: var(--tree-indent);
  width: 1em;
  color: var(--text-muted);
  text-align: center;
}

.tree-row__name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.tree-row__meta {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.tree-row__badge {
  padding: 0 var(--spacing-1);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.tree-row__error {
  min-width: 0;
  color: var(--status-error);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  overflow-wrap: anywhere;
}

.tree-row__error::before {
  content: var(--status-glyph-error);
  margin-inline-end: var(--spacing-1);
  font-weight: var(--font-weight-semibold);
}

.tree-row__retry {
  flex: none;
  min-height: 24px;
}

.tree-status__text {
  display: block;
  padding-block: 2px;
  padding-inline: calc(var(--spacing-3) * 2);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  overflow-wrap: anywhere;
}

.tree-status__text[data-status='loading']::before {
  content: '';
  display: inline-block;
  width: 1em;
  height: 1em;
  margin-inline-end: 0.5em;
  border: 2px solid currentColor;
  border-block-start-color: transparent;
  border-radius: var(--radius-full);
  vertical-align: -0.15em;
  animation: spin var(--motion-duration-spin) var(--motion-easing-linear)
    var(--motion-iteration-loop);
}
</style>
