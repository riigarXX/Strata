<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { deepActiveElement } from './focus'

const props = defineProps<{
  open: boolean
  /** Id del elemento que titula el diálogo. */
  labelledby: string
  describedby?: string
  /** Diálogo ancho, para vistas completas en lugar de formularios. */
  wide?: boolean
}>()

const emit = defineEmits<{
  close: []
  /** El elemento que abrió el diálogo ya no existe: el propietario decide dónde poner el foco. */
  'focus-lost': []
}>()

const dialog = ref<HTMLDialogElement | null>(null)
let opener: HTMLElement | null = null

function restoreFocus(): void {
  const target = opener
  opener = null
  if (target?.isConnected) target.focus()
  else emit('focus-lost')
}

function sync(open: boolean): void {
  const element = dialog.value
  if (!element) return
  if (open && !element.open) {
    opener = deepActiveElement()
    element.showModal()
  } else if (!open) {
    if (element.open) element.close()
    restoreFocus()
  }
}

onMounted(() => {
  if (props.open) sync(true)
})
watch(() => props.open, sync, { flush: 'post' })

// `showModal()` atrapa el foco y ya inertiza el resto de la página; `cancel` (Esc) se enruta por el
// propietario para que el estado `open` sea siempre la única fuente de verdad.
function onCancel(): void {
  emit('close')
}

// Cierre nativo por otra vía (p. ej. `<form method="dialog">`): el evento llega asíncrono en Chromium, así que
// puede llegar cuando el propietario ya lo ha vuelto a abrir; entonces es el eco de un cierre anterior y se ignora.
function onNativeClose(): void {
  if (props.open && !dialog.value?.open) emit('close')
}

onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close()
})
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    :aria-labelledby="labelledby"
    :aria-describedby="describedby"
    :data-size="wide ? 'wide' : undefined"
    @cancel.prevent="onCancel"
    @close="onNativeClose"
  >
    <slot />
  </dialog>
</template>

<style scoped>
.modal {
  width: min(32rem, calc(100vw - 2 * var(--spacing-4)));
  max-width: none;
  max-height: calc(100vh - 2 * var(--spacing-6));
  padding: 0;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--dialog-border);
  border-radius: var(--radius-lg);
  background: var(--dialog-bg);
  box-shadow: var(--dialog-shadow);
  color: var(--text-primary);
}

.modal[data-size='wide'] {
  width: min(56rem, calc(100vw - 2 * var(--spacing-4)));
}

.modal[open] {
  animation: modal-in var(--motion-duration-base) var(--motion-easing-expo-out);
}

.modal::backdrop {
  background: var(--overlay-scrim);
  backdrop-filter: blur(var(--glass-blur));
}

.modal[open]::backdrop {
  animation: modal-backdrop-in var(--motion-duration-base) var(--motion-easing-out);
}

@keyframes modal-in {
  from {
    opacity: 0;
    transform: translateY(var(--spacing-2)) scale(0.98);
  }
}

@keyframes modal-backdrop-in {
  from {
    opacity: 0;
  }
}
</style>
