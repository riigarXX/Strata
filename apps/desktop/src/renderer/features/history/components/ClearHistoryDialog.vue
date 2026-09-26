<script setup lang="ts">
import { useId } from 'vue'
import ModalDialog from '../../../components/ModalDialog.vue'

defineProps<{
  open: boolean
  busy: boolean
  error: string
}>()

const emit = defineEmits<{
  confirm: []
  close: []
  'focus-lost': []
}>()

const uid = useId()
const titleId = `${uid}-title`
const descriptionId = `${uid}-description`
</script>

<template>
  <ModalDialog
    :open="open"
    :labelledby="titleId"
    :describedby="descriptionId"
    class="clear-history-dialog"
    data-dialog="clear-history"
    @close="emit('close')"
    @focus-lost="emit('focus-lost')"
  >
    <div v-if="open" class="clear-history-dialog__content">
      <h2 :id="titleId" class="clear-history-dialog__title">Vaciar historial</h2>
      <p :id="descriptionId">
        Se eliminarán todas las consultas guardadas en el historial de este equipo. Esta acción es
        irreversible y no se puede deshacer.
      </p>
      <p v-if="error" class="callout callout--error" role="alert" data-part="clear-error">
        <strong>No se pudo vaciar el historial.</strong> {{ error }}
      </p>
      <div class="clear-history-dialog__actions">
        <button
          type="button"
          class="btn btn--secondary"
          data-action="cancel-clear-history"
          autofocus
          @click="emit('close')"
        >
          Cancelar
        </button>
        <button
          type="button"
          class="btn btn--destructive"
          data-action="confirm-clear-history"
          :aria-disabled="busy ? 'true' : undefined"
          @click="!busy && emit('confirm')"
        >
          {{ busy ? 'Vaciando…' : 'Vaciar historial' }}
        </button>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
.clear-history-dialog {
  width: min(28rem, calc(100vw - 2 * var(--spacing-4)));
}

.clear-history-dialog__content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  padding: var(--spacing-6);
}

.clear-history-dialog__title {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-2);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}

.clear-history-dialog__title::before {
  content: var(--status-glyph-warning);
  color: var(--status-error);
  font-size: var(--font-size-base);
}

.clear-history-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--spacing-2);
}
</style>
