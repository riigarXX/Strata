import { describe, expect, it } from 'vitest'
import { isFormatShortcut, type KeyEventLike } from './format-shortcut'

const event = (patch: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: 'F',
  code: 'KeyF',
  altKey: true,
  shiftKey: true,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  ...patch,
})

describe('isFormatShortcut', () => {
  it('matches Shift+Alt+F, including the character macOS types for Option+Shift+F', () => {
    expect(isFormatShortcut(event())).toBe(true)
    expect(isFormatShortcut(event({ key: 'Ï' }))).toBe(true)
    expect(isFormatShortcut(event({ key: 'f', code: 'Unidentified' }))).toBe(true)
  })

  it.each([
    ['without Alt', { altKey: false }],
    ['without Shift', { shiftKey: false }],
    ['with Cmd', { metaKey: true }],
    ['with Ctrl', { ctrlKey: true }],
    ['on key repeat', { repeat: true }],
    ['on another key', { key: 'G', code: 'KeyG' }],
  ])('does not match %s', (_name, patch) => {
    expect(isFormatShortcut(event(patch))).toBe(false)
  })
})
