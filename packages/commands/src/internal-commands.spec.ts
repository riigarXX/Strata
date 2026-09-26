import { describe, expect, it } from 'vitest'
import {
  analyzeInternalInput,
  buildInternalInput,
  closestMatches,
  findInternalSpec,
  INTERNAL_COMMANDS,
  isInternalInput,
  parseInternalCommand,
  quoteArgument,
  tokenize,
  usageOf,
} from './internal-commands'

function ok(input: string) {
  const result = parseInternalCommand(input)
  if (!result.ok) throw new Error(`se esperaba éxito: ${result.error.message}`)
  return result.invocation
}

function error(input: string) {
  const result = parseInternalCommand(input)
  if (result.ok) throw new Error('se esperaba un error')
  return result.error
}

describe('the command catalogue', () => {
  it('has exactly the eleven initial commands', () => {
    expect(INTERNAL_COMMANDS.map((spec) => spec.name)).toEqual([
      'connect',
      'disconnect',
      'connections',
      'schemas',
      'tables',
      'describe',
      'history',
      'ask',
      'timing',
      'clear',
      'theme',
    ])
  })

  it('documents each command in Spanish and prints their usage', () => {
    for (const spec of INTERNAL_COMMANDS) expect(spec.description).toMatch(/\S/)
    expect(usageOf(findInternalSpec('connect')!)).toBe('\\connect <nombre>')
    expect(usageOf(findInternalSpec('tables')!)).toBe('\\tables [schema]')
    expect(usageOf(findInternalSpec('describe')!)).toBe('\\describe <tabla>')
    expect(usageOf(findInternalSpec('theme')!)).toBe('\\theme <dark|light|system>')
    expect(usageOf(findInternalSpec('timing')!)).toBe('\\timing [on|off]')
    expect(usageOf(findInternalSpec('clear')!)).toBe('\\clear')
  })

  it('finds specs regardless of case', () => {
    expect(findInternalSpec('CONNECT')?.name).toBe('connect')
    expect(findInternalSpec('nope')).toBeUndefined()
    expect(findInternalSpec('constructor')).toBeUndefined()
  })
})

describe('parseInternalCommand: valid input', () => {
  it.each([
    ['\\connect Producción', { command: 'connect', args: { name: 'Producción' } }],
    ['\\disconnect', { command: 'disconnect', args: {} }],
    ['\\connections', { command: 'connections', args: {} }],
    ['\\schemas', { command: 'schemas', args: {} }],
    ['\\tables', { command: 'tables', args: {} }],
    ['\\tables public', { command: 'tables', args: { schema: 'public' } }],
    ['\\describe users', { command: 'describe', args: { table: 'users' } }],
    ['\\describe public.users', { command: 'describe', args: { table: 'public.users' } }],
    ['\\history', { command: 'history', args: {} }],
    ['\\ask', { command: 'ask', args: {} }],
    ['\\timing', { command: 'timing', args: {} }],
    ['\\timing on', { command: 'timing', args: { mode: 'on' } }],
    ['\\timing OFF', { command: 'timing', args: { mode: 'off' } }],
    ['\\clear', { command: 'clear', args: {} }],
    ['\\theme dark', { command: 'theme', args: { mode: 'dark' } }],
    ['\\theme Light', { command: 'theme', args: { mode: 'light' } }],
    ['\\theme SYSTEM', { command: 'theme', args: { mode: 'system' } }],
  ])('parses %j', (input, expected) => {
    expect(ok(input)).toEqual(expected)
  })

  it('ignores case in the command name and surrounding whitespace', () => {
    expect(ok('  \\TABLES   public  ')).toEqual({ command: 'tables', args: { schema: 'public' } })
    expect(ok('\\Clear\t')).toEqual({ command: 'clear', args: {} })
  })

  it('accepts quoted arguments with spaces, single or double quotes', () => {
    expect(ok('\\connect "Mi base local"')).toEqual({
      command: 'connect',
      args: { name: 'Mi base local' },
    })
    expect(ok("\\connect 'Mi base local'")).toEqual({
      command: 'connect',
      args: { name: 'Mi base local' },
    })
    expect(ok('\\describe "mi esquema.mi tabla"')).toEqual({
      command: 'describe',
      args: { table: 'mi esquema.mi tabla' },
    })
  })

  it('unescapes quotes and backslashes inside quotes', () => {
    expect(ok('\\connect "dijo \\"hola\\""')).toEqual({
      command: 'connect',
      args: { name: 'dijo "hola"' },
    })
    expect(ok('\\connect "ruta\\\\a"')).toEqual({ command: 'connect', args: { name: 'ruta\\a' } })
    expect(ok('\\connect "a\\nb"')).toEqual({ command: 'connect', args: { name: 'a\\nb' } })
  })

  it('treats a quote in the middle of a word as a literal', () => {
    expect(ok("\\connect O'Brien")).toEqual({ command: 'connect', args: { name: "O'Brien" } })
  })

  it('accepts an explicit empty quoted argument as a value', () => {
    expect(ok('\\connect ""')).toEqual({ command: 'connect', args: { name: '' } })
  })

  it('is the inverse of buildInternalInput', () => {
    for (const name of ['Producción', 'Mi base local', 'con "comillas"', "O'Brien", 'a\\b', '']) {
      expect(ok(buildInternalInput('connect', [name]))).toEqual({
        command: 'connect',
        args: { name },
      })
    }
  })
})

