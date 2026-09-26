<script setup lang="ts">
import { computed, onBeforeUnmount, useId } from 'vue'
import { useAskStore } from '../../ai/stores/ask'
import { shortcutHint } from '../../command-palette/composables/use-shortcut-hints'
import { useHistoryPanelStore } from '../../history/stores/history-panel'
import { usePreferencesStore } from '../../preferences'
import { useSettingsStore } from '../../settings/stores/settings'
import { useWorkspaceStore, type SqlTab } from '../../workspace/stores/workspace'
import { registerExecutionPort } from '../composables/execution-port'
import { useExecutionController } from '../composables/use-execution-controller'
import type { ExecutionAction } from '../model/availability'
import { describeTransaction, splitExecutionStatus, transactionHint } from '../model/presentation'
import DestructiveConfirmDialog from './DestructiveConfirmDialog.vue'

const props = defineProps<{ tab: SqlTab }>()

const uid = useId()
const controller = useExecutionController(() => props.tab)
const settings = useSettingsStore()
const historyPanel = useHistoryPanelStore()
const ask = useAskStore()
const preferences = usePreferencesStore()
const workspace = useWorkspaceStore()
const historyShortcut = shortcutHint('history.open')
const askShortcut = shortcutHint('ask.open')
// Etiqueta corta a la vista (la barra no tiene sitio para más) y nombre completo para lectores; contiene la etiqueta visible.
const ASK_LABEL = 'Preguntar a la base con IA'

// Los atajos que se anuncian salen del registro de comandos, el mismo que atiende el teclado.
// `suffix` es la parte de la etiqueta que se omite en anchos reducidos y `iconOnly` marca los botones que en anchos
// estrechos quedan solo con su símbolo; el nombre accesible sigue completo.
const definitions: {
  action: ExecutionAction
  label: string
  suffix?: string
  iconOnly?: true
  variant: string
  cluster: 'run' | 'transaction'
  glyph?: 'run' | 'run-all' | 'cancel'
  commandId?: string
}[] = [
  {
    action: 'run',
    label: 'Ejecutar',
    variant: 'btn--primary',
    cluster: 'run',
    glyph: 'run',
    commandId: 'query.run',
  },
  {
    action: 'run-all',
    label: 'Ejecutar todo',
    variant: 'btn--secondary',
    cluster: 'run',
    glyph: 'run-all',
    iconOnly: true,
    commandId: 'query.runAll',
  },
  {
    action: 'cancel',
    label: 'Cancelar',
    variant: 'btn--secondary',
    cluster: 'run',
    glyph: 'cancel',
    iconOnly: true,
    commandId: 'query.cancel',
  },
  {
    action: 'begin',
    label: 'Iniciar',
    suffix: ' transacción',
    variant: 'btn--secondary',
    cluster: 'transaction',
  },
  { action: 'commit', label: 'Confirmar', variant: 'btn--secondary', cluster: 'transaction' },
  { action: 'rollback', label: 'Revertir', variant: 'btn--secondary', cluster: 'transaction' },
]
const actions = definitions.map(({ commandId, ...entry }) => ({
  ...entry,
  shortcut: commandId ? shortcutHint(commandId) : null,
}))

const transaction = computed(() => controller.connection.value?.session.transaction ?? null)
const abortedHint = computed(() => transactionHint(transaction.value))
const transactionIndicator = computed(() => describeTransaction(transaction.value))
const indicator = computed(() => controller.hint.value || controller.statusText.value)
const indicatorParts = computed(() => splitExecutionStatus(indicator.value))
const running = computed(() => controller.state.value.status !== 'idle')
const indicatorState = computed(() => {
  const { status, transactionBusy, outcome } = controller.state.value
  if (status !== 'idle' || transactionBusy) return 'running'
  if (controller.hint.value) return 'blocked'
  if (!controller.connection.value) return 'offline'
  return outcome ?? 'idle'
})

