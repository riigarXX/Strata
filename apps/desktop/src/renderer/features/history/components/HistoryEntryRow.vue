<script setup lang="ts">
import type { HistoryEntry } from '@strata/contracts'
import { computed } from 'vue'
import { ENGINE_LABELS } from '../../connections/model/presentation'
import { formatDuration, formatRows } from '../../execution/model/presentation'
import {
  deleteLabel,
  formatAbsoluteDate,
  formatRelativeDate,
  HISTORY_STATUS_LABELS,
  previewSql,
} from '../model/presentation'

const props = defineProps<{
  entry: HistoryEntry
  /** Instante de referencia de la fecha relativa (el de la carga de la lista). */
  now: number
  /** Roving tabindex: solo la fila activa entra en el orden de tabulación. */
  tabbable: boolean
}>()

const emit = defineEmits<{
  reopen: []
  delete: []
  move: [direction: 'previous' | 'next' | 'first' | 'last']
  activate: []
}>()

const MOVES = {
  ArrowUp: 'previous',
  ArrowDown: 'next',
  Home: 'first',
  End: 'last',
} as const

// Enter y Espacio los resuelve el propio botón (clic → reabrir); aquí solo la navegación y Supr.
function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  const move = MOVES[event.key as keyof typeof MOVES]
  if (move) {
    event.preventDefault()
    emit('move', move)
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    emit('delete')
  }
}

const preview = computed(() => previewSql(props.entry.sql))
const relative = computed(() => formatRelativeDate(props.entry.executedAt, props.now))
const absolute = computed(() => formatAbsoluteDate(props.entry.executedAt))
</script>

<template>
  <li
    class="history-row"
    :data-entry-id="entry.id"
    :data-status="entry.status"
    @focusin="emit('activate')"
  >
    <button
      type="button"
      class="history-row__main"
      data-part="entry"
      :tabindex="tabbable ? 0 : -1"
      :title="entry.sql.slice(0, 1000)"
      aria-keyshortcuts="Delete"
      @click="emit('reopen')"
      @keydown="onKeydown"
    >
      <span class="history-row__sql mono">{{ preview }}</span>
      <span class="history-row__meta">
        <span class="history-row__status" :data-status="entry.status">
          <span class="history-row__glyph" aria-hidden="true"></span>
          <span>{{ HISTORY_STATUS_LABELS[entry.status] }}</span>
        </span>
        <span data-part="engine">{{ ENGINE_LABELS[entry.engine] }}</span>
        <span data-part="profile">{{ entry.profileName }}</span>
        <time :datetime="entry.executedAt" data-part="date">
          {{ relative ? `${relative} · ${absolute}` : absolute }}
        </time>
        <span data-part="duration">{{ formatDuration(entry.durationMs) }}</span>
        <span v-if="entry.rowCount !== undefined" data-part="rows">{{
          formatRows(entry.rowCount)
        }}</span>
        <span v-if="entry.errorCode" class="mono" data-part="error-code">{{
          entry.errorCode
        }}</span>
      </span>
    </button>
    <button
      type="button"
      class="btn btn--ghost btn--danger history-row__delete"
      data-action="delete-entry"
      tabindex="-1"
      :aria-label="deleteLabel(entry)"
      @click="emit('delete')"
    >
      Borrar
    </button>
  </li>
</template>

<style scoped>
.history-row {
  display: flex;
  align-items: stretch;
  gap: var(--spacing-2);
  padding: var(--spacing-1);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-card);
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-out),
    border-color var(--motion-duration-fast) var(--motion-easing-out);
}

/* Canvas y no muted: el verde/rojo/ámbar del estado solo llegan a AA como texto sobre superficies lisas. */
.history-row:hover {
  border-color: var(--border-default);
  background: var(--surface-canvas);
}

/* La fila con el foco lleva además una barra de acento: se reconoce sin depender del matiz. */
.history-row:focus-within {
  border-color: var(--border-strong);
  box-shadow: inset 3px 0 0 var(--action-primary);
}

.history-row__main {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: var(--spacing-1);
  min-width: 0;
  padding: var(--spacing-2) var(--spacing-3);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.history-row__sql {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-row__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--spacing-1) var(--spacing-3);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
  line-height: var(--font-line-height-sm);
}

.history-row__status {
  --status-color: var(--status-success);
  --status-glyph: var(--status-glyph-success);
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-1);
  color: var(--status-color);
  font-weight: var(--font-weight-medium);
}

.history-row__status[data-status='error'] {
  --status-color: var(--status-error);
  --status-glyph: var(--status-glyph-error);
}

.history-row__status[data-status='cancelled'] {
  --status-color: var(--status-warning);
  --status-glyph: var(--status-glyph-warning);
}

.history-row__glyph::before {
  content: var(--status-glyph);
  display: inline-block;
  width: 1em;
  text-align: center;
}

.history-row__meta [data-part='profile'] {
  color: var(--text-primary);
}

.history-row__meta [data-part='error-code'] {
  padding: 0 var(--spacing-1);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.history-row__delete {
  flex: none;
  align-self: center;
}
</style>
