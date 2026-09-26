import { describe, expect, it } from 'vitest'
import { availabilityOf, type AvailabilityInput } from './availability'

const base: AvailabilityInput = {
  transaction: 'none',
  status: 'idle',
  sessionBusyElsewhere: false,
  transactionBusy: false,
}

const enabledActions = (input: Partial<AvailabilityInput>) =>
  Object.entries(availabilityOf({ ...base, ...input }))
    .filter(([, state]) => state.enabled)
    .map(([action]) => action)

describe('availabilityOf', () => {
  it('idle without transaction: run, run-all and begin', () => {
    expect(enabledActions({})).toEqual(['run', 'run-all', 'begin'])
  })

  it('without a session everything is blocked with a reason', () => {
    const states = availabilityOf({ ...base, transaction: null })
    expect(Object.values(states).every((state) => !state.enabled)).toBe(true)
    expect(states.run.reason).toContain('conexión')
    expect(states.begin.reason).toContain('conexión')
  })

  it('while running only cancel is available; while cancelling nothing is', () => {
    expect(enabledActions({ status: 'running' })).toEqual(['cancel'])
    expect(enabledActions({ status: 'cancelling' })).toEqual([])
    expect(availabilityOf({ ...base, status: 'running' }).run.reason).toContain('en curso')
  })

  it('active transaction: run, commit and rollback', () => {
    expect(enabledActions({ transaction: 'active' })).toEqual([
      'run',
      'run-all',
      'commit',
      'rollback',
    ])
  })

  it('aborted transaction: run stays enabled (it accepts a hand-written ROLLBACK) but only rollback ends it', () => {
    expect(enabledActions({ transaction: 'aborted' })).toEqual(['run', 'run-all', 'rollback'])
    expect(availabilityOf({ ...base, transaction: 'aborted' }).commit.reason).toContain('revertir')
  })

  it('blocks runs and transactions while another tab uses the session or a transaction call is in flight', () => {
    expect(enabledActions({ sessionBusyElsewhere: true })).toEqual([])
    expect(enabledActions({ transactionBusy: true })).toEqual([])
  })
})
