<script setup lang="ts">
import { computed } from 'vue'
import { usePreferencesStore } from '../../preferences'
import type { SqlTab } from '../../workspace/stores/workspace'
import { formatDuration, formatRows } from '../model/presentation'
import { useExecutionStore, type ExecutionMessage } from '../stores/execution'

const props = defineProps<{ tab: SqlTab }>()

const execution = useExecutionStore()
const preferences = usePreferencesStore()
const state = computed(() => execution.stateOf(props.tab.id))
const finished = computed(() => state.value.outcome !== null && state.value.status === 'idle')

// `\timing off` oculta la duración también en los mensajes que la llevan incrustada.
const textOf = (message: ExecutionMessage): string =>
  preferences.showTiming ? message.text : (message.untimedText ?? message.text)
</script>

<template>
  <div class="messages" data-part="messages">
    <p
      v-if="finished && state.durationMs !== null"
      class="messages__summary"
      data-part="run-summary"
    >
      <template v-if="preferences.showTiming"
        >Duración total: {{ formatDuration(state.durationMs) }} · </template
      >Filas recibidas: {{ formatRows(state.rowsReceived) }} · Sentencias ejecutadas:
      {{ state.statementsDone }}
    </p>
    <p v-if="state.droppedMessages > 0" class="placeholder" data-part="dropped-messages">
      Se omitieron los {{ state.droppedMessages }} mensajes más antiguos.
    </p>
    <div role="log" aria-label="Mensajes de ejecución" aria-relevant="additions" data-part="log">
      <ol class="messages__list">
        <li v-for="message in state.messages" :key="message.id" :data-kind="message.kind">
          {{ textOf(message) }}
        </li>
      </ol>
    </div>
    <p v-if="state.messages.length === 0" class="placeholder" data-part="no-messages">
      Todavía no hay mensajes de esta pestaña.
    </p>
  </div>
</template>

<style scoped>
.messages {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
}

.messages__summary {
  padding: var(--spacing-2) var(--spacing-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-card);
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
  line-height: var(--font-line-height-sm);
}

.messages__list {
  --message-color: var(--text-muted);
  --message-glyph: var(--status-glyph-inactive);
  margin: 0;
  padding: 0;
  overflow-wrap: anywhere;
  list-style: none;
}

.messages__list li {
  display: grid;
  grid-template-columns: 1.5em minmax(0, 1fr);
  padding: var(--spacing-1) var(--spacing-2);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
}

.messages__list li::before {
  content: var(--message-glyph);
  color: var(--message-color);
  font-weight: var(--font-weight-semibold);
}

.messages__list li[data-kind='statement'],
.messages__list li[data-kind='success'] {
  --message-color: var(--status-success);
  --message-glyph: var(--status-glyph-success);
}

.messages__list li[data-kind='error'] {
  --message-color: var(--status-error);
  --message-glyph: var(--status-glyph-error);
  color: var(--status-error);
}

.messages__list li[data-kind='warning'],
.messages__list li[data-kind='cancelled'] {
  --message-color: var(--status-warning);
  --message-glyph: var(--status-glyph-warning);
}

.messages__list li[data-kind='transaction'] {
  --message-color: var(--transaction-active);
  --message-glyph: var(--transaction-glyph-active);
}
</style>
