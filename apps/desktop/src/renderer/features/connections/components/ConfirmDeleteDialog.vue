<script setup lang="ts">
import type { ConnectionProfile } from '@strata/contracts'
import { computed, useId } from 'vue'
import ModalDialog from '../../../components/ModalDialog.vue'
import { hasStoredPassword } from '../model/profile-form'

const props = defineProps<{
  open: boolean
  profile: ConnectionProfile | null
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

const hasSecret = computed(() => hasStoredPassword(props.profile))

function confirm(): void {
  if (!props.busy) emit('confirm')
}
</script>

<template>
  <ModalDialog
    :open="open"
    :labelledby="titleId"
    :describedby="descriptionId"
    class="confirm-dialog"
    @close="emit('close')"
    @focus-lost="emit('focus-lost')"
  >
    <div v-if="open && profile" class="confirm-dialog__content">
      <h2 :id="titleId" class="confirm-dialog__title">Eliminar conexión</h2>
      <div :id="descriptionId" class="confirm-dialog__description">
        <p>
          Se eliminará la conexión <strong>«{{ profile.name }}»</strong> y se cerrarán sus sesiones
          abiertas. Esta acción no se puede deshacer.
        </p>
        <p v-if="hasSecret" class="callout callout--warning" data-notice="secret">
          La contraseña guardada de esta conexión también se eliminará.
        </p>
      </div>
      <p v-if="error" class="callout callout--error confirm-dialog__error" role="alert">
        <strong>No se pudo eliminar la conexión.</strong> {{ error }}
      </p>
      <div class="confirm-dialog__actions">
        <button
          type="button"
          class="btn btn--secondary confirm-dialog__button"
          data-action="cancel"
          autofocus
          @click="emit('close')"
        >
          Cancelar
        </button>
        <button
          type="button"
          class="btn btn--destructive confirm-dialog__button"
          data-action="confirm-delete"
          :aria-disabled="busy ? 'true' : undefined"
          @click="confirm"
        >
          {{ busy ? 'Eliminando…' : 'Eliminar' }}
        </button>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
.confirm-dialog {
  width: min(28rem, calc(100vw - 2 * var(--spacing-4)));
}

.confirm-dialog__content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  padding: var(--spacing-6);
}

.confirm-dialog__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}

.confirm-dialog__description {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
  overflow-wrap: anywhere;
}

.confirm-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--spacing-2);
}
</style>