// Ejecutar y Ejecutar todo siguen habilitados con la transacción abortada (admiten un ROLLBACK escrito a mano):
// su descripción accesible es el aviso fijo de la barra, que explica qué se puede ejecutar.
function describedBy(action: ExecutionAction): string | undefined {
  if (!controller.availability.value[action].enabled) return `${uid}-${action}-reason`
  return abortedHint.value && (action === 'run' || action === 'run-all')
    ? `${uid}-aborted-hint`
    : undefined
}

/** Nombre completo, atajo y, si la acción no está disponible, su motivo: es el tooltip de cada botón. */
function tooltip(
  action: ExecutionAction,
  label: string,
  suffix: string | undefined,
  iconOnly: true | undefined,
  shortcut: { display: string } | null,
): string | undefined {
  const { reason } = controller.availability.value[action]
  if (!reason && !suffix && !iconOnly && !shortcut) return undefined
  const name = `${label}${suffix ?? ''}${shortcut ? ` (${shortcut.display})` : ''}`
  return reason ? `${name}: ${reason}` : name
}

// Con el historial desactivado en ajustes no hay nada que excluir: la casilla se muestra apagada y sin efecto.
const historyEnabled = computed(() => preferences.historyEnabled)
const saveToHistory = computed(() => historyEnabled.value && props.tab.saveToHistory)

function onSaveToHistoryClick(event: MouseEvent): void {
  if (!historyEnabled.value) event.preventDefault()
}

function onSaveToHistoryChange(event: Event): void {
  if (!historyEnabled.value) return
  workspace.setSaveToHistory(props.tab.id, (event.target as HTMLInputElement).checked)
}

function trigger(action: ExecutionAction): void {
  switch (action) {
    case 'run':
      void controller.run()
      break
    case 'run-all':
      void controller.runAll()
      break
    case 'cancel':
      void controller.cancel()
      break
    case 'begin':
    case 'commit':
    case 'rollback':
      void controller.transaction(action)
      break
  }
}

// La barra se ofrece al registro de comandos: los atajos y la paleta ejecutan y consultan lo mismo que sus botones.
const unregisterPort = registerExecutionPort({
  availability: () => controller.availability.value,
  run: () => controller.run(),
  runAll: () => controller.runAll(),
  cancel: () => controller.cancel(),
  transaction: (action) => controller.transaction(action),
  canExcludeFromHistory: () => controller.canExcludeFromHistory.value,
  excludeFromHistory: () => controller.excludeFromHistory(),
  showHint: (message) => {
    controller.hint.value = message
  },
})
onBeforeUnmount(unregisterPort)
</script>

