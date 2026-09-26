/** Plataformas con atajos propios: macOS es la principal; Windows y Linux difieren solo en el nombre de la tecla Meta. */
export type Platform = 'mac' | 'windows' | 'linux'

/** Lo mínimo que se necesita de un `KeyboardEvent`: permite comprobar atajos sin DOM (tests, CLI). */
export interface KeyEventLike {
  key: string
  /** Tecla física (`KeyK`, `Digit1`…). Opcional: sin ella solo se compara `key`. */
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * Atajo ya analizado. `mod` es Cmd en macOS y Ctrl en el resto; `ctrl` y `meta` son explícitos y valen
 * lo mismo en todas las plataformas (p. ej. `Ctrl+Tab`). `key` es canónica: letras en minúscula
 * (`k`), teclas con nombre en formato `KeyboardEvent.key` (`Enter`, `Escape`, `ArrowUp`, `F5`).
 */
export interface Chord {
  readonly key: string
  readonly mod: boolean
  readonly ctrl: boolean
  readonly meta: boolean
  readonly alt: boolean
  readonly shift: boolean
}

export class ShortcutSyntaxError extends Error {
  constructor(
    readonly input: string,
    detail: string,
  ) {
    super(`Atajo «${input}» no válido: ${detail}`)
    this.name = 'ShortcutSyntaxError'
  }
}

type ModifierName = 'mod' | 'ctrl' | 'meta' | 'alt' | 'shift'

const MODIFIER_ALIASES: ReadonlyMap<string, ModifierName> = new Map([
  ['mod', 'mod'],
  ['cmdorctrl', 'mod'],
  ['commandorcontrol', 'mod'],
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['meta', 'meta'],
  ['cmd', 'meta'],
  ['command', 'meta'],
  ['super', 'meta'],
  ['win', 'meta'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['opt', 'alt'],
  ['shift', 'shift'],
])

const NAMED_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
] as const

const KEY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['esc', 'Escape'],
  ['return', 'Enter'],
  ['del', 'Delete'],
  ['ins', 'Insert'],
  ['spacebar', 'Space'],
  ['up', 'ArrowUp'],
  ['down', 'ArrowDown'],
  ['left', 'ArrowLeft'],
  ['right', 'ArrowRight'],
  ['pgup', 'PageUp'],
  ['pgdn', 'PageDown'],
  ['plus', '+'],
])

const NAMED_BY_LOWERCASE = new Map<string, string>(
  NAMED_KEYS.map((name) => [name.toLowerCase(), name]),
)

/** Puntuación que se admite como tecla, con su `KeyboardEvent.code` físico para distribuciones distintas. */
const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
  '+': 'Equal',
}

function canonicalKey(raw: string, input: string): string {
  if (raw === '') throw new ShortcutSyntaxError(input, 'falta la tecla')
  if (raw.length === 1) {
    if (/[a-z0-9]/i.test(raw)) return raw.toLowerCase()
    if (raw in PUNCTUATION_CODES) return raw
    if (raw === ' ') return 'Space'
    throw new ShortcutSyntaxError(input, `tecla desconocida «${raw}»`)
  }
  const lower = raw.toLowerCase()
  const aliased = KEY_ALIASES.get(lower)
  if (aliased) return aliased
  const named = NAMED_BY_LOWERCASE.get(lower)
  if (named) return named
  const fn = /^f([1-9]|1\d|2[0-4])$/.exec(lower)
  if (fn) return `F${fn[1]}`
  throw new ShortcutSyntaxError(input, `tecla desconocida «${raw}»`)
}

/** Teclas que escriben texto: sin un modificador que no sea Shift chocarían con la escritura normal. */
function typesText(key: string): boolean {
  return key.length === 1 || key === 'Space'
}

/**
 * Analiza `Mod+Shift+Enter`, `Ctrl+Tab`, `Esc`, `Mod+,`… Modificadores y teclas sin distinguir mayúsculas
 * (con alias habituales: `Cmd`, `Option`, `Esc`, `Return`). Lanza `ShortcutSyntaxError` si no es válido.
 */
export function parseShortcut(input: string): Chord {
  const text = input.trim()
  if (text === '') throw new ShortcutSyntaxError(input, 'está vacío')

  let keyPart: string
  let modifierPart: string
  if (text === '+') {
    keyPart = '+'
    modifierPart = ''
  } else if (text.endsWith('++')) {
    keyPart = '+'
    modifierPart = text.slice(0, -2)
  } else {
    const cut = text.lastIndexOf('+')
    keyPart = cut < 0 ? text : text.slice(cut + 1)
    modifierPart = cut < 0 ? '' : text.slice(0, cut)
  }

  const flags = { mod: false, ctrl: false, meta: false, alt: false, shift: false }
  if (modifierPart !== '') {
    for (const piece of modifierPart.split('+')) {
      const name = MODIFIER_ALIASES.get(piece.trim().toLowerCase())
      if (!name) {
        throw new ShortcutSyntaxError(
          input,
          piece.trim() === ''
            ? 'hay un «+» sobrante'
            : `«${piece.trim()}» no es un modificador (usa Mod, Ctrl, Alt, Shift o Meta)`,
        )
      }
      if (flags[name])
        throw new ShortcutSyntaxError(input, `el modificador «${piece.trim()}» se repite`)
      flags[name] = true
    }
  }

  if (MODIFIER_ALIASES.has(keyPart.trim().toLowerCase())) {
    throw new ShortcutSyntaxError(input, 'solo tiene modificadores: falta la tecla')
  }
  const key = canonicalKey(keyPart.trim(), input)
  if (typesText(key) && !flags.mod && !flags.ctrl && !flags.meta && !flags.alt) {
    throw new ShortcutSyntaxError(
      input,
      `«${key}» escribe texto: necesita Mod, Ctrl, Alt o Meta además de la tecla`,
    )
  }
  return Object.freeze({ key, ...flags })
}

