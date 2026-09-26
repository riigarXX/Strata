<script setup lang="ts">
import type { AnalyzedStatement } from '@strata/db-core'
import { computed, useId } from 'vue'
import ModalDialog from '../../../components/ModalDialog.vue'
import { describeDestructive } from '../model/destructive'

const props = defineProps<{
  open: boolean
  statements: readonly AnalyzedStatement[]
}>()

const emit = defineEmits<{
  confirm: []
  close: []
  'focus-lost': []
}>()

const VISIBLE_STATEMENTS = 10
const STATEMENT_PREVIEW_LENGTH = 200

const uid = useId()
const titleId = `${uid}-title`
const descriptionId = `${uid}-description`

const visible = computed(() => props.statements.slice(0, VISIBLE_STATEMENTS))
const hidden = computed(() => Math.max(0, props.statements.length - VISIBLE_STATEMENTS))

function preview(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length > STATEMENT_PREVIEW_LENGTH
    ? `${flat.slice(0, STATEMENT_PREVIEW_LENGTH - 1)}…`
    : flat
}
</script>

<template>
  <ModalDialog
    :open="open"
    :labelledby="titleId"
    :describedby="descriptionId"
    class="destructive-dialog"
    data-dialog="destructive-confirmation"
    @close="emit('close')"
    @focus-lost="emit('focus-lost')"
  >
    <div v-if="open" class="destructive-dialog__content">
      <h2 :id="titleId" class="destructive-dialog__title">Confirmar operación destructiva</h2>
      <div :id="descriptionId" class="destructive-dialog__description">
        <p>
          {{
            statements.length === 1
              ? 'Esta sentencia puede eliminar datos o cambiar la estructura y no se puede deshacer:'
              : `Estas ${statements.length} sentencias pueden eliminar datos o cambiar la estructura y no se pueden deshacer:`
          }}
        </p>
        <ul class="destructive-dialog__list" data-part="destructive-statements">
          <li v-for="(statement, index) in visible" :key="index" class="destructive-dialog__item">
            <code class="mono destructive-dialog__sql">{{ preview(statement.text) }}</code>
            <span class="destructive-dialog__reason">{{ describeDestructive(statement) }}</span>
          </li>
        </ul>
        <p v-if="hidden > 0" data-part="destructive-hidden">y {{ hidden }} más.</p>
      </div>
      <div class="destructive-dialog__actions">
        <button
          type="button"
          class="btn btn--secondary"
          data-action="cancel-destructive"
          autofocus
          @click="emit('close')"
        >
          Cancelar
        </button>
        <button
          type="button"
          class="btn btn--destructive"
          data-action="confirm-destructive"
          @click="emit('confirm')"
        >
          Ejecutar de todos modos
        </button>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
.destructive-dialog {
  width: min(36rem, calc(100vw - 2 * var(--spacing-4)));
}

.destructive-dialog__content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  padding: var(--spacing-6);
}

.destructive-dialog__title {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-2);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}

.destructive-dialog__title::before {
  content: var(--status-glyph-warning);
  color: var(--status-error);
  font-size: var(--font-size-base);
}

.destructive-dialog__description {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
  overflow-wrap: anywhere;
}

.destructive-dialog__list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  max-height: 40vh;
  overflow: auto;
}

/* Cada sentencia lleva una barra de error y el motivo con glifo: el riesgo no depende del matiz. */
.destructive-dialog__item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-1);
  padding: var(--spacing-2) var(--spacing-3);
  border: 1px solid var(--border-subtle);
  border-inline-start: 3px solid var(--status-error);
  border-radius: var(--radius-sm);
  background: var(--surface-canvas);
}

.destructive-dialog__sql {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.destructive-dialog__reason {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
}

.destructive-dialog__reason::before {
  content: var(--status-glyph-warning);
  margin-inline-end: var(--spacing-1);
  color: var(--status-error);
}

.destructive-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--spacing-2);
}
</style>
