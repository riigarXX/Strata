<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import ModalDialog from '../../../components/ModalDialog.vue'
import { describeError, ENGINE_LABELS } from '../model/presentation'
import { useConnectionsStore } from '../stores/connections'
import { useConnectionsPanelStore } from '../stores/connections-panel'
import ConnectionsView from './ConnectionsView.vue'
import ConnectionStatusBadge from './ConnectionStatusBadge.vue'

type Direction = 'previous' | 'next' | 'first' | 'last'

const store = useConnectionsStore()
const panel = useConnectionsPanelStore()
const uid = useId()
const titleId = `${uid}-title`
const manageTitleId = `${uid}-manage-title`

const list = ref<HTMLElement | null>(null)
const manageButton = ref<HTMLButtonElement | null>(null)
const manageOpen = computed({
  get: () => panel.manageOpen,
  set: (value) => (value ? panel.openManage() : panel.closeManage()),
})

const loading = computed(() => store.loadStatus === 'loading' || store.loadStatus === 'idle')
const failed = computed(() => store.loadStatus === 'error')
const empty = computed(() => store.loadStatus === 'ready' && store.profiles.length === 0)

onMounted(() => {
  if (store.loadStatus === 'idle') void store.load()
})

function toggle(profileId: string): void {
  const { status } = store.runtimeOf(profileId)
  if (status === 'connecting') return
  if (status === 'connected') void store.disconnect(profileId)
  else void store.connect(profileId)
}

function actionLabel(profileId: string): string {
  const { status } = store.runtimeOf(profileId)
  return status === 'connecting'
    ? 'Conectando…'
    : status === 'connected'
      ? 'Desconectar'
      : 'Conectar'
}

const MOVES: Record<string, Direction> = {
  ArrowUp: 'previous',
  ArrowDown: 'next',
  Home: 'first',
  End: 'last',
}

function move(index: number, direction: Direction): void {
  const last = store.profiles.length - 1
  const target = {
    previous: Math.max(index - 1, 0),
    next: Math.min(index + 1, last),
    first: 0,
    last,
  }[direction]
  list.value?.querySelectorAll<HTMLElement>('[data-action="toggle-connection"]')[target]?.focus()
}

function onKeydown(event: KeyboardEvent, index: number): void {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  const direction = MOVES[event.key]
  if (!direction) return
  event.preventDefault()
  move(index, direction)
}

function focusManageButton(): void {
  manageButton.value?.focus()
}
</script>

<template>
  <section
    class="conn-sidebar"
    :aria-labelledby="titleId"
    :aria-busy="loading ? 'true' : undefined"
    data-region="connections"
  >
    <header class="conn-sidebar__header">
      <h2 :id="titleId" class="conn-sidebar__title">Conexiones</h2>
      <button
        ref="manageButton"
        type="button"
        class="btn btn--secondary conn-sidebar__manage"
        data-action="manage-connections"
        aria-haspopup="dialog"
        @click="manageOpen = true"
      >
        Gestionar conexiones
      </button>
    </header>

    <p class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {{ store.notice }}
    </p>

    <p v-if="loading" class="callout callout--running" role="status">Cargando conexiones…</p>

    <div v-else-if="failed && store.loadError" class="conn-sidebar__error" role="alert">
      <p class="callout callout--error">
        <strong>No se pudieron cargar las conexiones.</strong>
        {{ describeError(store.loadError) }}
      </p>
      <button type="button" class="btn btn--secondary" data-action="retry" @click="store.load()">
        Reintentar
      </button>
    </div>

    <p v-else-if="empty" class="conn-sidebar__empty">
      Todavía no hay conexiones. Usa «Gestionar conexiones» para añadir una base de datos.
    </p>

    <ul v-else ref="list" class="conn-sidebar__list" aria-label="Conexiones guardadas">
      <li
        v-for="(profile, index) in store.profiles"
        :key="profile.id"
        class="conn-row"
        :data-profile-id="profile.id"
        :data-status="store.runtimeOf(profile.id).status"
        :data-selected="store.selectedId === profile.id ? 'true' : undefined"
        @focusin="store.select(profile.id)"
        @click="store.select(profile.id)"
      >
        <div class="conn-row__info">
          <span class="conn-row__name">{{ profile.name }}</span>
          <span class="conn-row__meta">
            {{ ENGINE_LABELS[profile.engine] }}
            <span v-if="profile.readOnly" class="conn-row__flag">Solo lectura</span>
          </span>
        </div>
        <div class="conn-row__foot">
          <ConnectionStatusBadge :status="store.runtimeOf(profile.id).status" />
          <button
            type="button"
            class="btn btn--ghost conn-row__toggle"
            data-action="toggle-connection"
            :tabindex="store.selectedId === profile.id ? 0 : -1"
            :aria-label="`${actionLabel(profile.id)} ${profile.name}`"
            :aria-disabled="
              store.runtimeOf(profile.id).status === 'connecting' ? 'true' : undefined
            "
            @click="toggle(profile.id)"
            @keydown="onKeydown($event, index)"
          >
            {{ actionLabel(profile.id) }}
          </button>
        </div>
        <p
          v-if="store.runtimeOf(profile.id).error"
          class="callout callout--error conn-row__error"
          role="alert"
        >
          {{ describeError(store.runtimeOf(profile.id).error!) }}
        </p>
      </li>
    </ul>

    <ModalDialog
      :open="manageOpen"
      :labelledby="manageTitleId"
      wide
      @close="manageOpen = false"
      @focus-lost="focusManageButton"
    >
      <div class="conn-manage">
        <header class="conn-manage__header">
          <h2 :id="manageTitleId" class="conn-manage__title">Gestionar conexiones</h2>
          <button
            type="button"
            class="btn btn--secondary"
            data-action="close-manage"
            @click="manageOpen = false"
          >
            Cerrar
          </button>
        </header>
        <ConnectionsView v-if="manageOpen" />
      </div>
    </ModalDialog>
  </section>
</template>

<style scoped>
.conn-sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
  min-height: 0;
  padding: var(--spacing-3);
  overflow-y: auto;
}

.conn-sidebar__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-2);
}

.conn-sidebar__title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-md);
}

.conn-sidebar__error {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.conn-sidebar__empty {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
}

.conn-sidebar__list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-1);
}

.conn-row {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-1);
  padding: var(--spacing-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.conn-row[data-selected='true'] {
  border-color: var(--action-primary);
  background: var(--surface-elevated);
}

.conn-row__info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.conn-row__name {
  font-weight: var(--font-weight-medium);
  overflow-wrap: anywhere;
}

.conn-row__meta {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.conn-row__flag {
  margin-inline-start: var(--spacing-1);
  padding: 0 var(--spacing-1);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
}

.conn-row__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-1) var(--spacing-2);
}

.conn-row__error {
  min-width: 0;
}

.conn-manage {
  display: flex;
  flex-direction: column;
}

.conn-manage__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-3);
  padding: var(--spacing-4) var(--spacing-6) 0;
}

.conn-manage__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}
</style>