<template>
  <div
    class="exec-toolbar"
    data-region="execution-toolbar"
    :data-transaction="transaction ?? undefined"
  >
    <div class="exec-toolbar__actions" role="group" aria-label="Acciones de consulta">
      <button
        v-for="{ action, label, suffix, iconOnly, variant, cluster, glyph, shortcut } in actions"
        :key="action"
        type="button"
        class="btn exec-toolbar__btn"
        :class="variant"
        :data-action="action"
        :data-cluster="cluster"
        :aria-disabled="controller.availability.value[action].enabled ? undefined : 'true'"
        :aria-describedby="describedBy(action)"
        :aria-keyshortcuts="shortcut?.aria"
        :title="tooltip(action, label, suffix, iconOnly, shortcut)"
        @click="trigger(action)"
      >
        <span
          v-if="glyph"
          class="exec-toolbar__glyph"
          :data-glyph="glyph"
          aria-hidden="true"
        ></span>
        <span class="exec-toolbar__label"
          >{{ label }}<span v-if="suffix" class="exec-toolbar__more">{{ suffix }}</span></span
        >
      </button>
      <template v-for="{ action } in actions" :key="`reason-${action}`">
        <span
          v-if="controller.availability.value[action].reason"
          :id="`${uid}-${action}-reason`"
          class="visually-hidden"
        >
          {{ controller.availability.value[action].reason }}
        </span>
      </template>
      <button
        type="button"
        class="btn btn--ghost exec-toolbar__btn exec-toolbar__tool"
        data-action="ask"
        :aria-label="ASK_LABEL"
        :aria-keyshortcuts="askShortcut?.aria"
        :title="askShortcut ? `${ASK_LABEL} (${askShortcut.display})` : ASK_LABEL"
        @click="ask.open()"
      >
        <span class="exec-toolbar__glyph" data-glyph="ask" aria-hidden="true"></span>
        <span class="exec-toolbar__label">IA</span>
      </button>
      <button
        type="button"
        class="btn btn--ghost exec-toolbar__btn exec-toolbar__tool"
        data-action="execution-settings"
        title="Ajustes de ejecución"
        @click="settings.open('execution')"
      >
        <span class="exec-toolbar__glyph" data-glyph="settings" aria-hidden="true"></span>
        <span class="exec-toolbar__label"
          >Ajustes<span class="exec-toolbar__more"> de ejecución</span></span
        >
      </button>
      <button
        type="button"
        class="btn btn--ghost exec-toolbar__btn exec-toolbar__tool"
        data-action="open-history"
        :data-shortcut="historyShortcut?.display"
        :aria-keyshortcuts="historyShortcut?.aria"
        :title="historyShortcut ? `Historial (${historyShortcut.display})` : 'Historial'"
        @click="historyPanel.open()"
      >
        <span class="exec-toolbar__glyph" data-glyph="history" aria-hidden="true"></span>
        <span class="exec-toolbar__label">Historial</span>
      </button>
    </div>

    <span
      v-if="transactionIndicator"
      class="exec-toolbar__tx"
      data-part="transaction-state"
      :data-state="transactionIndicator.state"
      :title="transactionIndicator.lead + transactionIndicator.detail"
    >
      <span class="exec-toolbar__tx-glyph" aria-hidden="true"></span
      ><span class="exec-toolbar__tx-lead">{{ transactionIndicator.lead }}</span
      >{{ transactionIndicator.detail }}
    </span>

    <p
      class="exec-toolbar__status"
      role="status"
      aria-live="polite"
      data-part="execution-indicator"
      :data-running="running ? 'true' : undefined"
      :data-state="indicatorState"
      :title="indicator"
    >
      <span class="exec-toolbar__status-glyph" aria-hidden="true"></span
      ><span v-if="indicatorParts.lead" class="exec-toolbar__status-lead">{{
        indicatorParts.lead
      }}</span
      >{{ indicatorParts.rest }}
    </p>

    <div class="exec-toolbar__history">
      <label
        class="exec-toolbar__history-optout"
        data-part="save-to-history"
        :data-disabled="historyEnabled ? undefined : 'true'"
      >
        <input
          type="checkbox"
          name="saveToHistory"
          :checked="saveToHistory"
          :aria-disabled="historyEnabled ? undefined : 'true'"
          :aria-describedby="historyEnabled ? undefined : `${uid}-history-reason`"
          @click="onSaveToHistoryClick"
          @change="onSaveToHistoryChange"
        />
        <span
          ><span class="exec-toolbar__lead">Guardar en el </span
          ><span class="exec-toolbar__optout-word">historial</span></span
        >
      </label>
      <button
        v-if="controller.canExcludeFromHistory.value"
        type="button"
        class="btn btn--ghost exec-toolbar__exclude"
        data-action="exclude-from-history"
        title="Quitar del historial la última consulta ejecutada en esta pestaña"
        @click="controller.excludeFromHistory()"
      >
        Quitar<span class="exec-toolbar__tail"> del historial</span>
      </button>
      <span
        v-else-if="controller.recordedState.value === 'removed'"
        class="exec-toolbar__excluded"
        data-part="history-excluded"
      >
        Quitada<span class="exec-toolbar__tail"> del historial</span>
      </span>
      <span
        v-if="!historyEnabled"
        :id="`${uid}-history-reason`"
        class="exec-toolbar__reason"
        title="El historial está desactivado en los ajustes."
        ><span class="visually-hidden">El historial está </span>desactivado<span
          class="exec-toolbar__more"
        >
          en los ajustes.</span
        ></span
      >
    </div>

    <p
      v-if="abortedHint"
      :id="`${uid}-aborted-hint`"
      class="exec-toolbar__hint callout callout--warning"
      role="status"
      data-hint="revert-first"
    >
      {{ abortedHint }}
    </p>

    <DestructiveConfirmDialog
      :open="controller.pending.value !== null"
      :statements="controller.pending.value?.statements ?? []"
      @confirm="controller.confirmPending()"
      @close="controller.dismissPending()"
      @focus-lost="controller.dismissPending()"
    />
  </div>
