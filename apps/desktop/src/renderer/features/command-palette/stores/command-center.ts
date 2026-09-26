import { CommandRegistry } from '@strata/commands'
import { defineStore } from 'pinia'
import { computed, markRaw } from 'vue'
import { useAskStore } from '../../ai/stores/ask'
import { useConnectionsPanelStore, useConnectionsStore } from '../../connections'
import { currentExecutionPort } from '../../execution/composables/execution-port'
import { useExecutionStore } from '../../execution/stores/execution'
import { useHistoryPanelStore } from '../../history/stores/history-panel'
import { usePreferencesStore } from '../../preferences'
import { useQueryEditor } from '../../query-editor'
import { currentSchemaPort, qualifiedTableName, useSchemaCacheStore } from '../../schema-browser'
import { useSettingsStore } from '../../settings/stores/settings'
import {
  useLiveConnections,
  useActiveConnection,
} from '../../workspace/composables/use-active-connection'
import { useTabActions } from '../../workspace/composables/use-tab-actions'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { APP_COMMANDS } from '../commands'
import type {
  AppCommandActions,
  AppCommandContext,
  ConnectionSummary,
  SchemaSummary,
} from '../model/context'
import { usePaletteStore } from './palette'

/**
 * Único punto donde el registro de comandos (puro) se une con la aplicación: construye el contexto que se
 * inyecta a los comandos a partir de los stores y de los puertos de la barra de ejecución y del explorador.
 * El contexto solo expone datos mínimos (nombres, motores, estados): nunca perfiles completos ni secretos.
 */
export const useCommandCenter = defineStore('commandCenter', () => {
  const workspace = useWorkspaceStore()
  const connections = useConnectionsStore()
  const connectionsPanel = useConnectionsPanelStore()
  const preferences = usePreferencesStore()
  const settings = useSettingsStore()
  const historyPanel = useHistoryPanelStore()
  const ask = useAskStore()
  const execution = useExecutionStore()
  const schemaCache = useSchemaCacheStore()
  const palette = usePaletteStore()
  const live = useLiveConnections()
  const activeConnection = useActiveConnection()
  const tabActions = useTabActions()
  const editor = useQueryEditor()

  const summarize = (profileId: string): ConnectionSummary | null => {
    const profile = connections.findProfile(profileId)
    if (!profile) return null
    return {
      id: profile.id,
      name: profile.name,
      engine: profile.engine,
      readOnly: profile.readOnly,
      status: connections.runtimeOf(profile.id).status,
    }
  }

  const connectionSummaries = computed(() =>
    connections.profiles.flatMap((profile) => summarize(profile.id) ?? []),
  )
  const activeSummary = computed(() =>
    activeConnection.value ? summarize(activeConnection.value.profile.id) : null,
  )

  // Sesión de la pestaña activa: la misma cuyo esquema muestra el explorador.
  const tabSession = computed(
    () =>
      live.value.find((entry) => entry.session.sessionId === workspace.activeTab?.sessionId) ??
      null,
  )
  const schemaSummary = computed<SchemaSummary | null>(() => {
    const entry = tabSession.value
    if (!entry) return null
    const cached = schemaCache.sessions[entry.session.sessionId]
    const schemas = (cached?.schemas?.data ?? []).map((schema) => schema.name)
    const tables = schemas.flatMap((schema) =>
      (cached?.tables[schema]?.data ?? []).map((table) => ({
        schema: table.schema,
        name: table.name,
        kind: table.kind,
        qualifiedName: qualifiedTableName(entry.session.engine, table),
      })),
    )
    return { schemas, tables }
  })

  const executionSummary = computed(() => {
    const port = currentExecutionPort()
    const tab = workspace.activeTab
    if (!port || !tab) return null
    const state = execution.stateOf(tab.id)
    return {
      availability: port.availability(),
      idle: state.status === 'idle' && state.transactionBusy === null,
      canExcludeFromHistory: port.canExcludeFromHistory(),
    }
  })

  const actions: AppCommandActions = {
    newTab: tabActions.newTab,
    closeActiveTab: tabActions.closeActiveTab,
    selectRelativeTab: (delta) => workspace.activateRelative(delta),
    selectTabAt: (index) => workspace.activateAt(index),
    selectLastTab: () => workspace.activateLast(),
    run: async () => void (await currentExecutionPort()?.run()),
    runAll: async () => void (await currentExecutionPort()?.runAll()),
    cancel: async () => void (await currentExecutionPort()?.cancel()),
    transaction: async (action) => void (await currentExecutionPort()?.transaction(action)),
    openSettings: (section) => settings.open(section),
    openHistory: () => historyPanel.open(),
    openAsk: () => ask.open(),
    excludeFromHistory: async () => void (await currentExecutionPort()?.excludeFromHistory()),
    formatDocument: () => editor.formatDocument(),
    focusEditor: () => editor.focusEditor(),
    refreshSchema: () => {
      const sessionId = tabSession.value?.session.sessionId
      if (sessionId) void schemaCache.refresh(sessionId)
    },
    revealInSchema: async (target) => (await currentSchemaPort()?.reveal(target)) ?? false,
    insertText: (text) => workspace.requestInsert(text),
    openConnections: () => connectionsPanel.openManage(),
    connect: async (profileId) => {
      const current = connections.runtimeOf(profileId)
      if (current.status === 'connecting') return
      if (current.status !== 'connected') await connections.connect(profileId)
      connections.select(profileId)
      const { status, session } = connections.runtimeOf(profileId)
      const tab = workspace.activeTab
      if (status === 'connected' && session && tab) workspace.setSession(tab.id, session.sessionId)
    },
    disconnect: (profileId) => connections.disconnect(profileId),
    openPalette: (mode, query) => palette.open(mode, query),
    togglePalette: () => palette.toggle(),
    setTiming: (value) => {
      preferences.setShowTiming(value === 'toggle' ? !preferences.showTiming : value)
      return preferences.showTiming
    },
    setTheme: (theme) => preferences.setTheme(theme),
    clearActiveTab: () => {
      const tab = workspace.activeTab
      return tab ? execution.clearTab(tab.id) : false
    },
    announce: (message) => void palette.announce(message),
  }

  // Lecturas perezosas: cada `when` que se ejecute dentro de un `computed` queda suscrito a lo que lee.
  const context: AppCommandContext = {
    get tabs() {
      return { count: workspace.tabs.length, activeIndex: workspace.activeIndex }
    },
    get connections() {
      return connectionSummaries.value
    },
    get activeConnection() {
      return activeSummary.value
    },
    get schema() {
      return schemaSummary.value
    },
    get execution() {
      return executionSummary.value
    },
    get editorReady() {
      return editor.isAvailable()
    },
    get preferences() {
      return { theme: preferences.theme, showTiming: preferences.showTiming }
    },
    get paletteOpen() {
      return palette.isOpen
    },
    actions,
  }

  const registry = new CommandRegistry<AppCommandContext>({ context: () => context })
  registry.registerAll(APP_COMMANDS)

  // Ni el registro (campos privados) ni el contexto (getters) deben convertirse en proxies reactivos.
  return { registry: markRaw(registry), context: markRaw(context) }
})
