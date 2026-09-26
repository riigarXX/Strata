<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: number
    min: number
    max: number
    /** `vertical`: línea vertical entre dos columnas (flechas izquierda/derecha). */
    orientation: 'vertical' | 'horizontal'
    label: string
    /** Id del panel cuyo tamaño controla. */
    controls?: string
    /** El valor crece al alejarse del origen del eje (panel inferior: subir agranda). */
    inverted?: boolean
    step?: number
  }>(),
  { controls: undefined, inverted: false, step: 16 },
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const dragging = ref(false)
let dragOrigin = { pointer: 0, value: 0 }

// Con `inverted` (panel inferior) subir el separador agranda el panel.
const forwardKey = computed(() => (props.orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'))
const backwardKey = computed(() => (props.orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'))
const growKey = computed(() => (props.inverted ? backwardKey.value : forwardKey.value))
const shrinkKey = computed(() => (props.inverted ? forwardKey.value : backwardKey.value))

const value = computed(() => Math.min(Math.max(props.modelValue, props.min), props.max))
const valueText = computed(() => `${Math.round(value.value)} píxeles`)

function commit(next: number): void {
  const clamped = Math.min(Math.max(Math.round(next), props.min), props.max)
  if (clamped !== value.value) emit('update:modelValue', clamped)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const amount = event.shiftKey ? props.step * 4 : props.step
  if (event.key === growKey.value) commit(value.value + amount)
  else if (event.key === shrinkKey.value) commit(value.value - amount)
  else if (event.key === 'Home') commit(props.min)
  else if (event.key === 'End') commit(props.max)
  else return
  event.preventDefault()
}

function pointerAxis(event: PointerEvent): number {
  return props.orientation === 'vertical' ? event.clientX : event.clientY
}

function onPointerdown(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  ;(event.currentTarget as HTMLElement).focus()
  dragging.value = true
  dragOrigin = { pointer: pointerAxis(event), value: value.value }
}

function onPointermove(event: PointerEvent): void {
  if (!dragging.value) return
  const delta = pointerAxis(event) - dragOrigin.pointer
  commit(dragOrigin.value + (props.inverted ? -delta : delta))
}

function endDrag(): void {
  dragging.value = false
}
</script>

<template>
  <div
    class="resize-separator"
    role="separator"
    tabindex="0"
    :aria-orientation="orientation"
    :aria-label="label"
    :aria-controls="controls"
    :aria-valuenow="Math.round(value)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuetext="valueText"
    :data-orientation="orientation"
    :data-dragging="dragging ? 'true' : undefined"
    @keydown="onKeydown"
    @pointerdown="onPointerdown"
    @pointermove="onPointermove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @lostpointercapture="endDrag"
  ></div>
</template>

<style scoped>
.resize-separator {
  position: relative;
  flex: none;
  touch-action: none;
  background: var(--border-subtle);
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-out),
    box-shadow var(--motion-duration-fast) var(--motion-easing-out);
}

.resize-separator[data-orientation='vertical'] {
  width: 1px;
  cursor: col-resize;
}

.resize-separator[data-orientation='horizontal'] {
  height: 1px;
  cursor: row-resize;
}

/* Zona de agarre mayor que la línea visible, sin ocupar espacio de layout. */
.resize-separator::before {
  content: '';
  position: absolute;
}

.resize-separator[data-orientation='vertical']::before {
  inset-block: 0;
  inset-inline: calc(-1 * var(--spacing-1));
}

.resize-separator[data-orientation='horizontal']::before {
  inset-block: calc(-1 * var(--spacing-1));
  inset-inline: 0;
}

/* La línea se engrosa con una sombra (no con el ancho) para no desplazar el layout al pasar el ratón. */
.resize-separator:hover,
.resize-separator[data-dragging='true'] {
  background: var(--action-primary);
  box-shadow: 0 0 0 1px var(--action-primary);
}

.resize-separator:focus-visible {
  outline-offset: 0;
  background: var(--focus-ring);
}
</style>