</template>

<style scoped>
/* Contenedor de consulta: la barra se compacta según su propio ancho (el de la zona central, que cambia
   con la barra lateral), no según el de la ventana. */
.exec-toolbar {
  container: exec-toolbar / inline-size;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-1) var(--spacing-2);
  padding: var(--spacing-2) var(--spacing-3);
  border-bottom: 1px solid var(--sidebar-border);
  background: var(--tab-bg-active);
}

.exec-toolbar__actions {
  display: flex;
  flex: 1 1 100%;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-1) var(--spacing-2);
  min-width: 0;
}

.exec-toolbar__btn {
  flex: none;
  white-space: nowrap;
}

.exec-toolbar__btn:focus-visible {
  position: relative;
  z-index: 1;
}

.exec-toolbar__btn[aria-disabled='true'] {
  border-style: dashed;
  cursor: not-allowed;
}

.exec-toolbar__btn[data-action='cancel']:not([aria-disabled='true']) {
  border-color: var(--status-error);
  color: var(--status-error);
}

/* Las tres acciones de transacción forman un solo control segmentado. */
.exec-toolbar__btn[data-cluster='transaction'] {
  border-radius: 0;
}

.exec-toolbar__btn[data-action='begin'] {
  margin-inline-start: var(--spacing-2);
  border-start-start-radius: var(--radius-sm);
  border-end-start-radius: var(--radius-sm);
}

.exec-toolbar__btn[data-action='rollback'] {
  border-start-end-radius: var(--radius-sm);
  border-end-end-radius: var(--radius-sm);
}

.exec-toolbar__btn[data-cluster='transaction'] + .exec-toolbar__btn[data-cluster='transaction'] {
  margin-inline-start: calc(-1 * var(--spacing-2) - 1px);
}

/* El control segmentado toma el color del chip de transacción: el borde del grupo es el vínculo, no solo el texto. */
.exec-toolbar[data-transaction='active'] .exec-toolbar__btn[data-cluster='transaction'] {
  border-color: var(--transaction-active);
}

.exec-toolbar[data-transaction='aborted'] .exec-toolbar__btn[data-cluster='transaction'] {
  border-color: var(--status-error);
}

.exec-toolbar[data-transaction='aborted'] .exec-toolbar__btn[data-action='rollback'] {
  box-shadow: inset 0 0 0 1px var(--status-error);
  font-weight: var(--font-weight-semibold);
}

/* Estado de la transacción de la sesión, en la segunda línea (la primera no tiene hueco a 1280 px). Glifo y texto
   siempre; el color solo refuerza. */
.exec-toolbar__tx {
  display: inline-flex;
  flex: none;
  align-items: baseline;
  gap: var(--spacing-1);
  order: 1;
  padding: 0 var(--spacing-2);
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
  white-space: nowrap;
}

.exec-toolbar__tx[data-state='active'] {
  border-color: var(--transaction-active);
  color: var(--transaction-active);
  font-weight: var(--font-weight-semibold);
}

.exec-toolbar__tx[data-state='aborted'] {
  border-color: var(--status-error);
  color: var(--status-error);
  font-weight: var(--font-weight-semibold);
}

.exec-toolbar__tx-glyph::before {
  content: var(--status-glyph-inactive);
  display: inline-block;
  min-width: 1em;
  text-align: center;
}

