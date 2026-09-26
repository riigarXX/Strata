import { describe, expect, it } from 'vitest'
import {
  applyPreferencesPatch,
  DEFAULT_PREFERENCES,
  EXECUTION_PREFERENCE_LIMITS,
  PreferencesPatchSchema,
  PreferencesSchema,
  recoverPreferences,
} from './preferences'

describe('DEFAULT_PREFERENCES', () => {
  it('are valid and match the documented defaults (ADR 0005)', () => {
    expect(PreferencesSchema.parse(DEFAULT_PREFERENCES)).toEqual(DEFAULT_PREFERENCES)
    expect(DEFAULT_PREFERENCES).toEqual({
      history: { enabled: true, retentionDays: 30 },
      appearance: { theme: 'system' },
      execution: { timeoutSeconds: 30, maxRows: 10_000, confirmDestructive: true },
      ai: {
        enabled: false,
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3:14b',
      },
    })
  })
})

describe('PreferencesPatchSchema', () => {
  it('accepts an empty patch, a partial section and every allowed retention', () => {
    expect(PreferencesPatchSchema.safeParse({}).success).toBe(true)
    expect(PreferencesPatchSchema.safeParse({ history: {} }).success).toBe(true)
    expect(PreferencesPatchSchema.safeParse({ history: { enabled: false } }).success).toBe(true)
    for (const retentionDays of [7, 30, 90, null]) {
      expect(PreferencesPatchSchema.safeParse({ history: { retentionDays } }).success).toBe(true)
    }
  })

  it.each([
    ['retention outside the allowed values', { history: { retentionDays: 15 } }],
    ['retention as text', { history: { retentionDays: '30' } }],
    ['history disabled as text', { history: { enabled: 'no' } }],
    ['unknown theme', { appearance: { theme: 'sepia' } }],
    ['timeout above the ceiling', { execution: { timeoutSeconds: 301 } }],
    ['timeout below 1', { execution: { timeoutSeconds: 0 } }],
    ['fractional timeout', { execution: { timeoutSeconds: 1.5 } }],
    ['maxRows above the ceiling', { execution: { maxRows: 100_001 } }],
    ['unknown field', { history: { enabled: true, secret: 'x' } }],
    ['unknown section', { network: {} }],
    ['a password-like field', { password: 'hunter2' }],
  ])('rejects %s', (_name, patch) => {
    expect(PreferencesPatchSchema.safeParse(patch).success).toBe(false)
  })

  it('accepts a partial ai section and rejects addresses outside loopback and malformed model names', () => {
    expect(PreferencesPatchSchema.safeParse({ ai: { enabled: true } }).success).toBe(true)
    expect(
      PreferencesPatchSchema.safeParse({
        ai: {
          provider: 'lmstudio',
          baseUrl: 'http://localhost:1234/v1',
          model: 'qwen/qwen3.8-27b',
        },
      }).success,
    ).toBe(true)
    for (const ai of [
      { baseUrl: 'https://api.openai.com' },
      { baseUrl: 'http://127.0.0.1@evil.com:1234' },
      { provider: 'openai' },
      { model: '' },
      { model: 'a b' },
      { model: '../x' },
      { apiKey: 'sk-secret' },
    ]) {
      expect(PreferencesPatchSchema.safeParse({ ai }).success, JSON.stringify(ai)).toBe(false)
    }
  })

  it('caps execution preferences at the limits main applies', () => {
    const { timeoutSeconds, maxRows } = EXECUTION_PREFERENCE_LIMITS
    const patch = { execution: { timeoutSeconds: timeoutSeconds.max, maxRows: maxRows.max } }
    expect(PreferencesPatchSchema.safeParse(patch).success).toBe(true)
  })
})

describe('applyPreferencesPatch', () => {
  it('changes only what the patch names and does not mutate the input', () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_PREFERENCES))
    const next = applyPreferencesPatch(DEFAULT_PREFERENCES, {
      history: { retentionDays: null },
      appearance: { theme: 'dark' },
    })

    expect(next).toEqual({
      history: { enabled: true, retentionDays: null },
      appearance: { theme: 'dark' },
      execution: DEFAULT_PREFERENCES.execution,
      ai: DEFAULT_PREFERENCES.ai,
    })
    expect(DEFAULT_PREFERENCES).toEqual(before)
  })
})

describe('recoverPreferences', () => {
  it('returns the defaults, undamaged, when there is nothing stored', () => {
    expect(recoverPreferences(undefined)).toEqual({
      preferences: DEFAULT_PREFERENCES,
      damaged: false,
    })
    expect(recoverPreferences({})).toEqual({ preferences: DEFAULT_PREFERENCES, damaged: false })
  })

  it('keeps valid fields and fills the missing ones without flagging damage', () => {
    const result = recoverPreferences({ history: { retentionDays: 7 } })
    expect(result.damaged).toBe(false)
    expect(result.preferences.history).toEqual({ enabled: true, retentionDays: 7 })
  })

  it('replaces only the invalid fields and flags the damage', () => {
    const result = recoverPreferences({
      history: { enabled: false, retentionDays: 999 },
      appearance: { theme: 'dark' },
      execution: 'broken',
    })
    expect(result.damaged).toBe(true)
    expect(result.preferences).toEqual({
      history: { enabled: false, retentionDays: 30 },
      appearance: { theme: 'dark' },
      execution: DEFAULT_PREFERENCES.execution,
      ai: DEFAULT_PREFERENCES.ai,
    })
  })

  it('fills the ai section from the defaults when a file written before it existed has none', () => {
    const result = recoverPreferences({
      history: { enabled: false, retentionDays: 7 },
      appearance: { theme: 'light' },
      execution: DEFAULT_PREFERENCES.execution,
    })
    expect(result.damaged).toBe(false)
    expect(result.preferences.ai).toEqual(DEFAULT_PREFERENCES.ai)
    expect(result.preferences.ai.enabled).toBe(false)
  })

  it('replaces an ai address that is not loopback and flags the damage, keeping the rest of the section', () => {
    const result = recoverPreferences({
      ai: { enabled: true, baseUrl: 'http://evil.example.com:11434', model: 'llama3:8b' },
    })
    expect(result.damaged).toBe(true)
    expect(result.preferences.ai).toEqual({
      ...DEFAULT_PREFERENCES.ai,
      enabled: true,
      model: 'llama3:8b',
    })
  })

  it('treats a non-object as damaged and drops unknown fields', () => {
    expect(recoverPreferences('x')).toEqual({ preferences: DEFAULT_PREFERENCES, damaged: true })
    expect(recoverPreferences([1])).toEqual({ preferences: DEFAULT_PREFERENCES, damaged: true })
    const result = recoverPreferences({ history: { enabled: false, future: 1 }, extra: true })
    expect(result.damaged).toBe(false)
    expect(result.preferences.history.enabled).toBe(false)
    expect(result.preferences).not.toHaveProperty('extra')
  })
})
