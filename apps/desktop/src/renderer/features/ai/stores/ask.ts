import {
  AiQuestionSchema,
  type AiGenerateSqlResult,
  type AiSqlRisk,
  type AiSqlStatementType,
  type AiWarning,
  type NormalizedError,
  type SessionId,
} from '@strata/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useExecutionStore } from '../../execution/stores/execution'
import { usePreferencesStore } from '../../preferences'
import {
  useActiveConnection,
  useLiveConnections,
} from '../../workspace/composables/use-active-connection'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { useAiApi } from '../api/use-ai-api'
import {
  decideAutoRun,
  tabTitleFor,
  type AskPrerequisite,
  type AutoRunDecision,
} from '../model/ask'

export type AskPhase = 'idle' | 'generating' | 'ready' | 'error' | 'cancelled'

/** Qué se hizo con la consulta propuesta. La pregunta no está aquí: solo dio título a la pestaña. */
export interface AskOutcome {
  sql: string
  risk: AiSqlRisk
  statementType: AiSqlStatementType
  warnings: AiWarning[]
  blocked: boolean
  /** Si se ejecutó sola o por qué se quedó esperando al usuario. */
  decision: AutoRunDecision
  tabId: string
  tabTitle: string
}

const SESSION_GONE: NormalizedError = {
  code: 'no_session',
  message: 'There is no open session for this request',
  retryable: false,
}

/**
 * Preguntar a la base en lenguaje natural (ADR 0012). Todo lo que devuelve el modelo es texto no confiable:
 * se abre siempre en una pestaña nueva y solo se ejecuta sin preguntar si `decideAutoRun` lo permite, con la
 * marca `enforceReadOnly` para que main lo restrinja aunque el renderer se equivocara. La pregunta se envía a
 * main y no se conserva: ni aquí, ni en el historial, ni en ningún almacén.
 */
export const useAskStore = defineStore('ask', () => {
  const api = useAiApi()
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()
  const preferences = usePreferencesStore()
  const activeConnection = useActiveConnection()
  const live = useLiveConnections()

  const isOpen = ref(false)
  const phase = ref<AskPhase>('idle')
  const outcome = ref<AskOutcome | null>(null)
  const error = ref<NormalizedError | null>(null)

  // Una sola petición vale a la vez: la respuesta de una cancelada o reemplazada llega y se descarta.
  let activeRequest: string | null = null

  /** Lo que falta para poder preguntar; `null` si se puede. Nada de esto llama al modelo. */
  const prerequisite = computed<AskPrerequisite | null>(() => {
    if (!preferences.ai.enabled) return 'disabled'
    if (activeConnection.value) return null
    return workspace.activeTab === null ? 'no-tab' : 'no-session'
  })

  function reset(): void {
    phase.value = 'idle'
    outcome.value = null
    error.value = null
  }

  function open(): void {
    if (phase.value !== 'generating') reset()
    isOpen.value = true
  }

  /** Abandona la generación en curso: nada se abre ni se ejecuta aunque main ya hubiera terminado. */
  function cancel(): void {
    const requestId = activeRequest
    if (phase.value !== 'generating' || requestId === null) return
    activeRequest = null
    phase.value = 'cancelled'
    void api.cancel({ requestId })
  }

  function close(): void {
    cancel()
    isOpen.value = false
  }

  function deliver(result: AiGenerateSqlResult, sessionId: SessionId, question: string): void {
    const connection = live.value.find((entry) => entry.session.sessionId === sessionId)
    if (!connection) {
      error.value = SESSION_GONE
      phase.value = 'error'
      return
    }

    const tab = workspace.createTab(sessionId)
    const tabTitle = tabTitleFor(question)
    workspace.setTitle(tab.id, tabTitle)
    workspace.setContent(tab.id, result.sql)

    // El estado de la sesión se lee ahora, no al preguntar: pudo cambiar mientras el modelo generaba.
    const decision = decideAutoRun({
      result,
      transaction: connection.session.transaction,
      sessionBusy: execution.isSessionBusy(sessionId, tab.id),
    })
    if (decision.run) {
      void execution.run(tab.id, {
        sessionId,
        sql: result.sql,
        scope: 'document',
        enforceReadOnly: true,
      })
    }

    outcome.value = {
      sql: result.sql,
      risk: result.risk,
      statementType: result.statementType,
      warnings: result.warnings,
      blocked: result.blocked === true,
      decision,
      tabId: tab.id,
      tabTitle,
    }
    phase.value = 'ready'
  }

  /** Envía la pregunta con la conexión de la pestaña activa. No hace nada si falta un requisito o ya hay una en curso. */
  async function submit(text: string): Promise<void> {
    if (phase.value === 'generating' || prerequisite.value !== null) return
    const sessionId = activeConnection.value?.session.sessionId
    const question = text.trim()
    if (sessionId === undefined || !AiQuestionSchema.safeParse(question).success) return

    const requestId = crypto.randomUUID()
    activeRequest = requestId
    outcome.value = null
    error.value = null
    phase.value = 'generating'

    const result = await api.generateSql({ requestId, sessionId, question })
    if (activeRequest !== requestId) return
    activeRequest = null

    if (!result.ok) {
      error.value = result.error
      phase.value = result.error.code === 'cancelled' ? 'cancelled' : 'error'
      return
    }
    deliver(result.data, sessionId, question)
  }

  return { isOpen, phase, outcome, error, prerequisite, open, close, cancel, submit }
})
