import type { HistoryRetentionDays } from '@strata/contracts'
import { createMemoryStorage } from '../local-storage/testing'
import type { Clock } from './clock'
import { createHistoryStore, type NewHistoryEntry } from './history-store'

export const DAY_MS = 24 * 60 * 60 * 1000
export const NOW = Date.parse('2026-09-20T12:00:00.000Z')
export const HISTORY_PATH = '/user-data/history.json'

export interface FakeClock extends Clock {
  /** Avanza el tiempo y dispara cada temporizador tantas veces como intervalos completos cruce. */
  advance(ms: number): void
  readonly activeTimers: number
}

export function createFakeClock(start = NOW): FakeClock {
  let current = start
  const timers = new Set<{ interval: number; due: number; task: () => void }>()
  return {
    now: () => current,
    every(interval, task) {
      const timer = { interval, due: current + interval, task }
      timers.add(timer)
      return () => {
        timers.delete(timer)
      }
    },
    advance(ms) {
      const target = current + ms
      for (;;) {
        const next = [...timers].filter(({ due }) => due <= target).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        current = next.due
        next.due += next.interval
        next.task()
      }
      current = target
    },
    get activeTimers() {
      return timers.size
    },
  }
}

export function entryAt(time: number, overrides: Partial<NewHistoryEntry> = {}): NewHistoryEntry {
  return {
    sql: 'SELECT 1',
    engine: 'sqlite',
    profileId: 'profile-1',
    profileName: 'Local',
    executedAt: new Date(time).toISOString(),
    durationMs: 5,
    status: 'ok',
    ...overrides,
  }
}

export function setupHistory(options: { retentionDays?: HistoryRetentionDays } = {}) {
  const memory = createMemoryStorage()
  const clock = createFakeClock()
  const retention = { days: options.retentionDays === undefined ? 30 : options.retentionDays }
  let counter = 0
  const store = createHistoryStore({
    fileSystem: memory.fileSystem,
    filePath: HISTORY_PATH,
    getRetentionDays: async () => retention.days,
    clock,
    createId: () => `id-${String(++counter).padStart(4, '0')}`,
  })
  const stored = (): { version: number; entries: Record<string, unknown>[] } =>
    JSON.parse(memory.files.get(HISTORY_PATH) ?? 'null')
  return { memory, clock, retention, store, stored }
}
