<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { ENGINE_LABELS } from '../../connections'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { registerSchemaPort } from '../composables/schema-port'
import { useSchemaBrowser } from '../composables/use-schema-browser'
import SchemaTree from './SchemaTree.vue'

const uid = useId()
const titleId = `${uid}-title`
const filterId = `${uid}-filter`
const hintId = `${uid}-hint`

const workspace = useWorkspaceStore()
const browser = useSchemaBrowser()
const { tree, connection } = browser

const filterInput = ref<HTMLInputElement | null>(null)
const treeRef = ref<InstanceType<typeof SchemaTree> | null>(null)

const treeLabel = computed(() =>
  connection.value ? `Esquema de ${connection.value.profile.name}` : 'Esquema',
)
const noResults = computed(
  () => browser.filtering.value && tree.value.status === 'ready' && tree.value.items.length === 0,
)
const emptyMessage = computed(() =>
  workspace.activeTab
    ? 'Esta pestaña no está conectada. Conecta un perfil en «Conexiones» para explorar su esquema.'
    : 'No hay pestañas abiertas. Abre una con Cmd/Ctrl+T y conéctala a una base de datos para explorar su esquema.',
)

// El explorador se ofrece a los comandos `\schemas`, `\tables` y `\describe`: filtra, expande y enfoca.
const unregisterPort = registerSchemaPort({
  async reveal(target) {
    const revealed = await browser.reveal(target)
    await nextTick()
    treeRef.value?.focusActive()
    return revealed
  },
})
onBeforeUnmount(unregisterPort)

function focusFilter(): void {
  filterInput.value?.focus()
  filterInput.value?.select()
}

// Escape limpia el filtro y, con el filtro ya vacío, devuelve el foco al árbol; Flecha abajo/Intro entran al árbol.
function onFilterKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (browser.filter.value !== '') browser.filter.value = ''
    else treeRef.value?.focusActive()
  } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
    event.preventDefault()
    treeRef.value?.focusActive()
  }
}
</script>

<template>
  <div class="schema-browser" :aria-labelledby="titleId">
    <header class="schema-browser__header">
      <div class="schema-browser__heading">
        <h2 :id="titleId" class="schema-browser__title">Esquema</h2>
        <p v-if="connection" class="schema-browser__source" data-part="source">
          {{ connection.profile.name }} · {{ ENGINE_LABELS[connection.session.engine] }}
        </p>
      </div>
      <div class="schema-browser__actions">
        <button
          type="button"
          class="btn btn--ghost"
          data-action="refresh"
          aria-keyshortcuts="F5"
          :disabled="!connection"
          @click="browser.refresh()"
        >
          Actualizar
        </button>
        <button
          type="button"
          class="btn btn--ghost"
          data-action="insert"
          aria-keyshortcuts="Shift+Enter"
          :disabled="!browser.canInsert.value"
          @click="browser.insert()"
        >
          Insertar en el editor
        </button>
      </div>
    </header>

    <p
      v-if="!connection"
      class="schema-browser__empty"
      role="status"
      aria-live="polite"
      data-state="no-session"
    >
      {{ emptyMessage }}
    </p>

    <template v-else>
      <div class="schema-browser__filter">
        <label :for="filterId" class="visually-hidden">Filtrar tablas y vistas</label>
        <input
          :id="filterId"
          ref="filterInput"
          v-model="browser.filter.value"
          type="search"
          name="schema-filter"
          class="schema-browser__input"
          placeholder="Filtrar tablas y vistas"
          autocomplete="off"
          spellcheck="false"
          :aria-describedby="hintId"
          @keydown="onFilterKeydown"
        />
      </div>

      <p class="visually-hidden" role="status" aria-live="polite" data-part="matches">
        {{ browser.matchesAnnouncement.value }}
      </p>
      <p class="visually-hidden" role="status" aria-live="polite" data-part="notice">
        {{ browser.notice.value }}
      </p>

      <p
        v-if="tree.status === 'loading' || tree.status === 'idle'"
        class="callout callout--running"
        role="status"
        data-state="loading"
      >
        Cargando esquemas…
      </p>

      <div v-else-if="tree.status === 'error' && tree.error" data-state="error" role="alert">
        <p class="callout callout--error">
          <strong>No se pudieron cargar los esquemas.</strong> {{ tree.error.message }}
        </p>
        <button
          type="button"
          class="btn btn--secondary"
          data-action="retry-schemas"
          @click="browser.retrySchemas()"
        >
          Reintentar
        </button>
      </div>

      <p
        v-else-if="tree.status === 'empty'"
        class="schema-browser__empty"
        role="status"
        data-state="empty"
      >
        Esta conexión no tiene esquemas visibles.
      </p>

      <p v-else-if="noResults" class="schema-browser__empty" role="status" data-state="no-results">
        Ninguna tabla ni vista coincide con «{{ browser.filter.value.trim() }}».
      </p>

      <SchemaTree
        v-else
        ref="treeRef"
        :roots="tree.roots"
        :items="tree.items"
        :focus-key="browser.focusKey.value"
        :active-key="browser.activeKey.value"
        :label="treeLabel"
        :described-by="hintId"
        @focus-node="browser.activeKey.value = $event"
        @toggle="browser.toggle"
        @activate="browser.activate"
        @insert="browser.insert"
        @retry="browser.retry"
        @refresh="browser.refresh()"
        @focus-filter="focusFilter"
      />

      <p :id="hintId" class="visually-hidden" data-part="hint">
        Flechas para moverte por el árbol; Derecha e Izquierda para expandir y colapsar; Inicio y
        Fin para ir al primero y al último; escribe para saltar a un nombre. Intro expande o inserta
        la columna; Mayús e Intro inserta el nombre en el editor; F5 actualiza; Cmd o Ctrl más F
        filtra.
      </p>
    </template>
  </div>
</template>

<style scoped>
.schema-browser {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--spacing-2);
  min-height: 0;
}

.schema-browser__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-1) var(--spacing-2);
}

.schema-browser__title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-md);
}

.schema-browser__source {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
  overflow-wrap: anywhere;
}

.schema-browser__heading {
  min-width: 0;
}

/* El margen negativo alinea el texto de los botones con el del título, no su caja. */
.schema-browser__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--spacing-1);
  margin-inline-start: calc(-1 * var(--spacing-2));
}

.schema-browser__actions .btn {
  padding: 0 var(--spacing-2);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.schema-browser__actions .btn:disabled {
  color: var(--text-muted);
  cursor: default;
}

.schema-browser__input {
  width: 100%;
  min-height: 28px;
  padding: 0 var(--spacing-2);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background-color: var(--input-bg);
  color: var(--input-fg);
  transition: border-color var(--motion-duration-fast) var(--motion-easing-out);
}

.schema-browser__input:focus-visible {
  border-color: var(--input-border-focus);
  outline-offset: 0;
}

.schema-browser__empty {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
}
</style>
