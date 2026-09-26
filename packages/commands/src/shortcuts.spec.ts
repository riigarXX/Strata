import { describe, expect, it } from 'vitest'
import {
  ariaKeyShortcut,
  canonicalShortcut,
  detectPlatform,
  formatShortcut,
  matchesShortcut,
  parseShortcut,
  ShortcutSyntaxError,
  shortcutSignature,
  shortcutsConflict,
  type KeyEventLike,
} from './shortcuts'

function event(init: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }
}

describe('parseShortcut', () => {
  it('parses modifiers and keys ignoring case and spacing', () => {
    expect(parseShortcut('Mod+K')).toEqual({
      key: 'k',
      mod: true,
      ctrl: false,
      meta: false,
      alt: false,
      shift: false,
    })
    expect(parseShortcut(' mod + shift + enter '.replaceAll(' + ', '+')).key).toBe('Enter')
    expect(parseShortcut('CTRL+SHIFT+TAB')).toMatchObject({ ctrl: true, shift: true, key: 'Tab' })
  })

  it('accepts the usual aliases', () => {
    expect(parseShortcut('Cmd+Option+Return')).toMatchObject({
      meta: true,
      alt: true,
      key: 'Enter',
    })
    expect(parseShortcut('CmdOrCtrl+1')).toMatchObject({ mod: true, key: '1' })
    expect(parseShortcut('Esc').key).toBe('Escape')
    expect(parseShortcut('Ctrl+Up').key).toBe('ArrowUp')
    expect(parseShortcut('Mod+Del').key).toBe('Delete')
    expect(parseShortcut('Mod+Plus').key).toBe('+')
  })

  it('accepts function keys, punctuation and the plus key', () => {
    expect(parseShortcut('F5').key).toBe('F5')
    expect(parseShortcut('Shift+F12').key).toBe('F12')
    expect(parseShortcut('Mod+,').key).toBe(',')
    expect(parseShortcut('Mod++')).toMatchObject({ mod: true, key: '+' })
    expect(parseShortcut('Mod+Space').key).toBe('Space')
  })

  it('freezes the result', () => {
    expect(Object.isFrozen(parseShortcut('Mod+K'))).toBe(true)
  })

  it.each([
    ['', 'vacío'],
    ['   ', 'vacío'],
    ['Mod+', 'falta la tecla'],
    ['Mod+Shift', 'solo tiene modificadores'],
    ['Mod+Mod+K', 'se repite'],
    ['Foo+K', 'no es un modificador'],
    ['Mod+Nope', 'tecla desconocida'],
    ['Mod+F25', 'tecla desconocida'],
    ['Mod++K', 'sobrante'],
    ['K', 'escribe texto'],
    ['Shift+K', 'escribe texto'],
    ['Space', 'escribe texto'],
    ['Mod+é', 'tecla desconocida'],
  ])('rejects %j with a clear message', (input, fragment) => {
    expect(() => parseShortcut(input)).toThrow(ShortcutSyntaxError)
    expect(() => parseShortcut(input)).toThrow(fragment)
  })

  it('does not treat prototype property names as modifiers or keys', () => {
    expect(() => parseShortcut('constructor+K')).toThrow('no es un modificador')
    expect(() => parseShortcut('Mod+constructor')).toThrow('tecla desconocida')
  })

  it('lets bare non-typing keys through', () => {
    expect(parseShortcut('Escape')).toMatchObject({ key: 'Escape', mod: false })
    expect(parseShortcut('Enter').key).toBe('Enter')
  })
})

describe('canonicalShortcut', () => {
  it('produces a stable form', () => {
    expect(canonicalShortcut(parseShortcut('shift+cmdorctrl+enter'))).toBe('Mod+Shift+Enter')
    expect(canonicalShortcut(parseShortcut('alt+ctrl+meta+mod+shift+k'))).toBe(
      'Mod+Ctrl+Meta+Alt+Shift+K',
    )
    expect(canonicalShortcut(parseShortcut('esc'))).toBe('Escape')
  })
})

describe('conflicts', () => {
  const chord = parseShortcut

  it('detects the same shortcut written differently', () => {
    expect(shortcutsConflict(chord('Mod+K'), chord('cmdorctrl+k'))).toBe(true)
    expect(shortcutsConflict(chord('Mod+Shift+Enter'), chord('Shift+Mod+Enter'))).toBe(true)
  })

  it('does not conflict with different keys or modifiers', () => {
    expect(shortcutsConflict(chord('Mod+K'), chord('Mod+P'))).toBe(false)
    expect(shortcutsConflict(chord('Mod+Enter'), chord('Mod+Shift+Enter'))).toBe(false)
  })

  it('Mod+K collides with Ctrl+K off macOS even though they differ on macOS', () => {
    expect(shortcutSignature(chord('Mod+K'), 'mac')).not.toBe(
      shortcutSignature(chord('Ctrl+K'), 'mac'),
    )
    expect(shortcutsConflict(chord('Mod+K'), chord('Ctrl+K'))).toBe(true)
    expect(shortcutsConflict(chord('Mod+K'), chord('Meta+K'))).toBe(true)
  })

  it('Ctrl+Tab does not conflict with Mod+Tab on macOS but does elsewhere', () => {
    expect(shortcutsConflict(chord('Ctrl+Tab'), chord('Mod+Tab'))).toBe(true)
    expect(shortcutSignature(chord('Ctrl+Tab'), 'mac')).toBe('C+Tab')
    expect(shortcutSignature(chord('Mod+Tab'), 'mac')).toBe('M+Tab')
    expect(shortcutSignature(chord('Mod+Tab'), 'windows')).toBe('C+Tab')
  })
})

