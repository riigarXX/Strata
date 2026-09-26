<script setup lang="ts">
import type { ConnectionProfile } from '@strata/contracts'
import { computed, nextTick, onMounted, ref, useId } from 'vue'
import { describeError } from '../model/presentation'
import { useConnectionsStore } from '../stores/connections'
import ConfirmDeleteDialog from './ConfirmDeleteDialog.vue'
import ConnectionFormDialog from './ConnectionFormDialog.vue'
import ConnectionListItem from './ConnectionListItem.vue'

type Direction = 'previous' | 'next' | 'first' | 'last'

const store = useConnectionsStore()
const uid = useId()
const titleId = `${uid}-title`
const hintId = `${uid}-hint`

const newButton = ref<HTMLButtonElement | null>(null)
const rows = new Map<string, { focus(): void }>()

const formOpen = ref(false)
const formProfile = ref<ConnectionProfile | null>(null)

const deleteTarget = ref<ConnectionProfile | null>(null)
const deleteBusy = ref(false)
const deleteError = ref('')

const loading = computed(() => store.loadStatus === 'loading' || store.loadStatus === 'idle')
const failed = computed(() => store.loadStatus === 'error')
const empty = computed(() => store.loadStatus === 'ready' && store.profiles.length === 0)

// La sidebar ya carga los perfiles: al abrirse esta vista no se repite la petición ni se parpadea el estado de carga.
onMounted(() => {
  if (store.loadStatus === 'idle') void store.load()
})

function setRow(profileId: string, element: unknown): void {
  if (element && typeof (element as { focus?: unknown }).focus === 'function') {
    rows.set(profileId, element as { focus(): void })
  } else {
    rows.delete(profileId)
  }
}

function focusSelectedRowOrNew(): void {
  void nextTick(() => {
    const selected = store.selectedId === null ? undefined : rows.get(store.selectedId)
    if (selected) selected.focus()
    else newButton.value?.focus()
  })
}

function openCreate(): void {
  formProfile.value = null
  formOpen.value = true
}

function openEdit(profile: ConnectionProfile): void {
  formProfile.value = profile
  formOpen.value = true
}

function onSaved(profile: ConnectionProfile, passwordSent: boolean): void {
  store.applySaved(profile, passwordSent)
  formOpen.value = false
}

function requestDelete(profile: ConnectionProfile): void {
  deleteError.value = ''
  deleteBusy.value = false
  deleteTarget.value = profile
}

function closeDelete(): void {
  deleteTarget.value = null
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  deleteBusy.value = true
  deleteError.value = ''
  const failure = await store.remove(target.id)
  deleteBusy.value = false
  if (failure) deleteError.value = describeError(failure)
  else deleteTarget.value = null
}

function moveSelection(index: number, direction: Direction): void {
  const last = store.profiles.length - 1
  const targetIndex = {
    previous: Math.max(index - 1, 0),
    next: Math.min(index + 1, last),
    first: 0,
    last,
  }[direction]
  const target = store.profiles[targetIndex]
  if (target) rows.get(target.id)?.focus()
}
</script>

<template>
  <section class="connections" :aria-labelledby="titleId" :aria-busy="loading ? 'true' : undefined">
    <header class="connections__header">
      <h2 :id="titleId" class="connections__title">Conexiones</h2>
      <button
        ref="newButton"
        type="button"
        class="btn btn--primary connections__new"
        data-action="new"
        @click="openCreate"
      >
        Nueva conexión
      </button>
    </header>

    <p class="connections__notice" role="status" aria-live="polite" aria-atomic="true">
      {{ store.notice }}
    </p>

    <p v-if="loading" class="callout callout--running connections__loading" role="status">
      Cargando conexiones…
    </p>

    <div v-else-if="failed && store.loadError" class="connections__error" role="alert">
      <p class="callout callout--error connections__error-text">
        <strong>No se pudieron cargar las conexiones.</strong>
        {{ describeError(store.loadError) }}
      </p>
      <button
        type="button"
        class="btn btn--secondary connections__retry"
        data-action="retry"
        @click="store.load()"
      >
        Reintentar
      </button>
    </div>

    <div v-else-if="empty" class="connections__empty">
      <h3 class="connections__empty-title">Todavía no hay conexiones</h3>
      <p class="connections__empty-text">
        Usa «Nueva conexión» para añadir una base de datos PostgreSQL o SQLite.
      </p>
    </div>

    <template v-else>
      <ul class="connections__list" aria-label="Conexiones guardadas" :aria-describedby="hintId">
        <ConnectionListItem
          v-for="(profile, index) in store.profiles"
          :key="profile.id"
          :ref="(element) => setRow(profile.id, element)"
          :profile="profile"
          :runtime="store.runtimeOf(profile.id)"
          :test="store.tests[profile.id]"
          :selected="store.selectedId === profile.id"
          @select="store.select(profile.id)"
          @connect="store.connect(profile.id)"
          @disconnect="store.disconnect(profile.id)"
          @reconnect="store.reconnect(profile.id)"
          @test="store.testProfile(profile.id)"
          @edit="openEdit(profile)"
          @delete="requestDelete(profile)"
          @move="(direction) => moveSelection(index, direction)"
        />
      </ul>
      <p :id="hintId" class="connections__hint">
        Con una conexión enfocada: flechas arriba y abajo para moverte, Inicio y Fin para ir al
        principio o al final, Intro para conectar, E para editar y Supr para eliminar.
      </p>
    </template>

    <ConnectionFormDialog
      :open="formOpen"
      :profile="formProfile"
      @close="formOpen = false"
      @saved="onSaved"
      @focus-lost="focusSelectedRowOrNew"
    />

    <ConfirmDeleteDialog
      :open="deleteTarget !== null"
      :profile="deleteTarget"
      :busy="deleteBusy"
      :error="deleteError"
      @confirm="confirmDelete"
      @close="closeDelete"
      @focus-lost="focusSelectedRowOrNew"
    />
  </section>
</template>

<style scoped>
.connections {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  width: 100%;
  max-width: 56rem;
  margin: 0 auto;
  padding: var(--spacing-6);
}

.connections__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-3);
}

.connections__title {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-xl);
}

.connections__notice:not(:empty) {
  padding: var(--spacing-2) var(--spacing-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-card);
  box-shadow: inset 3px 0 0 var(--action-primary);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  overflow-wrap: anywhere;
}

.connections__error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-3);
}

.connections__error-text {
  flex: 1 1 20rem;
}

.connections__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-2);
  padding: var(--spacing-12) var(--spacing-6);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  text-align: center;
}

.connections__empty-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}

.connections__empty-text {
  max-width: 36rem;
  color: var(--text-muted);
}

.connections__list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.connections__hint {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}
</style>