/** Forma canónica y estable (`Mod+Shift+Enter`): sirve para comparar y para mostrar errores. */
export function canonicalShortcut(chord: Chord): string {
  const parts: string[] = []
  if (chord.mod) parts.push('Mod')
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.meta) parts.push('Meta')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return parts.join('+')
}

interface ResolvedModifiers {
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

function resolveModifiers(chord: Chord, platform: Platform): ResolvedModifiers {
  const mac = platform === 'mac'
  return {
    meta: chord.meta || (mac && chord.mod),
    ctrl: chord.ctrl || (!mac && chord.mod),
    alt: chord.alt,
    shift: chord.shift,
  }
}

/** Firma del atajo en una plataforma concreta: dos atajos con la misma firma se pisan. */
export function shortcutSignature(chord: Chord, platform: Platform): string {
  const { meta, ctrl, alt, shift } = resolveModifiers(chord, platform)
  return `${meta ? 'M' : ''}${ctrl ? 'C' : ''}${alt ? 'A' : ''}${shift ? 'S' : ''}+${chord.key}`
}

/** ¿Chocan dos atajos en alguna plataforma? Mod+K y Ctrl+K chocan fuera de macOS aunque no en macOS. */
export function shortcutsConflict(a: Chord, b: Chord): boolean {
  return (['mac', 'windows'] as const).some(
    (platform) => shortcutSignature(a, platform) === shortcutSignature(b, platform),
  )
}

const ASCII_ALNUM = /^[a-z0-9]$/i

function codeToKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!.toLowerCase()
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)
  if (digit) return digit[1]!
  for (const [char, name] of Object.entries(PUNCTUATION_CODES)) {
    if (name === code && char !== '+') return char
  }
  return null
}

/**
 * ¿La tecla del evento es la del atajo? Se compara primero el carácter producido (`key`), que respeta
 * la disposición del teclado (Dvorak, AZERTY). Solo cuando `key` no es un carácter ASCII alfanumérico —
 * otro alfabeto, una tecla muerta, el carácter que produce Option en macOS o el símbolo de una
 * tecla con Shift — se recurre a la tecla física (`code`).
 */
function keyMatches(chord: Chord, event: KeyEventLike): boolean {
  const produced = event.key
  if (produced === ' ' || produced === 'Spacebar') return chord.key === 'Space'
  if (produced.length === 1) {
    if (ASCII_ALNUM.test(produced) || produced in PUNCTUATION_CODES) {
      if (produced.toLowerCase() === chord.key) return true
      if (ASCII_ALNUM.test(produced)) return false
    }
  } else {
    const named =
      KEY_ALIASES.get(produced.toLowerCase()) ?? NAMED_BY_LOWERCASE.get(produced.toLowerCase())
    if (named) return named === chord.key
    if (/^F([1-9]|1\d|2[0-4])$/.test(produced)) return produced === chord.key
  }
  return event.code !== undefined && codeToKey(event.code) === chord.key
}

/** Coincidencia exacta: los modificadores del evento deben ser justo los del atajo, ni más ni menos. */
export function matchesShortcut(chord: Chord, event: KeyEventLike, platform: Platform): boolean {
  const wanted = resolveModifiers(chord, platform)
  return (
    event.metaKey === wanted.meta &&
    event.ctrlKey === wanted.ctrl &&
    event.altKey === wanted.alt &&
    event.shiftKey === wanted.shift &&
    keyMatches(chord, event)
  )
}

const MAC_KEY_SYMBOLS: Readonly<Record<string, string>> = {
  Enter: '↵',
  Escape: 'Esc',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
}

function displayKey(key: string, platform: Platform): string {
  if (platform === 'mac')
    return MAC_KEY_SYMBOLS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * Texto para mostrar: `⌘K`, `⇧⌘↵` y `⌃⇥` en macOS (orden ⌃⌥⇧⌘ de Apple); `Ctrl+K`, `Ctrl+Shift+Enter`
 * en Windows y Linux.
 */
export function formatShortcut(chord: Chord, platform: Platform): string {
  const { meta, ctrl, alt, shift } = resolveModifiers(chord, platform)
  if (platform === 'mac') {
    return `${ctrl ? '⌃' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${meta ? '⌘' : ''}${displayKey(chord.key, platform)}`
  }
  const parts: string[] = []
  if (ctrl) parts.push('Ctrl')
  if (meta) parts.push(platform === 'windows' ? 'Win' : 'Super')
  if (alt) parts.push('Alt')
  if (shift) parts.push('Shift')
  parts.push(displayKey(chord.key, platform))
  return parts.join('+')
}

/** Valor para `aria-keyshortcuts` (`Meta+Shift+Enter`, `Control+K`, `Escape`). */
export function ariaKeyShortcut(chord: Chord, platform: Platform): string {
  const { meta, ctrl, alt, shift } = resolveModifiers(chord, platform)
  const parts: string[] = []
  if (ctrl) parts.push('Control')
  if (meta) parts.push('Meta')
  if (alt) parts.push('Alt')
  if (shift) parts.push('Shift')
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return parts.join('+')
}

/** Plataforma a partir de un `navigator.platform`/user agent; lo desconocido cuenta como Linux. */
export function detectPlatform(identifier: string): Platform {
  if (/Mac|iPhone|iPad|iPod/i.test(identifier)) return 'mac'
  if (/Win/i.test(identifier)) return 'windows'
  return 'linux'
}
