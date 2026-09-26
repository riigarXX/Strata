import { z } from 'zod'
import {
  AI_DEFAULT_BASE_URLS,
  AI_DEFAULT_MODEL,
  AiBaseUrlSchema,
  AiModelNameSchema,
  AiProviderSchema,
} from './ai'

// Preferences hold user choices only, so no secret can be stored or echoed by construction: the few strings
// (`ai.baseUrl`, `ai.model`) are validated against closed grammars (a loopback address, a model name).

export const HISTORY_RETENTION_OPTIONS = [7, 30, 90] as const

// null means unlimited (ADR 0005); 30 days is the factory default.
export const HistoryRetentionDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.null(),
])
export type HistoryRetentionDays = z.infer<typeof HistoryRetentionDaysSchema>

export const THEME_OPTIONS = ['system', 'dark', 'light'] as const
export const ThemePreferenceSchema = z.enum(THEME_OPTIONS)
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>

// Same ceilings main enforces on every execution (QUERY_LIMITS): what the user asks for can only go down from them.
export const EXECUTION_PREFERENCE_LIMITS = {
  timeoutSeconds: { min: 1, max: 300, default: 30 },
  maxRows: { min: 1, max: 100_000, default: 10_000 },
} as const

const shapes = {
  history: {
    enabled: z.boolean(),
    retentionDays: HistoryRetentionDaysSchema,
  },
  appearance: {
    theme: ThemePreferenceSchema,
  },
  execution: {
    timeoutSeconds: z
      .int()
      .min(EXECUTION_PREFERENCE_LIMITS.timeoutSeconds.min)
      .max(EXECUTION_PREFERENCE_LIMITS.timeoutSeconds.max),
    maxRows: z
      .int()
      .min(EXECUTION_PREFERENCE_LIMITS.maxRows.min)
      .max(EXECUTION_PREFERENCE_LIMITS.maxRows.max),
    confirmDestructive: z.boolean(),
  },
  // The assistant is opt-in; the server is the user's own (ADR 0012), so its address can only be loopback.
  ai: {
    enabled: z.boolean(),
    provider: AiProviderSchema,
    baseUrl: AiBaseUrlSchema,
    model: AiModelNameSchema,
  },
} as const

const HistoryPreferencesSchema = z.strictObject(shapes.history)
const AppearancePreferencesSchema = z.strictObject(shapes.appearance)
const ExecutionPreferencesSchema = z.strictObject(shapes.execution)
const AiPreferencesSchema = z.strictObject(shapes.ai)

export const PreferencesSchema = z.strictObject({
  history: HistoryPreferencesSchema,
  appearance: AppearancePreferencesSchema,
  execution: ExecutionPreferencesSchema,
  ai: AiPreferencesSchema,
})
export type Preferences = z.infer<typeof PreferencesSchema>

// Partial update (renderer -> main): every section and field is optional, unknown keys are rejected.
export const PreferencesPatchSchema = z.strictObject({
  history: HistoryPreferencesSchema.partial().optional(),
  appearance: AppearancePreferencesSchema.partial().optional(),
  execution: ExecutionPreferencesSchema.partial().optional(),
  ai: AiPreferencesSchema.partial().optional(),
})
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>

export const DEFAULT_PREFERENCES: Preferences = {
  history: { enabled: true, retentionDays: 30 },
  appearance: { theme: 'system' },
  execution: {
    timeoutSeconds: EXECUTION_PREFERENCE_LIMITS.timeoutSeconds.default,
    maxRows: EXECUTION_PREFERENCE_LIMITS.maxRows.default,
    confirmDestructive: true,
  },
  ai: {
    enabled: false,
    provider: 'ollama',
    baseUrl: AI_DEFAULT_BASE_URLS.ollama,
    model: AI_DEFAULT_MODEL,
  },
}

/** Returns a new object; `patch` is expected to have passed `PreferencesPatchSchema`. */
export function applyPreferencesPatch(current: Preferences, patch: PreferencesPatch): Preferences {
  return PreferencesSchema.parse({
    history: { ...current.history, ...patch.history },
    appearance: { ...current.appearance, ...patch.appearance },
    execution: { ...current.execution, ...patch.execution },
    ai: { ...current.ai, ...patch.ai },
  })
}

type LooseRecord = Record<string, unknown>

const isRecord = (value: unknown): value is LooseRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Rebuilds preferences from whatever a file contained: each field that is missing keeps its default
 * silently (older or newer versions), each field that is present but invalid falls back to its default
 * and flags the input as damaged. Unknown fields are dropped.
 */
export function recoverPreferences(raw: unknown): { preferences: Preferences; damaged: boolean } {
  const source: LooseRecord = isRecord(raw) ? raw : {}
  let damaged = raw !== undefined && !isRecord(raw)
  const recovered: Record<string, LooseRecord> = {}

  for (const [section, fields] of Object.entries(shapes)) {
    const defaults = DEFAULT_PREFERENCES[section as keyof Preferences] as LooseRecord
    const merged: LooseRecord = { ...defaults }
    const stored = source[section]
    if (stored !== undefined && !isRecord(stored)) damaged = true
    if (isRecord(stored)) {
      for (const [field, schema] of Object.entries(fields) as [string, z.ZodType][]) {
        if (!(field in stored)) continue
        const parsed = schema.safeParse(stored[field])
        if (parsed.success) merged[field] = parsed.data
        else damaged = true
      }
    }
    recovered[section] = merged
  }

  return { preferences: PreferencesSchema.parse(recovered), damaged }
}
