import { describe, expect, it } from 'vitest'
import { splitByRanges } from './highlight'

describe('splitByRanges', () => {
  it('returns the whole text when nothing matches', () => {
    expect(splitByRanges('Ejecutar', [])).toEqual([{ text: 'Ejecutar', match: false }])
    expect(splitByRanges('', [])).toEqual([{ text: '', match: false }])
  })

  it('alternates plain and matched segments', () => {
    expect(
      splitByRanges('Nueva pestaña', [
        { start: 0, end: 3 },
        { start: 6, end: 10 },
      ]),
    ).toEqual([
      { text: 'Nue', match: true },
      { text: 'va ', match: false },
      { text: 'pest', match: true },
      { text: 'aña', match: false },
    ])
  })

  it('handles a match that covers the whole text or the tail', () => {
    expect(splitByRanges('abc', [{ start: 0, end: 3 }])).toEqual([{ text: 'abc', match: true }])
    expect(splitByRanges('abc', [{ start: 2, end: 3 }])).toEqual([
      { text: 'ab', match: false },
      { text: 'c', match: true },
    ])
  })

  it('clamps ranges to the text and skips empty or overlapping ones', () => {
    expect(splitByRanges('abc', [{ start: 1, end: 99 }])).toEqual([
      { text: 'a', match: false },
      { text: 'bc', match: true },
    ])
    expect(
      splitByRanges('abc', [
        { start: 1, end: 1 },
        { start: 5, end: 6 },
      ]),
    ).toEqual([{ text: 'abc', match: false }])
    expect(
      splitByRanges('abcd', [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
      ]),
    ).toEqual([
      { text: 'ab', match: true },
      { text: 'c', match: true },
      { text: 'd', match: false },
    ])
  })
})
