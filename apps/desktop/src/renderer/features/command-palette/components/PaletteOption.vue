<script setup lang="ts">
import { computed } from 'vue'
import { splitByRanges } from '../model/highlight'
import type { PaletteItem } from '../model/palette-items'

const props = defineProps<{
  id: string
  item: PaletteItem
  selected: boolean
  /** Muestra la categoría junto al título (listas sin encabezados de grupo). */
  showCategory: boolean
}>()

defineEmits<{ choose: []; hover: [] }>()

const segments = computed(() => splitByRanges(props.item.label, props.item.ranges))
const disabled = computed(() => props.item.disabledReason !== null)
</script>

<template>
  <li
    :id="id"
    role="option"
    class="palette-option"
    :aria-selected="selected ? 'true' : 'false'"
    :aria-disabled="disabled ? 'true' : undefined"
    :data-active="selected ? 'true' : undefined"
    :data-disabled="disabled ? 'true' : undefined"
    :data-item="item.key"
    @mousemove="$emit('hover')"
    @mousedown.prevent
    @click="$emit('choose')"
  >
    <span class="palette-option__main">
      <span class="palette-option__label"
        ><template v-for="(segment, index) in segments" :key="index"
          ><mark v-if="segment.match" class="palette-option__match">{{ segment.text }}</mark
          ><template v-else>{{ segment.text }}</template></template
        ></span
      >
      <span v-if="item.detail" class="palette-option__detail">{{ item.detail }}</span>
      <span v-if="showCategory && item.category" class="palette-option__category">{{
        item.category
      }}</span>
      <kbd v-if="item.shortcut" class="palette-option__shortcut">{{ item.shortcut }}</kbd>
    </span>
    <span v-if="item.disabledReason" class="palette-option__reason" data-part="palette-reason">{{
      item.disabledReason
    }}</span>
    <span v-else-if="item.description" class="palette-option__description">{{
      item.description
    }}</span>
  </li>
</template>

<style scoped>
.palette-option {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-1);
  padding: var(--spacing-2) var(--spacing-3);
  border-inline-start: 2px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.palette-option[data-active='true'] {
  border-inline-start-color: var(--action-primary);
  background: var(--surface-muted);
}

.palette-option[data-disabled='true'] {
  color: var(--text-muted);
  cursor: not-allowed;
}

.palette-option__main {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-2);
}

.palette-option__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Fondo, subrayado y peso: la coincidencia se ve aunque no se distinga el matiz. */
.palette-option__match {
  padding: 0 1px;
  border-radius: var(--radius-xs);
  background: var(--highlight-match-bg);
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.palette-option__detail,
.palette-option__category,
.palette-option__description,
.palette-option__reason {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.palette-option__category {
  flex: none;
}

.palette-option__reason {
  font-style: italic;
}

.palette-option__reason::before {
  content: var(--status-glyph-inactive);
  margin-inline-end: var(--spacing-1);
  font-style: normal;
}

.palette-option__shortcut {
  flex: none;
  min-width: 2em;
  padding: 0 var(--spacing-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xs);
  background: var(--surface-card);
  color: var(--text-primary);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
  text-align: center;
}
</style>
