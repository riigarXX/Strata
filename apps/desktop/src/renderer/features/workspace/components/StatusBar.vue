<script setup lang="ts">
import { computed } from 'vue'
import { ENGINE_LABELS } from '../../connections'
import type { ActiveConnection } from '../composables/use-active-connection'
import { databaseName, splitTransactionLabel } from '../model/status-presentation'

const props = defineProps<{
  connection: ActiveConnection | null
  /** Duración de la última consulta ya formateada; `null` mientras no haya ninguna. */
  lastQueryDuration?: string | null
}>()

const transaction = computed(() => props.connection?.session.transaction ?? null)
const transactionLabel = computed(() =>
  transaction.value ? splitTransactionLabel(transaction.value) : null,
)
const database = computed(() => (props.connection ? databaseName(props.connection.profile) : ''))
</script>

<template>
  <footer class="statusbar" aria-label="Barra de estado">
    <div class="statusbar__segment" role="status" data-segment="connection">
      <span class="statusbar__label">Conexión:</span>
      <template v-if="connection">
        <span class="statusbar__value">{{ connection.profile.name }}</span>
        <span class="statusbar__value statusbar__value--muted">
          {{ ENGINE_LABELS[connection.session.engine] }}
        </span>
      </template>
      <span v-else class="statusbar__value">Sin conexión</span>
    </div>

    <div class="statusbar__segment" data-segment="database">
      <span class="statusbar__label">Base<span class="statusbar__aux"> de datos</span>:</span>
      <span v-if="connection" class="statusbar__value mono">{{ database }}</span>
      <template v-else>
        <span aria-hidden="true">—</span>
        <span class="visually-hidden">ninguna</span>
      </template>
    </div>

    <div class="statusbar__segment" data-segment="access">
      <span class="statusbar__label statusbar__label--aux">Acceso:</span>
      <span
        v-if="connection"
        class="statusbar__value"
        :data-read-only="connection.session.readOnly"
      >
        {{ connection.session.readOnly ? 'Solo lectura' : 'Lectura y escritura' }}
      </span>
      <template v-else>
        <span aria-hidden="true">—</span>
        <span class="visually-hidden">sin conexión</span>
      </template>
    </div>

    <div
      class="statusbar__segment statusbar__segment--end"
      role="status"
      data-segment="transaction"
    >
      <span class="statusbar__label statusbar__label--aux">Transacción:</span>
      <span
        v-if="transaction"
        class="statusbar__value statusbar__transaction"
        :data-state="transaction"
      >
        <span class="statusbar__glyph" aria-hidden="true"></span>
        {{ transactionLabel?.lead
        }}<span v-if="transactionLabel?.tail" class="statusbar__aux">{{
          transactionLabel.tail
        }}</span>
      </span>
      <template v-else>
        <span aria-hidden="true">—</span>
        <span class="visually-hidden">sin conexión</span>
      </template>
    </div>

    <div class="statusbar__segment" data-segment="last-query">
      <span class="statusbar__label"
        ><span class="statusbar__aux">Última </span
        ><span class="statusbar__word">consulta</span>:</span
      >
      <span v-if="lastQueryDuration" class="statusbar__value mono">{{ lastQueryDuration }}</span>
      <template v-else>
        <span aria-hidden="true">—</span>
        <span class="visually-hidden">sin datos</span>
      </template>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  container: statusbar / inline-size;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-1) var(--spacing-4);
  min-height: 28px;
  padding: 0 var(--spacing-3);
  border-top: 1px solid var(--sidebar-border);
  background: var(--sidebar-bg);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.statusbar__segment {
  display: inline-flex;
  align-items: baseline;
  gap: var(--spacing-1);
  min-width: 0;
  white-space: nowrap;
}

.statusbar__segment--end {
  margin-inline-start: auto;
}

.statusbar__value {
  color: var(--text-primary);
}

.statusbar__value--muted {
  color: var(--text-muted);
}

.statusbar__value[data-read-only='true'] {
  padding: 0 var(--spacing-1);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
}

.statusbar__transaction[data-state='active'] {
  color: var(--transaction-active);
}

.statusbar__transaction[data-state='aborted'] {
  color: var(--status-error);
}

.statusbar__glyph::before {
  content: var(--status-glyph-inactive);
  display: inline-block;
  width: 1em;
}

.statusbar__transaction[data-state='active'] .statusbar__glyph::before {
  content: var(--transaction-glyph-active);
}

.statusbar__transaction[data-state='aborted'] .statusbar__glyph::before {
  content: var(--status-glyph-error);
}

/* Anchos reducidos: se ocultan a la vista las etiquetas que el propio valor ya explica y se acortan las demás; el
   texto completo sigue en el árbol de accesibilidad. */
@container statusbar (max-width: 62rem) {
  .statusbar__label--aux {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

@container statusbar (max-width: 56rem) {
  .statusbar__aux {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .statusbar__word {
    text-transform: capitalize;
  }
}
</style>
