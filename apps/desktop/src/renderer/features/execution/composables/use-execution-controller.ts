import type { AnalyzedStatement } from '@strata/db-core'
import { computed, nextTick, ref, watch } from 'vue'
import { usePaletteStore } from '../../command-palette/stores/palette'
import { describeError } from '../../connections/model/presentation'
import { describeExclusion } from '../../history/model/presentation'
import { useRecordedEntriesStore } from '../../history/stores/recorded-entries'
import { usePreferencesStore } from '../../preferences'
import { useQueryEditor, type ExecutionScope } from '../../query-editor'
import { useLiveConnections } from '../../workspace/composables/use-active-connection'
import type { SqlTab } from '../../workspace/stores/workspace'
import { canRunWhileAborted } from '../model/aborted-transaction'
import { availabilityOf, type ExecutionAction } from '../model/availability'
import { findDestructiveStatements } from '../model/destructive'
import {
  ABORTED_RUN_REJECTION,
  formatDuration,
  SCOPE_LABELS,
  TRANSACTION_ACTION_LABELS,
  type TransactionAction,
} from '../model/presentation'
import { useExecutionStore } from '../stores/execution'

export interface PendingRun {
  sessionId: string
  sql: string
  scope: ExecutionScope
  saveToHistory: boolean
  statements: AnalyzedStatement[]
}

/**
 * Une el editor, las conexiones, las preferencias y el store de ejecución para la pestaña dada: decide qué
 * texto se ejecuta, si hace falta confirmar (ADR 0004) y qué acciones están disponibles y por qué no.
 */
export function useExecutionController(tab: () => SqlTab) {
  const execution = useExecutionStore()
  const preferences = usePreferencesStore()
  const live = useLiveConnections()
  const editor = useQueryEditor()
  const recorded = useRecordedEntriesStore()
  const palette = usePaletteStore()

  const connection = computed(
    () => live.value.find((entry) => entry.session.sessionId === tab().sessionId) ?? null,
  )
  const state = computed(() => execution.stateOf(tab().id))
  const availability = computed(() => {
    const sessionId = connection.value?.session.sessionId
    return availabilityOf({
      transaction: connection.value?.session.transaction ?? null,
      status: state.value.status,
      sessionBusyElsewhere: sessionId ? execution.isSessionBusy(sessionId, tab().id) : false,
      transactionBusy: state.value.transactionBusy !== null,
    })
  })

  // Entrada que dejó la última ejecución de la pestaña: solo se puede quitar con la pestaña en reposo y mientras exista.
  const recordedState = computed(() => recorded.stateOf(state.value.lastRequestId))
  const canExcludeFromHistory = computed(
    () =>
      state.value.status === 'idle' &&
      recordedState.value === 'recorded' &&
      !recorded.isExcluding(state.value.lastRequestId),
  )

  // Aviso de por qué un atajo no hizo nada; se vacía en cuanto cambia el estado de la ejecución.
  const hint = ref('')
  const pending = ref<PendingRun | null>(null)

  watch(
    () => [state.value.status, state.value.transactionBusy],
    () => {
      hint.value = ''
    },
  )

  const statusText = computed(() => {
    const { status, scope, outcome, durationMs, transactionBusy } = state.value
    if (status === 'running') return `Ejecutando ${scope ? SCOPE_LABELS[scope] : 'la consulta'}…`
    if (status === 'cancelling') return 'Cancelando la ejecución…'
    if (transactionBusy) return TRANSACTION_ACTION_LABELS[transactionBusy].doing
    if (!connection.value) return 'Sin conexión: no se puede ejecutar.'
    const took = durationMs === null ? '' : ` (${formatDuration(durationMs)})`
    if (outcome === 'done') return `Última ejecución completada${took}.`
    if (outcome === 'error') return `La última ejecución terminó con error${took}.`
    if (outcome === 'cancelled') return `La última ejecución se canceló${took}.`
    return 'Listo para ejecutar.'
  })

  function blocked(action: ExecutionAction, verb: string): boolean {
    const { enabled, reason } = availability.value[action]
    if (!enabled) hint.value = `No se puede ${verb}: ${reason}`
    return !enabled
  }

  async function start(scope: 'auto' | 'document'): Promise<void> {
    if (blocked(scope === 'auto' ? 'run' : 'run-all', 'ejecutar')) return
    const target = connection.value
    if (!target) return
    const source = scope === 'document' ? editor.getDocumentText() : editor.getExecutionText()
    if (!source) return
    // El botón no puede saber qué texto hay en el editor: la política de la transacción abortada se aplica aquí,
    // antes de enviar nada, para que el servidor no responda «current transaction is aborted».
    if (
      target.session.transaction === 'aborted' &&
      !canRunWhileAborted(target.session.engine, source.text)
    ) {
      hint.value = ABORTED_RUN_REJECTION
      return
    }
    hint.value = ''

    const request: PendingRun = {
      sessionId: target.session.sessionId,
      sql: source.text,
      scope: source.scope,
      saveToHistory: tab().saveToHistory,
      statements: [],
    }
    // En un perfil de solo lectura no se pide confirmación: main bloquea la sentencia y su error se muestra.
    if (preferences.confirmDestructive && !target.session.readOnly) {
      request.statements = findDestructiveStatements(target.session.engine, source.text)
      if (request.statements.length > 0) {
        pending.value = request
        return
      }
    }
    await execution.run(tab().id, request)
  }

  const run = () => start('auto')
  const runAll = () => start('document')

  async function cancel(): Promise<void> {
    if (blocked('cancel', 'cancelar')) return
    await execution.cancel(tab().id)
  }

  async function transaction(action: TransactionAction): Promise<void> {
    if (blocked(action, 'operar con la transacción')) return
    const target = connection.value
    if (!target) return
    hint.value = ''
    await execution.runTransaction(tab().id, target.session.sessionId, action)
  }

  /** Opt-out «justo después» de ejecutar (ADR 0005): borra en main la entrada de la última ejecución de la pestaña. */
  async function excludeFromHistory(): Promise<void> {
    const requestId = state.value.lastRequestId
    if (requestId === null || !canExcludeFromHistory.value) return
    const result = await recorded.exclude(requestId)
    const detail = result.outcome === 'error' ? describeError(result.error) : ''
    const message = describeExclusion(result.outcome, detail)
    if (result.outcome === 'error') hint.value = message
    void palette.announce(message)
    // El botón desaparece al quitar la entrada: el foco no puede quedarse en el vacío.
    void nextTick(() => editor.focusEditor())
  }

  function closeConfirmation(): PendingRun | null {
    const request = pending.value
    pending.value = null
    // El editor vive en un shadow root: el diálogo no puede devolverle el foco por sí solo.
    void nextTick(() => editor.focusEditor())
    return request
  }

  async function confirmPending(): Promise<void> {
    const request = closeConfirmation()
    if (request) await execution.run(tab().id, request)
  }

  return {
    connection,
    state,
    availability,
    hint,
    pending,
    statusText,
    recordedState,
    canExcludeFromHistory,
    excludeFromHistory,
    run,
    runAll,
    cancel,
    transaction,
    confirmPending,
    dismissPending: closeConfirmation,
  }
}
