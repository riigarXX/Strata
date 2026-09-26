import { defaultKeymap, historyKeymap } from '@codemirror/commands'
import { CommandRegistry, disabled, type KeyEventLike, type Platform } from '@strata/commands'
import { describe, expect, it } from 'vitest'
import type { AppCommandContext } from '../model/context'
import { CATEGORY_ORDER } from '.'
import { APP_COMMANDS } from '.'

const noActions = new Proxy({}, { get: () => () => undefined }) as AppCommandContext['actions']

function makeContext(overrides: Partial<AppCommandContext> = {}): AppCommandContext {
  return {
    tabs: { count: 0, activeIndex: -1 },
    connections: [],
    activeConnection: null,
    schema: null,
    execution: null,
    editorReady: false,
    preferences: { theme: 'system', showTiming: true },
    paletteOpen: false,
    actions: noActions,
    ...overrides,
  }
}

function makeRegistry(context = makeContext()) {
  const registry = new CommandRegistry<AppCommandContext>({ context: () => context })
  registry.registerAll(APP_COMMANDS)
  return registry
}

const key = (init: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
})

describe('the application catalogue', () => {
  it('registers without id or shortcut conflicts', () => {
    expect(() => makeRegistry()).not.toThrow()
  })

  it('gives every command Spanish title, description and a known category', () => {
    for (const command of APP_COMMANDS) {
      expect(command.title.trim(), command.id).not.toBe('')
      expect(command.description.trim(), command.id).not.toBe('')
      expect(CATEGORY_ORDER, command.id).toContain(command.category)
    }
  })

  it('declares every requested action', () => {
    const ids = APP_COMMANDS.map((command) => command.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'tab.new',
        'tab.close',
        'tab.next',
        'tab.previous',
        'tab.select.1',
        'tab.select.8',
        'tab.select.last',
        'query.run',
        'query.runAll',
        'query.cancel',
        'query.settings',
        'settings.open',
        'settings.ai',
        'transaction.begin',
        'transaction.commit',
        'transaction.rollback',
        'editor.format',
        'editor.focus',
        'schema.refresh',
        'connection.manage',
        'connection.connect',
        'connection.disconnect',
        'palette.open',
        'palette.goto',
      ]),
    )
  })

  it('lists no hidden command in the palette but keeps them executable by shortcut', () => {
    const registry = makeRegistry()
    const visible = registry.list().map((command) => command.id)
    expect(visible).not.toContain('tab.select.3')
    expect(visible).not.toContain('palette.open')
    expect(registry.get('tab.select.3')).toBeDefined()
  })

  it('registers \\history enabled from anywhere, with its internal name and Mod+Shift+H', () => {
    const registry = makeRegistry()
    expect(registry.availability('history.open')).toEqual({ enabled: true })
    expect(registry.findByInternal('history')?.id).toBe('history.open')
    expect(registry.get('history.open')?.shortcuts).toEqual(['Mod+Shift+H'])
  })
})

