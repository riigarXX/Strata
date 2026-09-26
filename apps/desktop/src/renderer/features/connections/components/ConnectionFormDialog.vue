<script setup lang="ts">
import type { ConnectionProfile } from '@strata/contracts'
import { useId } from 'vue'
import ModalDialog from '../../../components/ModalDialog.vue'
import ConnectionProfileForm from './ConnectionProfileForm.vue'

defineProps<{
  open: boolean
  /** Perfil que se edita; `null` para crear uno nuevo. */
  profile: ConnectionProfile | null
}>()

const emit = defineEmits<{
  close: []
  saved: [profile: ConnectionProfile, passwordSent: boolean]
  'focus-lost': []
}>()

const titleId = useId()
</script>

<template>
  <ModalDialog
    :open="open"
    :labelledby="titleId"
    class="connection-dialog"
    @close="emit('close')"
    @focus-lost="emit('focus-lost')"
  >
    <!-- Se monta solo con el diálogo abierto: cada apertura empieza con un estado (y una password) limpios. -->
    <ConnectionProfileForm
      v-if="open"
      :profile="profile"
      :title-id="titleId"
      @cancel="emit('close')"
      @saved="(saved, passwordSent) => emit('saved', saved, passwordSent)"
    />
  </ModalDialog>
</template>

<style scoped>
.connection-dialog {
  width: min(36rem, calc(100vw - 2 * var(--spacing-4)));
}
</style>
