<script setup lang="ts">
import type { ConnectionProfile } from '@strata/contracts'
import { computed, ref, useId } from 'vue'
import type { ConnectionRuntime, ProfileTestState } from '../stores/connections'
import { describeError, describeTarget, ENGINE_LABELS } from '../model/presentation'
import ConnectionStatusBadge from './ConnectionStatusBadge.vue'

const props = defineProps<{
  profile: ConnectionProfile
  runtime: ConnectionRuntime
  test: ProfileTestState | undefined
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
  connect: []
  disconnect: []
  reconnect: []
  test: []
  edit: []
  delete: []
  move: [direction: 'previous' | 'next' | 'first' | 'last']
}>()

const uid = useId()
const nameId = `${uid}-name`
const statusId = `${uid}-status`
const row = ref<HTMLElement | null>(null)

const connecting = computed(() => props.runtime.status === 'connecting')
const connected = computed(() => props.runtime.status === 'connected')
const showReconnect = computed(() => connected.value || props.runtime.reconnecting)
// Solo la fila seleccionada entra en el orden de tabulación (roving tabindex): con muchas conexiones
// no hay que atravesar cuatro botones por cada una; las flechas cambian de fila.
const tabindex = computed(() => (props.selected ? 0 : -1))

function togglePrimary(): void {
  if (connecting.value) return
  if (connected.value) emit('disconnect')
  else emit('connect')
}

// Con `aria-disabled` (y no `disabled`) los botones conservan el foco mientras hay una operación en curso.
function reconnectIfIdle(): void {
  if (!connecting.value) emit('reconnect')
}

function testIfIdle(): void {
  if (props.test?.status !== 'running') emit('test')
}

const MOVES = {
  ArrowUp: 'previous',
  ArrowDown: 'next',
  Home: 'first',
  End: 'last',
} as const

function onKeydown(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  if (event.metaKey || event.ctrlKey || event.altKey) return

  const move = MOVES[event.key as keyof typeof MOVES]
  if (move) {
    event.preventDefault()
    emit('move', move)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (!connected.value && !connecting.value) emit('connect')
  } else if (event.key === 'e' || event.key === 'E') {
    event.preventDefault()
    emit('edit')
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    emit('delete')
  }
}

defineExpose({ focus: () => row.value?.focus() })
</script>

<template>
  <li
    class="connection-item"
    :data-profile-id="profile.id"
    :data-status="runtime.status"
    :data-selected="selected ? 'true' : undefined"
    @focusin="emit('select')"
    @click="emit('select')"
  >
    <div
      ref="row"
      class="connection-item__summary"
      role="group"
      :tabindex="tabindex"
      :aria-labelledby="`${nameId} ${statusId}`"
      :aria-current="selected ? 'true' : undefined"
      @keydown="onKeydown"
    >
      <div class="connection-item__head">
        <span :id="nameId" class="connection-item__name">{{ profile.name }}</span>
        <ConnectionStatusBadge :id="statusId" :status="runtime.status" />
      </div>
      <div class="connection-item__meta">
        <span class="connection-item__engine">{{ ENGINE_LABELS[profile.engine] }}</span>
        <span v-if="profile.readOnly" class="connection-item__flag">Solo lectura</span>
        <span class="connection-item__target mono">{{ describeTarget(profile) }}</span>
      </div>
    </div>

    <div class="connection-item__actions" role="group" :aria-label="`Acciones de ${profile.name}`">
      <button
        type="button"
        class="btn btn--secondary connection-item__action"
        data-action="toggle-connection"
        :tabindex="tabindex"
        :aria-disabled="connecting ? 'true' : undefined"
        @click="togglePrimary"
      >
        {{ connecting ? 'Conectando…' : connected ? 'Desconectar' : 'Conectar' }}
      </button>
      <button
        v-if="showReconnect"
        type="button"
        class="btn btn--ghost connection-item__action"
        data-action="reconnect"
        :tabindex="tabindex"
        :aria-disabled="connecting ? 'true' : undefined"
        @click="reconnectIfIdle"
      >
        Reconectar
      </button>
      <button
        type="button"
        class="btn btn--ghost connection-item__action"
        data-action="test"
        :tabindex="tabindex"
        :aria-disabled="test?.status === 'running' ? 'true' : undefined"
        @click="testIfIdle"
      >
        {{ test?.status === 'running' ? 'Probando…' : 'Probar' }}
      </button>
      <button
        type="button"
        class="btn btn--ghost connection-item__action"
        data-action="edit"
        :tabindex="tabindex"
        @click="emit('edit')"
      >
        Editar
      </button>
      <button
        type="button"
        class="btn btn--ghost btn--danger connection-item__action"
        data-action="delete"
        :tabindex="tabindex"
        @click="emit('delete')"
      >
        Eliminar
      </button>
    </div>

    <p v-if="runtime.error" class="callout callout--error connection-item__error" role="alert">
      <strong>{{
        runtime.status === 'error' ? 'No se pudo conectar.' : 'No se pudo completar la acción.'
      }}</strong>
      {{ describeError(runtime.error) }}
    </p>
    <p
      v-if="test?.status === 'ok'"
      class="callout callout--success connection-item__test"
      data-result="ok"
      role="status"
    >
      Prueba correcta: servidor {{ test.serverVersion }} ({{ Math.round(test.latencyMs) }} ms).
    </p>
    <p
      v-else-if="test?.status === 'failed'"
      class="callout callout--error connection-item__test"
      data-result="failed"
      role="alert"
    >
      <strong>La prueba de conexión falló.</strong> {{ describeError(test.error) }}
    </p>
  </li>
</template>

<style scoped>
.connection-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-2) var(--spacing-4);
  padding: var(--spacing-3) var(--spacing-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-card);
  box-shadow: var(--shadow-glass);
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-out),
    border-color var(--motion-duration-fast) var(--motion-easing-out);
}

.connection-item:hover {
  background: var(--surface-elevated);
}

.connection-item[data-selected='true'] {
  border-color: var(--action-primary);
  background: var(--surface-elevated);
  box-shadow: var(--shadow-glow-ring), var(--shadow-glass);
}

.connection-item:has(.connection-item__summary:focus-visible) {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.connection-item__summary {
  display: flex;
  flex: 1 1 18rem;
  flex-direction: column;
  gap: var(--spacing-1);
  min-width: 0;
  outline: none;
}

.connection-item__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-1) var(--spacing-3);
}

.connection-item__name {
  min-width: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-md);
  overflow-wrap: anywhere;
}

.connection-item__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 var(--spacing-3);
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
}

.connection-item__engine {
  font-weight: var(--font-weight-medium);
}

.connection-item__flag {
  padding: 0 var(--spacing-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.connection-item__target {
  min-width: 0;
  font-size: var(--font-size-xs);
  overflow-wrap: anywhere;
}

.connection-item__actions {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-1);
  margin-inline-start: auto;
}

.connection-item__error,
.connection-item__test {
  flex: 1 1 100%;
}
</style>