describe('shortcut parity with the previous ad hoc handlers', () => {
  const registry = makeRegistry()
  const at = (event: KeyEventLike, platform: Platform = 'mac') =>
    registry.findByKey(event, platform)?.id ?? null

  it('maps Cmd+T and Cmd+W on macOS and Ctrl+T/W elsewhere, not the wrong modifier', () => {
    expect(at(key({ key: 't', metaKey: true }))).toBe('tab.new')
    expect(at(key({ key: 'w', metaKey: true }))).toBe('tab.close')
    expect(at(key({ key: 't', ctrlKey: true }), 'windows')).toBe('tab.new')
    expect(at(key({ key: 'w', ctrlKey: true }), 'linux')).toBe('tab.close')
    expect(at(key({ key: 't', ctrlKey: true }))).toBeNull()
    expect(at(key({ key: 't', metaKey: true }), 'windows')).toBeNull()
  })

  it('is case insensitive for the letter (Caps Lock)', () => {
    expect(at(key({ key: 'W', metaKey: true }))).toBe('tab.close')
  })

  it('maps Ctrl+Tab and Ctrl+Shift+Tab on any platform', () => {
    for (const platform of ['mac', 'windows', 'linux'] as const) {
      expect(at(key({ key: 'Tab', ctrlKey: true }), platform)).toBe('tab.next')
      expect(at(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), platform)).toBe('tab.previous')
    }
  })

  it('maps Cmd+1..8 to positions and Cmd+9 to the last tab', () => {
    expect(at(key({ key: '1', code: 'Digit1', metaKey: true }))).toBe('tab.select.1')
    expect(at(key({ key: '8', code: 'Digit8', metaKey: true }))).toBe('tab.select.8')
    expect(at(key({ key: '9', code: 'Digit9', metaKey: true }))).toBe('tab.select.last')
  })

  it('resolves digits by physical key on layouts where the digit needs Shift', () => {
    expect(at(key({ key: '&', code: 'Digit1', metaKey: true }))).toBe('tab.select.1')
  })

  it('ignores Cmd+0, Alt combinations, Cmd+Shift+T and unrelated keys', () => {
    expect(at(key({ key: '0', code: 'Digit0', metaKey: true }))).toBeNull()
    expect(at(key({ key: 't', metaKey: true, altKey: true }))).toBeNull()
    expect(at(key({ key: 'T', metaKey: true, shiftKey: true }))).toBeNull()
    expect(at(key({ key: 't' }))).toBeNull()
    expect(at(key({ key: 'Tab' }))).toBeNull()
  })

  it('Cmd+Enter runs and Shift+Cmd+Enter runs the whole document on macOS', () => {
    expect(at(key({ key: 'Enter', metaKey: true }))).toBe('query.run')
    expect(at(key({ key: 'Enter', metaKey: true, shiftKey: true }))).toBe('query.runAll')
  })

  it('uses Ctrl for the execution shortcuts outside macOS and ignores the other modifier', () => {
    expect(at(key({ key: 'Enter', ctrlKey: true }), 'windows')).toBe('query.run')
    expect(at(key({ key: 'Enter', metaKey: true }), 'windows')).toBeNull()
    expect(at(key({ key: 'Enter', ctrlKey: true }))).toBeNull()
  })

  it('plain Enter and Alt combinations are not shortcuts', () => {
    expect(at(key({ key: 'Enter' }))).toBeNull()
    expect(at(key({ key: 'Enter', metaKey: true, altKey: true }))).toBeNull()
  })

  it('a bare Escape cancels; Escape with a modifier does not', () => {
    expect(at(key({ key: 'Escape' }))).toBe('query.cancel')
    expect(at(key({ key: 'Escape', metaKey: true }))).toBeNull()
    expect(at(key({ key: 'Escape', shiftKey: true }))).toBeNull()
  })

  it('declares Escape as pass-through so it never consumes the event', () => {
    expect(registry.get('query.cancel')?.keyboard.passthrough).toBe(true)
  })

  it('maps the new global shortcuts', () => {
    expect(at(key({ key: 'k', metaKey: true }))).toBe('palette.open')
    expect(at(key({ key: 'p', metaKey: true }))).toBe('palette.goto')
    expect(at(key({ key: 'l', metaKey: true }))).toBe('editor.focus')
    expect(at(key({ key: 'k', ctrlKey: true }), 'windows')).toBe('palette.open')
    expect(at(key({ key: 'Ï', code: 'KeyF', altKey: true, shiftKey: true }))).toBe('editor.format')
  })

  it('lets the palette commands work while the palette is open and nothing else', () => {
    const modalSafe = registry
      .list({ includeHidden: true })
      .filter((command) => command.keyboard.whileModal)
      .map((command) => command.id)
    expect(modalSafe.sort()).toEqual(['palette.goto', 'palette.open'])
  })

  it('repeats only the tab-cycling shortcuts', () => {
    const repeating = registry
      .list({ includeHidden: true })
      .filter((command) => command.keyboard.repeat)
      .map((command) => command.id)
    expect(repeating.sort()).toEqual(['tab.next', 'tab.previous'])
  })
})

