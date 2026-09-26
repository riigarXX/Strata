export { useAiApi, type AiApi } from './api/use-ai-api'
export { default as AiSettingsSection } from './components/AiSettingsSection.vue'
export { default as AskDialog } from './components/AskDialog.vue'
export { parseBaseUrl, type ParsedBaseUrl } from './model/base-url'
export {
  describeAiError,
  describePullProgress,
  formatBytes,
  formatPercent,
  PROVIDER_LABELS,
  RECOMMENDED_MODEL,
  type AiErrorContext,
} from './model/presentation'
export {
  advancePullProgress,
  INITIAL_PULL_PROGRESS,
  type PullProgressState,
  type PullStage,
} from './model/pull-progress'
export {
  useAiStore,
  type AiConnection,
  type AiModelsStatus,
  type AiPull,
  type AiPullPhase,
  type AiTarget,
} from './stores/ai'
export { useAskStore, type AskOutcome, type AskPhase } from './stores/ask'
