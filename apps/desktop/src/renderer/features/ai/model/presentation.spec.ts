import type { NormalizedError } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import {
  describeAiError,
  describePullProgress,
  formatBytes,
  formatPercent,
  modelOptionLabel,
  PROVIDER_LABELS,
  RECOMMENDED_MODEL,
} from './presentation'
import { advancePullProgress, INITIAL_PULL_PROGRESS } from './pull-progress'

const error = (code: NormalizedError['code']): NormalizedError => ({
  code,
  message: 'Fixed English message from main',
  retryable: false,
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1_500, '1,5 KB'],
    [274_000_000, '274 MB'],
    [9_276_000_000, '9,3 GB'],
    [120_000_000_000, '120 GB'],
    [2_000_000_000_000, '2 TB'],
  ])('writes %d bytes as %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })

  it('never fails on nonsense', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })
})

describe('formatPercent', () => {
  it('rounds and clamps to 0-100', () => {
    expect(formatPercent(45.4)).toBe('45 %')
    expect(formatPercent(99.6)).toBe('100 %')
    expect(formatPercent(-3)).toBe('0 %')
    expect(formatPercent(180)).toBe('100 %')
  })
})

describe('modelOptionLabel', () => {
  it('adds the size only when the server reports it', () => {
    expect(
      modelOptionLabel({ name: 'qwen3:14b', sizeBytes: 9_276_000_000, embedding: false }),
    ).toBe('qwen3:14b · 9,3 GB')
    expect(modelOptionLabel({ name: 'qwen/qwen3.8-27b', sizeBytes: null, embedding: false })).toBe(
      'qwen/qwen3.8-27b',
    )
  })
})

describe('describePullProgress', () => {
  it('says only the stage while the total is unknown', () => {
    expect(describePullProgress(INITIAL_PULL_PROGRESS)).toBe('Preparando la descarga…')
  })

  it('writes stage, percentage and bytes without relying on colour', () => {
    const state = advancePullProgress(INITIAL_PULL_PROGRESS, {
      status: 'pulling abc',
      completed: 4_200_000_000,
      total: 9_276_000_000,
    })
    expect(describePullProgress(state)).toBe('Descargando 45 % · 4,2 GB de 9,3 GB')
  })

  it('omits the bytes once the download is being verified', () => {
    let state = advancePullProgress(INITIAL_PULL_PROGRESS, {
      status: 'pulling abc',
      completed: 10,
      total: 10,
    })
    state = advancePullProgress(state, {
      status: 'verifying sha256 digest',
      completed: null,
      total: null,
    })
    expect(describePullProgress(state)).toBe('Verificando la descarga… 100 %')
  })
})

describe('describeAiError', () => {
  it('shows the interface own text and never the English message main sent', () => {
    for (const code of [
      'connection_failed',
      'timeout',
      'cancelled',
      'not_found',
      'permission_denied',
      'busy',
      'validation_failed',
      'internal_error',
    ] as const) {
      for (const context of ['connect', 'models', 'pull'] as const) {
        const text = describeAiError(error(code), context)
        expect(text, `${code}/${context}`).not.toContain('English')
        expect(text.length).toBeGreaterThan(10)
      }
    }
  })

  it('covers a server that is down and a full disk in the same download message', () => {
    const text = describeAiError(error('connection_failed'), 'pull')
    expect(text).toMatch(/en marcha/)
    expect(text).toMatch(/espacio/)
  })

  it('tells the user how to proceed for the errors of a download', () => {
    expect(describeAiError(error('cancelled'), 'pull')).toBe('Descarga cancelada.')
    expect(describeAiError(error('permission_denied'), 'pull')).toMatch(/Activa la IA local/)
    expect(describeAiError(error('validation_failed'), 'pull')).toMatch(/propia aplicación/)
    expect(describeAiError(error('not_found'), 'pull')).toMatch(/biblioteca/)
  })
})

describe('constants', () => {
  it('names the three providers and recommends qwen3:14b', () => {
    expect(Object.keys(PROVIDER_LABELS)).toEqual(['ollama', 'lmstudio', 'custom'])
    expect(RECOMMENDED_MODEL.name).toBe('qwen3:14b')
  })
})