describe('preconditions', () => {
  it('needs a tab, a connection or a loaded schema, and says so', () => {
    const registry = makeRegistry()
    expect(registry.availability('tab.close')).toEqual(disabled('No hay ninguna pestaña abierta'))
    expect(registry.availability('editor.focus')).toEqual(
      disabled('No hay ninguna pestaña abierta'),
    )
    expect(registry.availability('connection.disconnect')).toEqual(
      disabled('Requiere una conexión activa'),
    )
    expect(registry.availability('schema.refresh')).toEqual(
      disabled('Requiere una conexión activa'),
    )
    expect(registry.availability('connection.connect')).toEqual(
      disabled('No hay conexiones guardadas'),
    )
    expect(registry.availability('tab.new')).toEqual({ enabled: true })
  })

  it('checks how many tabs there are for cycling and numbered access', () => {
    const one = makeRegistry(makeContext({ tabs: { count: 1, activeIndex: 0 } }))
    expect(one.availability('tab.next')).toEqual(disabled('Solo hay una pestaña abierta'))
    expect(one.availability('tab.select.2')).toEqual(disabled('No existe la pestaña 2'))
    expect(one.availability('tab.select.1')).toEqual({ enabled: true })
    expect(one.availability('tab.select.last')).toEqual({ enabled: true })
    const none = makeRegistry()
    expect(none.availability('tab.next')).toEqual(disabled('No hay ninguna pestaña abierta'))
  })

  it('takes execution commands from the same availability as the toolbar buttons', () => {
    const blocked = { enabled: false, reason: 'Hay una ejecución en curso.' } as const
    const enabled = { enabled: true, reason: null } as const
    const registry = makeRegistry(
      makeContext({
        tabs: { count: 1, activeIndex: 0 },
        execution: {
          idle: false,
          canExcludeFromHistory: false,
          availability: {
            run: blocked,
            'run-all': blocked,
            cancel: enabled,
            begin: blocked,
            commit: blocked,
            rollback: blocked,
          },
        },
      }),
    )
    expect(registry.availability('query.run')).toEqual(disabled('Hay una ejecución en curso.'))
    expect(registry.availability('query.cancel')).toEqual({ enabled: true })
    expect(registry.availability('transaction.begin').enabled).toBe(false)
    expect(registry.availability('results.clear')).toEqual(disabled('Hay una ejecución en curso'))
  })
})