describe('matchesShortcut', () => {
  const run = parseShortcut('Mod+Enter')

  it('uses Cmd on macOS and Ctrl elsewhere for Mod', () => {
    expect(matchesShortcut(run, event({ key: 'Enter', metaKey: true }), 'mac')).toBe(true)
    expect(matchesShortcut(run, event({ key: 'Enter', ctrlKey: true }), 'mac')).toBe(false)
    expect(matchesShortcut(run, event({ key: 'Enter', ctrlKey: true }), 'windows')).toBe(true)
    expect(matchesShortcut(run, event({ key: 'Enter', ctrlKey: true }), 'linux')).toBe(true)
    expect(matchesShortcut(run, event({ key: 'Enter', metaKey: true }), 'windows')).toBe(false)
  })

  it('requires exactly the declared modifiers', () => {
    expect(matchesShortcut(run, event({ key: 'Enter' }), 'mac')).toBe(false)
    expect(
      matchesShortcut(run, event({ key: 'Enter', metaKey: true, shiftKey: true }), 'mac'),
    ).toBe(false)
    expect(matchesShortcut(run, event({ key: 'Enter', metaKey: true, altKey: true }), 'mac')).toBe(
      false,
    )
    expect(matchesShortcut(run, event({ key: 'Enter', metaKey: true, ctrlKey: true }), 'mac')).toBe(
      false,
    )
    expect(
      matchesShortcut(
        parseShortcut('Mod+Shift+Enter'),
        event({ key: 'Enter', metaKey: true, shiftKey: true }),
        'mac',
      ),
    ).toBe(true)
  })

  it('matches explicit Ctrl on every platform', () => {
    const next = parseShortcut('Ctrl+Tab')
    expect(matchesShortcut(next, event({ key: 'Tab', ctrlKey: true }), 'mac')).toBe(true)
    expect(matchesShortcut(next, event({ key: 'Tab', ctrlKey: true }), 'windows')).toBe(true)
    expect(matchesShortcut(next, event({ key: 'Tab', metaKey: true }), 'mac')).toBe(false)
  })

  it('ignores the case of key, as with Caps Lock or Shift', () => {
    const palette = parseShortcut('Mod+K')
    expect(matchesShortcut(palette, event({ key: 'K', metaKey: true }), 'mac')).toBe(true)
    expect(matchesShortcut(palette, event({ key: 'k', metaKey: true }), 'mac')).toBe(true)
  })

  it('matches bare keys such as Escape and function keys', () => {
    expect(matchesShortcut(parseShortcut('Esc'), event({ key: 'Escape' }), 'mac')).toBe(true)
    expect(
      matchesShortcut(parseShortcut('Esc'), event({ key: 'Escape', ctrlKey: true }), 'mac'),
    ).toBe(false)
    expect(matchesShortcut(parseShortcut('F5'), event({ key: 'F5' }), 'windows')).toBe(true)
    expect(matchesShortcut(parseShortcut('F5'), event({ key: 'F6' }), 'windows')).toBe(false)
  })

  it('follows the character produced by the layout before the physical key (Dvorak)', () => {
    const palette = parseShortcut('Mod+K')
    // En Dvorak la tecla física V produce «k»: manda el carácter.
    expect(matchesShortcut(palette, event({ key: 'k', code: 'KeyV', metaKey: true }), 'mac')).toBe(
      true,
    )
    // ...y la tecla física K produce «t»: no debe abrir la paleta.
    expect(matchesShortcut(palette, event({ key: 't', code: 'KeyK', metaKey: true }), 'mac')).toBe(
      false,
    )
  })

  it('falls back to the physical key with non-Latin layouts', () => {
    const palette = parseShortcut('Mod+K')
    expect(matchesShortcut(palette, event({ key: 'л', code: 'KeyK', metaKey: true }), 'mac')).toBe(
      true,
    )
    expect(matchesShortcut(palette, event({ key: 'л', code: 'KeyL', metaKey: true }), 'mac')).toBe(
      false,
    )
    expect(matchesShortcut(palette, event({ key: 'л', metaKey: true }), 'mac')).toBe(false)
  })

  it('falls back to the physical key for characters altered by Option on macOS', () => {
    const format = parseShortcut('Alt+Shift+F')
    expect(
      matchesShortcut(
        format,
        event({ key: 'Ï', code: 'KeyF', altKey: true, shiftKey: true }),
        'mac',
      ),
    ).toBe(true)
  })

  it('matches digits by their character or by the physical key', () => {
    const third = parseShortcut('Mod+3')
    expect(matchesShortcut(third, event({ key: '3', code: 'Digit3', metaKey: true }), 'mac')).toBe(
      true,
    )
    // AZERTY sin Shift produce «"» en la tecla física del 3.
    expect(matchesShortcut(third, event({ key: '"', code: 'Digit3', metaKey: true }), 'mac')).toBe(
      true,
    )
    expect(matchesShortcut(third, event({ key: '4', code: 'Digit4', metaKey: true }), 'mac')).toBe(
      false,
    )
    expect(matchesShortcut(third, event({ key: '3', code: 'Numpad3', metaKey: true }), 'mac')).toBe(
      true,
    )
  })

  it('never lets an ASCII letter fall back to a different physical key', () => {
    const format = parseShortcut('Mod+L')
    expect(matchesShortcut(format, event({ key: 'p', code: 'KeyL', metaKey: true }), 'mac')).toBe(
      false,
    )
  })

  it('matches punctuation and space', () => {
    expect(matchesShortcut(parseShortcut('Mod+,'), event({ key: ',', metaKey: true }), 'mac')).toBe(
      true,
    )
    expect(
      matchesShortcut(
        parseShortcut('Mod+,'),
        event({ key: ';', code: 'Comma', metaKey: true }),
        'mac',
      ),
    ).toBe(true)
    expect(
      matchesShortcut(parseShortcut('Mod+Space'), event({ key: ' ', metaKey: true }), 'mac'),
    ).toBe(true)
    expect(
      matchesShortcut(parseShortcut('Mod+Space'), event({ key: 'a', metaKey: true }), 'mac'),
    ).toBe(false)
  })

  it('does not throw when the event has no code', () => {
    expect(
      matchesShortcut(parseShortcut('Mod+K'), event({ key: 'Dead', metaKey: true }), 'mac'),
    ).toBe(false)
  })
})

