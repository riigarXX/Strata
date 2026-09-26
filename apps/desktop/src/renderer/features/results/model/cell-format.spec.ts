import { describe, expect, it } from 'vitest'
import {
  DISPLAY_MAX_CHARS,
  displayText,
  formatBytes,
  fullText,
  truncationNotice,
} from './cell-format'

describe('displayText', () => {
  it('shows NULL as its own text and other scalars as strings', () => {
    expect(displayText(null)).toBe('NULL')
    expect(displayText(0)).toBe('0')
    expect(displayText(false)).toBe('false')
    expect(displayText('')).toBe('')
  })

  it('keeps a value on one line', () => {
    expect(displayText('a\nb\r\nc\td')).toBe('a↵b↵c⇥d')
  })

  it('cuts long values so a cell of 500 000 characters costs nothing in the DOM', () => {
    const text = displayText('x'.repeat(500_000))
    expect(text).toHaveLength(DISPLAY_MAX_CHARS + 1)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('fullText and byte formatting', () => {
  it('returns the whole value', () => {
    expect(fullText('x'.repeat(1_000))).toHaveLength(1_000)
    expect(fullText(null)).toBe('NULL')
    expect(fullText(12)).toBe('12')
  })

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2_048)).toBe('2 KiB')
    expect(formatBytes(500_000)).toBe('488,3 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MiB')
  })

  it('states the original size of a truncated value', () => {
    expect(truncationNotice(500_000)).toContain('488,3 KiB')
    expect(truncationNotice(500_000)).toContain('truncado')
  })
})
