import { describe, expect, it } from 'vitest'
import { advancePullProgress, INITIAL_PULL_PROGRESS, type PullProgressState } from './pull-progress'

const advance = (
  state: PullProgressState,
  status: string,
  completed: number | null = null,
  total: number | null = null,
) => advancePullProgress(state, { status, completed, total })

describe('advancePullProgress', () => {
  it('starts indeterminate while there is only a manifest', () => {
    const state = advance(INITIAL_PULL_PROGRESS, 'pulling manifest')
    expect(state).toMatchObject({ stage: 'preparing', percent: null, total: null })
  })

  it('reports the percentage and bytes of the layer being downloaded', () => {
    const state = advance(INITIAL_PULL_PROGRESS, 'pulling aaa', 250, 1000)
    expect(state).toMatchObject({ stage: 'downloading', completed: 250, total: 1000, percent: 25 })
  })

  it('adds the layers together so small ones do not send the bar back to zero', () => {
    let state = advance(INITIAL_PULL_PROGRESS, 'pulling big', 9_000, 9_000)
    expect(state.percent).toBe(100)
    state = advance(state, 'pulling small', 0, 100)
    expect(state.percent).toBe(100)
    expect(state.total).toBe(9_100)
    state = advance(state, 'pulling small', 100, 100)
    expect(state).toMatchObject({ completed: 9_100, total: 9_100, percent: 100 })
  })

  it('never lets the percentage go backwards', () => {
    let state = advance(INITIAL_PULL_PROGRESS, 'pulling a', 500, 1000)
    state = advance(state, 'pulling a', 100, 1000)
    expect(state.percent).toBe(50)
    expect(state.completed).toBe(500)
  })

  it('caps a layer at its own size and ignores events without a size', () => {
    let state = advance(INITIAL_PULL_PROGRESS, 'pulling a', 5000, 1000)
    expect(state).toMatchObject({ completed: 1000, percent: 100 })
    state = advance(state, 'pulling b', null, null)
    state = advance(state, 'pulling c', 5, 0)
    expect(state.total).toBe(1000)
  })

  it('follows the stages of an Ollama download and keeps the last one on unknown statuses', () => {
    let state = advance(INITIAL_PULL_PROGRESS, 'pulling manifest')
    state = advance(state, 'pulling aaa', 1, 2)
    expect(state.stage).toBe('downloading')
    state = advance(state, 'verifying sha256 digest')
    expect(state.stage).toBe('verifying')
    state = advance(state, 'something new')
    expect(state.stage).toBe('verifying')
    state = advance(state, 'writing manifest')
    expect(state.stage).toBe('finishing')
    state = advance(state, 'success')
    expect(state.stage).toBe('finishing')
  })

  it('keeps a bounded number of layers', () => {
    let state = INITIAL_PULL_PROGRESS
    for (let index = 0; index < 200; index += 1) state = advance(state, `pulling ${index}`, 1, 2)
    expect(Object.keys(state.layers)).toHaveLength(64)
  })

  it('does not mutate the previous state', () => {
    const before = advance(INITIAL_PULL_PROGRESS, 'pulling a', 1, 2)
    const snapshot = structuredClone(before)
    advance(before, 'pulling b', 3, 4)
    expect(before).toEqual(snapshot)
  })
})