.exec-toolbar__tx[data-state='active'] .exec-toolbar__tx-glyph::before {
  content: var(--transaction-glyph-active);
}

.exec-toolbar__tx[data-state='aborted'] .exec-toolbar__tx-glyph::before {
  content: var(--status-glyph-error);
}

.exec-toolbar__tool[data-action='ask'] {
  margin-inline-start: auto;
}

.exec-toolbar__tool {
  gap: var(--spacing-1);
  min-height: 32px;
  color: var(--text-muted);
}

.exec-toolbar__tool:hover {
  color: var(--text-primary);
}

.exec-toolbar__glyph::before {
  display: inline-block;
  min-width: 1em;
  font-size: var(--font-size-xs);
  text-align: center;
}

.exec-toolbar__glyph[data-glyph='run']::before {
  content: var(--toolbar-glyph-run);
}

.exec-toolbar__glyph[data-glyph='run-all']::before {
  content: var(--toolbar-glyph-run-all);
  letter-spacing: -0.2em;
}

.exec-toolbar__glyph[data-glyph='cancel']::before {
  content: var(--toolbar-glyph-cancel);
}

.exec-toolbar__glyph[data-glyph='settings']::before {
  content: var(--toolbar-glyph-settings);
  font-size: var(--font-size-base);
}

.exec-toolbar__glyph[data-glyph='history']::before {
  content: var(--toolbar-glyph-history);
  font-size: var(--font-size-base);
}

.exec-toolbar__glyph[data-glyph='ask']::before {
  content: var(--toolbar-glyph-ask);
  font-size: var(--font-size-base);
}

/* El atajo se muestra como texto generado con alternativa vacía: lo anuncia aria-keyshortcuts. */
.exec-toolbar__btn[data-shortcut]::after {
  content: attr(data-shortcut) / '';
  padding: 0 var(--spacing-1);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.exec-toolbar__status {
  flex: 1 1 12rem;
  order: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.exec-toolbar__status-glyph {
  display: inline-block;
  min-width: 1em;
  margin-inline-end: var(--spacing-2);
  text-align: center;
}

.exec-toolbar__status[data-state='idle'] .exec-toolbar__status-glyph {
  display: none;
}

.exec-toolbar__status[data-state='running'] {
  color: var(--query-running);
}

.exec-toolbar__status[data-state='done'] .exec-toolbar__status-glyph {
  color: var(--status-success);
}

.exec-toolbar__status[data-state='error'] {
  color: var(--status-error);
}

.exec-toolbar__status[data-state='cancelled'] .exec-toolbar__status-glyph,
.exec-toolbar__status[data-state='blocked'] .exec-toolbar__status-glyph {
  color: var(--status-warning);
}

.exec-toolbar__status[data-state='running'] .exec-toolbar__status-glyph::before {
  content: var(--query-glyph-running);
  display: inline-block;
  animation: spin var(--motion-duration-spin) var(--motion-easing-linear)
    var(--motion-iteration-loop);
}

.exec-toolbar__status[data-state='done'] .exec-toolbar__status-glyph::before {
  content: var(--status-glyph-success);
}

.exec-toolbar__status[data-state='error'] .exec-toolbar__status-glyph::before {
  content: var(--status-glyph-error);
}

.exec-toolbar__status[data-state='cancelled'] .exec-toolbar__status-glyph::before,
.exec-toolbar__status[data-state='blocked'] .exec-toolbar__status-glyph::before {
  content: var(--status-glyph-warning);
}

.exec-toolbar__status[data-state='offline'] .exec-toolbar__status-glyph::before {
  content: var(--status-glyph-inactive);
}

.exec-toolbar__history {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--spacing-3);
  order: 2;
}

/* Objetivos de 24 px de alto (WCAG 2.5.8): el margen negativo se los da a la casilla y a «Quitar» sin agrandar la fila. */
.exec-toolbar__history-optout {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-2);
  min-height: 24px;
  margin-block: -2px;
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  cursor: pointer;
}