describe('parseInternalCommand: errors', () => {
  it('rejects input that is not a command', () => {
    const failure = error('select 1')
    expect(failure.code).toBe('not-internal')
    expect(failure.message).toContain('empiezan por')
  })

  it('asks for a name after a bare backslash and lists the commands', () => {
    for (const input of ['\\', '  \\  ', '\\ connect']) {
      const failure = error(input)
      expect(failure.code).toBe('empty')
      expect(failure.suggestions).toContain('\\connect')
      expect(failure.suggestions).toHaveLength(INTERNAL_COMMANDS.length)
    }
  })

  it('suggests the closest commands for an unknown one', () => {
    const typo = error('\\tabels')
    expect(typo.code).toBe('unknown-command')
    expect(typo.suggestions).toEqual(['\\tables'])
    expect(typo.message).toBe('Comando desconocido «\\tabels». ¿Quisiste decir \\tables?')

    expect(error('\\conect').suggestions).toEqual(['\\connect'])
    expect(error('\\themes').suggestions).toEqual(['\\theme'])
  })

  it('suggests by prefix, closest first, at most three', () => {
    const prefix = error('\\con')
    expect(prefix.suggestions).toEqual(['\\connect', '\\connections'])
    const many = error('\\c')
    expect(many.suggestions.length).toBeLessThanOrEqual(3)
    expect(many.suggestions[0]).toBe('\\clear')
  })

  it('falls back to a generic hint when nothing is similar', () => {
    const failure = error('\\zzzzzzzz')
    expect(failure.code).toBe('unknown-command')
    expect(failure.suggestions).toEqual([])
    expect(failure.message).toContain('Escribe \\ para ver los comandos disponibles')
  })

  it('reports a missing required argument with the usage', () => {
    const connect = error('\\connect')
    expect(connect).toMatchObject({ code: 'missing-argument', command: 'connect' })
    expect(connect.message).toContain('\\connect <nombre>')
    expect(connect.message).toContain('Nombre de la conexión')
    expect(error('\\describe').code).toBe('missing-argument')
    expect(error('\\theme').message).toContain('\\theme <dark|light|system>')
  })

  it('reports too many arguments and hints at quotes when the value may have spaces', () => {
    const connect = error('\\connect Mi base local')
    expect(connect).toMatchObject({ code: 'too-many-arguments', command: 'connect' })
    expect(connect.message).toContain('un solo argumento')
    expect(connect.message).toContain('\\connect "Mi base local"')

    const none = error('\\disconnect ahora')
    expect(none.code).toBe('too-many-arguments')
    expect(none.message).toBe('\\disconnect no admite argumentos. Uso: \\disconnect')

    const theme = error('\\theme dark light')
    expect(theme.code).toBe('too-many-arguments')
    expect(theme.message).not.toContain('comillas')
  })

  it('rejects values outside the allowed set and suggests the nearest', () => {
    const theme = error('\\theme oscuro')
    expect(theme).toMatchObject({ code: 'invalid-argument', command: 'theme' })
    expect(theme.message).toContain('«oscuro»')
    expect(theme.message).toContain('dark, light, system')

    expect(error('\\theme dar').suggestions).toEqual(['dark'])
    expect(error('\\theme ligth').suggestions).toEqual(['light'])
    expect(error('\\theme sys').suggestions).toEqual(['system'])
    expect(error('\\timing maybe')).toMatchObject({ code: 'invalid-argument' })
    expect(error('\\timing o').suggestions).toEqual(['on', 'off'])
  })

  it('reports unterminated quotes', () => {
    const failure = error('\\connect "Mi base')
    expect(failure).toMatchObject({ code: 'unterminated-quote', command: 'connect' })
    expect(failure.message).toContain('comillas')
    expect(error("\\connect 'abc").message).toContain("(')")
  })
})

describe('tokenize', () => {
  it('reports absolute positions including the opening quote', () => {
    const { tokens } = tokenize(' abc "d e" f', 10)
    expect(tokens).toEqual([
      { value: 'abc', start: 11, end: 14, quoted: false },
      { value: 'd e', start: 15, end: 20, quoted: true },
      { value: 'f', start: 21, end: 22, quoted: false },
    ])
  })

  it('flags an unterminated quote and trailing whitespace', () => {
    expect(tokenize('"abc').unterminated).toBe('"')
    expect(tokenize('abc ').trailingSpace).toBe(true)
    expect(tokenize('abc').trailingSpace).toBe(false)
    expect(tokenize('').tokens).toEqual([])
    expect(tokenize('').trailingSpace).toBe(false)
  })

  it('keeps text glued to a closing quote in the same token', () => {
    expect(tokenize('"a b"c').tokens[0]?.value).toBe('a bc')
  })
})

