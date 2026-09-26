import { describe, expect, it } from 'vitest'
import { clampSize, paneLimits } from './pane-limits'

describe('paneLimits', () => {
  const bounds = { min: 100, max: 500 }

  it('uses the absolute maximum while the container is not measured', () => {
    expect(paneLimits(bounds, 0, 120)).toEqual({ min: 100, max: 500 })
  })

  it('shrinks the maximum to leave the reserved room', () => {
    expect(paneLimits(bounds, 400, 120)).toEqual({ min: 100, max: 280 })
  })

  it('never drops the maximum below the minimum', () => {
    expect(paneLimits(bounds, 150, 120)).toEqual({ min: 100, max: 100 })
  })
})

describe('clampSize', () => {
  it('clamps to both ends', () => {
    expect(clampSize(50, { min: 100, max: 500 })).toBe(100)
    expect(clampSize(900, { min: 100, max: 500 })).toBe(500)
    expect(clampSize(300, { min: 100, max: 500 })).toBe(300)
  })
})