.exec-toolbar__history-optout input {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--action-primary);
  cursor: inherit;
}

.exec-toolbar__history-optout[data-disabled='true'] {
  color: var(--text-muted);
  cursor: not-allowed;
}

.exec-toolbar__history-optout[data-disabled='true'] input {
  accent-color: var(--text-muted);
}

.exec-toolbar__exclude {
  display: inline-block;
  flex: none;
  min-height: 24px;
  margin-block: -2px;
  padding-inline: var(--spacing-2);
  border-color: var(--border-default);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-regular);
  line-height: var(--font-line-height-sm);
  white-space: nowrap;
}

/* Sin botón: la confirmación visible de que la consulta ya no está en el historial. */
.exec-toolbar__excluded {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  white-space: nowrap;
}

.exec-toolbar__excluded::before {
  content: var(--status-glyph-success);
  margin-inline-end: var(--spacing-1);
  color: var(--status-success);
}

.exec-toolbar__reason {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
  white-space: nowrap;
}

.exec-toolbar__reason::before {
  content: var(--status-glyph-warning);
  margin-inline-end: var(--spacing-1);
  color: var(--status-warning);
}

.exec-toolbar__hint {
  flex-basis: 100%;
  order: 4;
}

@container exec-toolbar (max-width: 63rem) {
  .exec-toolbar__more {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .exec-toolbar__btn[data-shortcut]::after {
    content: none;
  }
}

@container exec-toolbar (max-width: 52rem) {
  .exec-toolbar__tool .exec-toolbar__label,
  .exec-toolbar__tail,
  .exec-toolbar__lead {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .exec-toolbar__btn {
    padding-inline: var(--spacing-2);
    gap: var(--spacing-1);
  }

  /* Solo el glifo de «IA»: con el margen justo, el botón se queda en el mínimo de 24 px de objetivo para que la barra no pase a tres líneas. */
  .exec-toolbar__btn[data-action='ask'] {
    min-width: 24px;
    padding-inline: var(--spacing-1);
  }

  .exec-toolbar__optout-word {
    text-transform: capitalize;
  }
}

/* Anchos estrechos: la primera línea conserva todas las acciones (Ejecutar todo y Cancelar quedan en su símbolo,
   con el nombre completo para lectores y tooltip) y la segunda, el chip, el estado y el historial. */
@container exec-toolbar (max-width: 39.5rem) {
  .exec-toolbar__tx:not([data-state='none']) .exec-toolbar__tx-lead,
  .exec-toolbar__status-lead,
  .exec-toolbar__btn[data-action='run-all'] .exec-toolbar__label,
  .exec-toolbar__btn[data-action='cancel'] .exec-toolbar__label {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .exec-toolbar__actions {
    column-gap: var(--spacing-1);
  }

  .exec-toolbar__btn[data-action='run-all'],
  .exec-toolbar__btn[data-action='cancel'] {
    min-width: 32px;
  }

  .exec-toolbar__btn[data-action='begin'] {
    margin-inline-start: var(--spacing-1);
  }

  .exec-toolbar__status {
    flex-basis: 6rem;
  }

  .exec-toolbar__tx {
    padding-inline: var(--spacing-1);
  }

  .exec-toolbar__status-glyph {
    margin-inline-end: var(--spacing-1);
  }

  .exec-toolbar__history {
    gap: var(--spacing-1);
  }

  .exec-toolbar__history-optout,
  .exec-toolbar__exclude,
  .exec-toolbar__excluded {
    font-size: var(--font-size-xs);
    line-height: var(--font-line-height-xs);
  }

  .exec-toolbar__hint {
    padding-block: var(--spacing-1);
    padding-inline: var(--spacing-2);
    padding-inline-start: calc(var(--spacing-2) + 1.5em);
    font-size: var(--font-size-xs);
    line-height: var(--font-line-height-xs);
  }
}
</style>
