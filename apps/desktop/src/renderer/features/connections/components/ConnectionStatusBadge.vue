<script setup lang="ts">
import { computed } from 'vue'
import { STATUS_PRESENTATION, type ConnectionUiStatus } from '../model/presentation'

const props = defineProps<{ status: ConnectionUiStatus }>()

const presentation = computed(() => STATUS_PRESENTATION[props.status])
</script>

<template>
  <span class="connection-status" :data-status="status">
    <span class="connection-status__glyph" aria-hidden="true"></span>
    <span class="connection-status__label">{{ presentation.label }}</span>
  </span>
</template>

<style scoped>
.connection-status {
  --status-color: var(--connection-offline);
  --status-glyph: var(--connection-glyph-offline);
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--spacing-1);
  min-height: 24px;
  padding: 0 var(--spacing-2);
  border: 1px var(--status-outline-success) var(--status-color);
  border-radius: var(--radius-full);
  color: var(--status-color);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  line-height: var(--font-line-height-xs);
  white-space: nowrap;
}

.connection-status__glyph::before {
  content: var(--status-glyph);
  display: inline-block;
  width: 1em;
  text-align: center;
}

.connection-status[data-status='connected'] {
  --status-color: var(--connection-online);
  --status-glyph: var(--connection-glyph-online);
}

.connection-status[data-status='connecting'] {
  --status-color: var(--connection-connecting);
  --status-glyph: var(--connection-glyph-connecting);
  border-style: var(--status-outline-warning);
}

.connection-status[data-status='connecting'] .connection-status__glyph::before {
  animation: spin var(--motion-duration-spin) var(--motion-easing-linear)
    var(--motion-iteration-loop);
}

.connection-status[data-status='error'] {
  --status-color: var(--status-error);
  --status-glyph: var(--status-glyph-error);
  padding: 0 calc(var(--spacing-2) - 2px);
  border-width: 3px;
  border-style: var(--status-outline-error);
}
</style>
