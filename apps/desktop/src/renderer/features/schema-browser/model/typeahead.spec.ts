import { describe, expect, it } from 'vitest'
import { Typeahead, TYPEAHEAD_TIMEOUT_MS } from './typeahead'

const labels = ['accounts', 'archive', 'orders', 'order_items', 'Products']

describe('Typeahead', () => {
  it('jumps to the next label that starts with the typed character, ignoring case', () => {
    const typeahead = new Typeahead()
    expect(typeahead.push('o', labels, 0, 0)).toBe(2)
    expect(typeahead.push('P', labels, 0, 5_000)).toBe(4)
  })

  it('accumulates characters typed without a pause', () => {
    const typeahead = new Typeahead()
    expect(typeahead.push('o', labels, 0, 0)).toBe(2)
    expect(typeahead.push('r', labels, 2, 100)).toBe(2)
    expect(typeahead.push('d', labels, 2, 200)).toBe(2)
    expect(typeahead.push('e', labels, 2, 300)).toBe(2)
    expect(typeahead.push('r', labels, 2, 400)).toBe(2)
    expect(typeahead.push('_', labels, 2, 500)).toBe(3)
  })

  it('starts a new search after the pause', () => {
    const typeahead = new Typeahead()
    typeahead.push('o', labels, 0, 0)
    expect(typeahead.push('a', labels, 2, TYPEAHEAD_TIMEOUT_MS + 1)).toBe(0)
  })

  it('cycles through the matches when the same letter is repeated', () => {
    const typeahead = new Typeahead()
    expect(typeahead.push('a', labels, 0, 0)).toBe(1)
    expect(typeahead.push('a', labels, 1, 100)).toBe(0)
  })

  it('wraps around and returns null without a match', () => {
    const typeahead = new Typeahead()
    expect(typeahead.push('a', labels, 4, 0)).toBe(0)
    expect(typeahead.push('z', labels, 4, 5_000)).toBeNull()
  })

  it('reports whether a search is in progress so that a space can be part of it', () => {
    const typeahead = new Typeahead()
    expect(typeahead.active).toBe(false)
    typeahead.push('m', ['my table'], 0, 0)
    typeahead.push('y', ['my table'], 0, 50)
    expect(typeahead.active).toBe(true)
    expect(typeahead.push(' ', ['my table'], 0, 100)).toBe(0)
  })
})