describe('formatShortcut', () => {
  it('uses Apple symbols in Apple order on macOS', () => {
    expect(formatShortcut(parseShortcut('Mod+K'), 'mac')).toBe('⌘K')
    expect(formatShortcut(parseShortcut('Mod+Shift+Enter'), 'mac')).toBe('⇧⌘↵')
    expect(formatShortcut(parseShortcut('Ctrl+Tab'), 'mac')).toBe('⌃⇥')
    expect(formatShortcut(parseShortcut('Ctrl+Shift+Tab'), 'mac')).toBe('⌃⇧⇥')
    expect(formatShortcut(parseShortcut('Ctrl+Alt+Shift+Mod+Up'), 'mac')).toBe('⌃⌥⇧⌘↑')
    expect(formatShortcut(parseShortcut('Esc'), 'mac')).toBe('Esc')
    expect(formatShortcut(parseShortcut('Mod+1'), 'mac')).toBe('⌘1')
  })

  it('spells the modifiers out on Windows and Linux', () => {
    expect(formatShortcut(parseShortcut('Mod+K'), 'windows')).toBe('Ctrl+K')
    expect(formatShortcut(parseShortcut('Mod+Shift+Enter'), 'linux')).toBe('Ctrl+Shift+Enter')
    expect(formatShortcut(parseShortcut('Ctrl+Tab'), 'windows')).toBe('Ctrl+Tab')
    expect(formatShortcut(parseShortcut('Meta+E'), 'windows')).toBe('Win+E')
    expect(formatShortcut(parseShortcut('Meta+E'), 'linux')).toBe('Super+E')
    expect(formatShortcut(parseShortcut('Alt+F5'), 'linux')).toBe('Alt+F5')
  })
})

describe('ariaKeyShortcut', () => {
  it('uses the WAI-ARIA names', () => {
    expect(ariaKeyShortcut(parseShortcut('Mod+Enter'), 'mac')).toBe('Meta+Enter')
    expect(ariaKeyShortcut(parseShortcut('Mod+Shift+Enter'), 'mac')).toBe('Meta+Shift+Enter')
    expect(ariaKeyShortcut(parseShortcut('Mod+Enter'), 'windows')).toBe('Control+Enter')
    expect(ariaKeyShortcut(parseShortcut('Esc'), 'mac')).toBe('Escape')
    expect(ariaKeyShortcut(parseShortcut('Mod+T'), 'linux')).toBe('Control+T')
  })
})

describe('detectPlatform', () => {
  it('recognises the platform from a user agent or navigator.platform', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac')
    expect(detectPlatform('MacIntel')).toBe('mac')
    expect(detectPlatform('Win32')).toBe('windows')
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
    expect(detectPlatform('')).toBe('linux')
  })
})