describe('quoteArgument / buildInternalInput', () => {
  it('quotes only when needed', () => {
    expect(quoteArgument('public')).toBe('public')
    expect(quoteArgument('Mi base')).toBe('"Mi base"')
    expect(quoteArgument('dijo "hola"')).toBe('"dijo \\"hola\\""')
    expect(quoteArgument('')).toBe('""')
    expect(quoteArgument("O'Brien")).toBe('"O\'Brien"')
  })

  it('builds the canonical input of a command', () => {
    expect(buildInternalInput('connect', ['Mi base'])).toBe('\\connect "Mi base"')
    expect(buildInternalInput('tables')).toBe('\\tables')
    expect(buildInternalInput('theme', ['dark'])).toBe('\\theme dark')
  })
})

describe('closestMatches', () => {
  it('orders prefixes before typos and respects the limit', () => {
    expect(closestMatches('tab', ['tables', 'table', 'tab'])).toEqual(['tab', 'table', 'tables'])
    expect(closestMatches('tab', ['tables', 'table', 'tab'], 2)).toEqual(['tab', 'table'])
    expect(closestMatches('xyz', ['tables'])).toEqual([])
    expect(closestMatches('', ['a', 'b'])).toEqual([])
  })

  it('ignores case', () => {
    expect(closestMatches('DAR', ['dark', 'light'])).toEqual(['dark'])
  })
})

describe('isInternalInput', () => {
  it('detects the prefix after optional whitespace', () => {
    expect(isInternalInput('\\tables')).toBe(true)
    expect(isInternalInput('  \\')).toBe(true)
    expect(isInternalInput('tables')).toBe(false)
    expect(isInternalInput('')).toBe(false)
  })
})

describe('analyzeInternalInput', () => {
  it('is not internal without the prefix', () => {
    expect(analyzeInternalInput('conectar')).toEqual({ stage: 'not-internal' })
    expect(analyzeInternalInput('')).toEqual({ stage: 'not-internal' })
  })

  it('is in the command stage while the name has no trailing space', () => {
    expect(analyzeInternalInput('\\')).toEqual({ stage: 'command', typed: '' })
    expect(analyzeInternalInput('\\ta')).toEqual({ stage: 'command', typed: 'ta' })
    expect(analyzeInternalInput('  \\tables')).toEqual({ stage: 'command', typed: 'tables' })
  })

  it('reports an unknown command once it is followed by a space', () => {
    expect(analyzeInternalInput('\\tabels ')).toEqual({
      stage: 'unknown',
      typed: 'tabels',
      suggestions: ['\\tables'],
    })
  })

  it('locates the first argument right after the command', () => {
    const context = analyzeInternalInput('\\connect ')
    expect(context).toMatchObject({
      stage: 'argument',
      index: 0,
      previous: [],
      typed: '',
      replaceFrom: '\\connect '.length,
    })
    if (context.stage === 'argument') expect(context.param?.key).toBe('name')
  })

  it('tracks what is typed and where to replace it', () => {
    const context = analyzeInternalInput('\\connect Pro')
    expect(context).toMatchObject({ stage: 'argument', index: 0, typed: 'Pro', replaceFrom: 9 })
  })

  it('handles a quoted argument being typed', () => {
    const context = analyzeInternalInput('\\connect "Mi ba')
    expect(context).toMatchObject({ stage: 'argument', index: 0, typed: 'Mi ba', replaceFrom: 9 })
  })

  it('counts completed arguments and finds params beyond the allowed ones', () => {
    const second = analyzeInternalInput('\\timing on ')
    expect(second).toMatchObject({ stage: 'argument', index: 1, previous: ['on'], typed: '' })
    if (second.stage === 'argument') expect(second.param).toBeUndefined()

    const next = analyzeInternalInput('\\connect "Mi base" x')
    expect(next).toMatchObject({ stage: 'argument', index: 1, previous: ['Mi base'], typed: 'x' })
  })

  it('exposes the choices of the current parameter', () => {
    const context = analyzeInternalInput('\\theme d')
    expect(context.stage).toBe('argument')
    if (context.stage === 'argument')
      expect(context.param?.choices).toEqual(['dark', 'light', 'system'])
  })

  it('knows about commands without parameters', () => {
    const context = analyzeInternalInput('\\clear ')
    expect(context).toMatchObject({ stage: 'argument', index: 0 })
    if (context.stage === 'argument') expect(context.param).toBeUndefined()
  })
})