describe('history command', () => {
  const at = (event: KeyEventLike, platform: Platform = 'mac') =>
    makeRegistry().findByKey(event, platform)?.id ?? null

  it('maps Cmd+Shift+H on macOS and Ctrl+Shift+H elsewhere, and no other modifier set', () => {
    expect(at(key({ key: 'H', code: 'KeyH', metaKey: true, shiftKey: true }))).toBe('history.open')
    expect(at(key({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true }), 'windows')).toBe(
      'history.open',
    )
    expect(at(key({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(at(key({ key: 'h', code: 'KeyH', metaKey: true }))).toBeNull()
    expect(
      at(key({ key: 'H', code: 'KeyH', metaKey: true, shiftKey: true, altKey: true })),
    ).toBeNull()
  })

  it('does not steal a shortcut from any other command', () => {
    const others = APP_COMMANDS.filter((command) => command.id !== 'history.open').flatMap(
      (command) => command.shortcuts ?? [],
    )
    expect(others).not.toContain('Mod+Shift+H')
    expect(() => makeRegistry()).not.toThrow()
  })

  it('opens the history panel and is not tied to any tab', async () => {
    let opened = 0
    const actions = {
      ...noActions,
      openHistory: () => void (opened += 1),
    } as AppCommandContext['actions']
    const registry = makeRegistry(makeContext({ actions }))

    expect(await registry.execute('history.open')).toMatchObject({ ok: true })
    expect(opened).toBe(1)
  })
})

describe('ask command', () => {
  const at = (event: KeyEventLike, platform: Platform = 'mac') =>
    makeRegistry().findByKey(event, platform)?.id ?? null

  it('maps Cmd+Shift+A on macOS and Ctrl+Shift+A elsewhere, and no other modifier set', () => {
    expect(at(key({ key: 'A', code: 'KeyA', metaKey: true, shiftKey: true }))).toBe('ask.open')
    expect(at(key({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true }), 'windows')).toBe(
      'ask.open',
    )
    expect(at(key({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(at(key({ key: 'a', code: 'KeyA', metaKey: true }))).toBeNull()
    expect(
      at(key({ key: 'A', code: 'KeyA', metaKey: true, shiftKey: true, altKey: true })),
    ).toBeNull()
  })

  it('does not steal a shortcut from any other command', () => {
    const others = APP_COMMANDS.filter((command) => command.id !== 'ask.open').flatMap(
      (command) => command.shortcuts ?? [],
    )
    expect(others).not.toContain('Mod+Shift+A')
    expect(() => makeRegistry()).not.toThrow()
  })

  it('does not collide with any CodeMirror binding of the editor', () => {
    const chords = defaultKeymap
      .flatMap((binding) => [binding.key, binding.mac, binding.win, binding.linux])
      .concat(historyKeymap.flatMap((binding) => [binding.key, binding.mac, binding.win]))
      .flatMap((chord) => (chord ? [chord] : []))
      .filter((chord) => /(^|-)a$/i.test(chord))
    for (const chord of chords) {
      const parts = chord.toLowerCase().split('-')
      const withShift = parts.includes('shift') || chord.endsWith('A')
      const withMod = parts.includes('mod') || parts.includes('cmd') || parts.includes('meta')
      expect(withShift && withMod, `CodeMirror ya usa ${chord}`).toBe(false)
    }
  })

  it('is the declared shortcut of «Preguntar a la base…», which has the \\ask internal name', () => {
    const registry = makeRegistry()
    expect(registry.get('ask.open')?.title).toBe('Preguntar a la base…')
    expect(registry.get('ask.open')?.shortcuts).toEqual(['Mod+Shift+A'])
    expect(registry.findByInternal('ask')?.id).toBe('ask.open')
    expect(registry.get('ask.open')?.keywords).toEqual(
      expect.arrayContaining(['ia', 'preguntar', 'lenguaje natural']),
    )
  })

  it('is available from anywhere (the dialog explains what is missing) and opens the dialog', async () => {
    let opened = 0
    const actions = {
      ...noActions,
      openAsk: () => void (opened += 1),
    } as AppCommandContext['actions']
    const registry = makeRegistry(makeContext({ actions }))

    expect(registry.availability('ask.open')).toEqual({ enabled: true })
    expect(await registry.execute('ask.open')).toMatchObject({ ok: true })
    expect(opened).toBe(1)
  })
})

describe('exclude-from-history command', () => {
  const withExecution = (canExcludeFromHistory: boolean, actions = noActions) => {
    const enabled = { enabled: true, reason: null } as const
    return makeRegistry(
      makeContext({
        tabs: { count: 1, activeIndex: 0 },
        actions: actions as AppCommandContext['actions'],
        execution: {
          idle: true,
          canExcludeFromHistory,
          availability: {
            run: enabled,
            'run-all': enabled,
            cancel: enabled,
            begin: enabled,
            commit: enabled,
            rollback: enabled,
          },
        },
      }),
    )
  }

  it('has no shortcut of its own, so it cannot collide with another command', () => {
    expect(
      APP_COMMANDS.find((command) => command.id === 'history.exclude')?.shortcuts,
    ).toBeUndefined()
    expect(() => makeRegistry()).not.toThrow()
  })

  it('is disabled without a tab and, with one, until the last run left an entry', () => {
    expect(makeRegistry().availability('history.exclude')).toEqual(
      disabled('No hay ninguna pestaña abierta'),
    )
    expect(withExecution(false).availability('history.exclude')).toEqual(
      disabled('La última ejecución de esta pestaña no dejó una entrada que quitar'),
    )
    expect(withExecution(true).availability('history.exclude')).toEqual({ enabled: true })
  })

  it('asks the toolbar to exclude the entry when it runs', async () => {
    let excluded = 0
    const actions = { ...noActions, excludeFromHistory: async () => void (excluded += 1) }

    expect(await withExecution(true, actions).execute('history.exclude')).toMatchObject({
      ok: true,
    })
    expect(excluded).toBe(1)
  })

  it('is listed in the palette and findable by the word «historial»', () => {
    const command = withExecution(true).get('history.exclude')
    expect(command?.title).toBe('Quitar del historial la última consulta')
    expect(command?.keywords).toContain('historial')
  })
})

describe('settings and theme commands', () => {
  const at = (event: KeyEventLike, platform: Platform = 'mac') =>
    makeRegistry().findByKey(event, platform)?.id ?? null

  it('maps Cmd+, on macOS and Ctrl+, elsewhere to "Abrir ajustes"', () => {
    expect(at(key({ key: ',', code: 'Comma', metaKey: true }))).toBe('settings.open')
    expect(at(key({ key: ',', code: 'Comma', ctrlKey: true }), 'windows')).toBe('settings.open')
    expect(at(key({ key: ',', code: 'Comma', ctrlKey: true }))).toBeNull()
    expect(at(key({ key: ',', code: 'Comma', metaKey: true, shiftKey: true }))).toBeNull()
  })

  it('opens the settings from anywhere, with or without tabs', async () => {
    const opened: (string | undefined)[] = []
    const actions = {
      ...noActions,
      openSettings: (section?: string) => void opened.push(section),
    } as AppCommandContext['actions']
    const registry = makeRegistry(makeContext({ actions }))

    expect(registry.availability('settings.open')).toEqual({ enabled: true })
    expect(registry.availability('query.settings')).toEqual({ enabled: true })
    await registry.execute('settings.open')
    await registry.execute('query.settings')

    expect(opened).toEqual([undefined, 'execution'])
  })

  it('opens the local AI settings straight on their section, from anywhere', async () => {
    const opened: (string | undefined)[] = []
    const actions = {
      ...noActions,
      openSettings: (section?: string) => void opened.push(section),
    } as AppCommandContext['actions']
    const registry = makeRegistry(makeContext({ actions }))

    expect(registry.get('settings.ai')?.title).toBe('Abrir ajustes de IA')
    expect(registry.get('settings.ai')?.keywords).toEqual(
      expect.arrayContaining(['ia', 'ollama', 'modelo']),
    )
    expect(registry.availability('settings.ai')).toEqual({ enabled: true })
    await registry.execute('settings.ai')

    expect(opened).toEqual(['ai'])
  })

  it('offers "Cambiar tema…" and finds the settings by their usual names', () => {
    const registry = makeRegistry()
    expect(registry.get('theme.set')?.title).toBe('Cambiar tema…')
    expect(registry.get('settings.open')?.title).toBe('Abrir ajustes')
    expect(registry.get('settings.open')?.keywords).toEqual(
      expect.arrayContaining(['preferencias', 'configuración']),
    )
  })

  it('saves the chosen theme through the preferences and announces it', async () => {
    const saved: string[] = []
    const announced: string[] = []
    const actions = {
      ...noActions,
      setTheme: async (theme: string) => {
        saved.push(theme)
        return true
      },
      announce: (message: string) => void announced.push(message),
    } as AppCommandContext['actions']
    const registry = makeRegistry(makeContext({ actions }))

    expect(await registry.execute('theme.set', { mode: 'light' })).toMatchObject({ ok: true })

    expect(saved).toEqual(['light'])
    expect(announced).toEqual(['Tema: claro'])
  })

  it('fails without announcing success when the theme cannot be saved', async () => {
    const announced: string[] = []
    const actions = {
      ...noActions,
      setTheme: async () => false,
      announce: (message: string) => void announced.push(message),
    } as AppCommandContext['actions']
    const registry = makeRegistry(makeContext({ actions }))

    const outcome = await registry.execute('theme.set', { mode: 'dark' })

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'failed',
      message: 'No se pudo guardar el tema.',
    })
    expect(announced).toEqual([])
  })

  it('rejects an unknown theme before saving anything', async () => {
    let saved = false
    const actions = {
      ...noActions,
      setTheme: async () => (saved = true),
    } as AppCommandContext['actions']
    const registry = makeRegistry(makeContext({ actions }))

    expect(await registry.execute('theme.set', { mode: 'sepia' })).toMatchObject({
      ok: false,
      reason: 'failed',
    })
    expect(saved).toBe(false)
  })
})

describe('running the commands', () => {
  it('opens the palette pre-filled when connect, describe or theme get no argument', async () => {
    const opened: [string, string | undefined][] = []
    const actions = {
      ...noActions,
      openPalette: (mode: string, query?: string) => void opened.push([mode, query]),
    } as AppCommandContext['actions']
    const registry = makeRegistry(
      makeContext({
        actions,
        connections: [
          { id: 'a', name: 'Local', engine: 'sqlite', readOnly: false, status: 'disconnected' },
        ],
        schema: { schemas: [], tables: [] },
      }),
    )
    await registry.execute('connection.connect')
    await registry.execute('schema.describe')
    await registry.execute('theme.set')
    expect(opened).toEqual([
      ['commands', '\\connect '],
      ['commands', '\\describe '],
      ['commands', '\\theme '],
    ])
  })

  it('reports an unresolvable connection or table as a failed result', async () => {
    const registry = makeRegistry(
      makeContext({ connections: [], schema: { schemas: ['public'], tables: [] } }),
    )
    const connect = await registry.execute('connection.connect', { name: 'x' })
    expect(connect).toMatchObject({ ok: false, reason: 'disabled' })
    const describe = await registry.execute('schema.describe', { table: 'ghost' })
    expect(describe).toMatchObject({ ok: false, reason: 'failed' })
  })
})
