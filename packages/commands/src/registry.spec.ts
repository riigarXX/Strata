import { describe, expect, it, vi } from 'vitest'
import {
  CommandRegistrationError,
  CommandRegistry,
  disabled,
  ENABLED,
  ShortcutConflictError,
  type CommandDefinition,
} from './registry'
import { ShortcutSyntaxError } from './shortcuts'

interface Context {
  connected: boolean
  log: string[]
}

function make(context: Context = { connected: false, log: [] }) {
  return { context, registry: new CommandRegistry<Context>({ context: () => context }) }
}

function command(
  id: string,
  extra: Partial<CommandDefinition<Context>> = {},
): CommandDefinition<Context> {
  return {
    id,
    title: `Título de ${id}`,
    description: `Descripción de ${id}`,
    category: 'General',
    run: (context) => {
      context.log.push(id)
    },
    ...extra,
  }
}

describe('registration', () => {
  it('registers, looks up and lists commands in registration order', () => {
    const { registry } = make()
    registry.register(command('b.one'))
    registry.register(command('a.two'))
    expect(registry.has('b.one')).toBe(true)
    expect(registry.get('a.two')?.title).toBe('Título de a.two')
    expect(registry.get('nope')).toBeUndefined()
    expect(registry.list().map((entry) => entry.id)).toEqual(['b.one', 'a.two'])
  })

  it('normalises optional fields on the registered command', () => {
    const { registry } = make()
    registry.register(command('x', { shortcuts: ['cmdorctrl+shift+enter'] }))
    const registered = registry.get('x')!
    expect(registered.keywords).toEqual([])
    expect(registered.hidden).toBe(false)
    expect(registered.keyboard).toEqual({})
    expect(registered.shortcuts).toEqual(['Mod+Shift+Enter'])
    expect(registered.chords).toHaveLength(1)
    expect(Object.isFrozen(registered)).toBe(true)
  })

  it('does not let later edits to the definition change the registered command', () => {
    const { registry } = make()
    const keywords = ['uno']
    registry.register(command('x', { keywords }))
    keywords.push('dos')
    expect(registry.get('x')?.keywords).toEqual(['uno'])
  })

  it('rejects duplicate ids and incomplete definitions', () => {
    const { registry } = make()
    registry.register(command('x'))
    expect(() => registry.register(command('x'))).toThrow(CommandRegistrationError)
    expect(() => registry.register(command('x'))).toThrow('«x»')
    expect(() => registry.register(command(' '))).toThrow('id')
    expect(() => registry.register(command('y', { title: '' }))).toThrow('title')
    expect(() => registry.register(command('y', { description: ' ' }))).toThrow('description')
    expect(() => registry.register(command('y', { category: '' }))).toThrow('category')
    expect(registry.has('y')).toBe(false)
  })

  it('rejects an invalid shortcut without registering anything', () => {
    const { registry } = make()
    expect(() => registry.register(command('x', { shortcuts: ['Mod+Nope'] }))).toThrow(
      ShortcutSyntaxError,
    )
    expect(registry.has('x')).toBe(false)
  })

  it('unregisters through the returned function and by id', () => {
    const { registry } = make()
    const undo = registry.register(command('a'))
    registry.register(command('b'))
    undo()
    expect(registry.has('a')).toBe(false)
    expect(registry.unregister('b')).toBe(true)
    expect(registry.unregister('b')).toBe(false)
    expect(registry.list()).toEqual([])
  })

  it('an old unregister function does not remove a command registered again under the same id', () => {
    const { registry } = make()
    const undoFirst = registry.register(command('a', { title: 'Primero' }))
    registry.unregister('a')
    registry.register(command('a', { title: 'Segundo' }))
    undoFirst()
    expect(registry.get('a')?.title).toBe('Segundo')
  })

  it('frees the shortcut when the command is unregistered', () => {
    const { registry } = make()
    registry.register(command('a', { shortcuts: ['Mod+K'] }))
    registry.unregister('a')
    expect(() => registry.register(command('b', { shortcuts: ['Mod+K'] }))).not.toThrow()
  })

  it('registerAll is atomic', () => {
    const { registry } = make()
    registry.register(command('existing', { shortcuts: ['Mod+K'] }))
    expect(() =>
      registry.registerAll([
        command('a', { shortcuts: ['Mod+P'] }),
        command('b', { shortcuts: ['Mod+K'] }),
      ]),
    ).toThrow(ShortcutConflictError)
    expect(registry.list().map((entry) => entry.id)).toEqual(['existing'])

    const undo = registry.registerAll([command('a'), command('b')])
    expect(registry.list()).toHaveLength(3)
    undo()
    expect(registry.list().map((entry) => entry.id)).toEqual(['existing'])
  })

  it('hides hidden commands from list() unless asked', () => {
    const { registry } = make()
    registry.register(command('shown', { category: 'A' }))
    registry.register(command('secret', { hidden: true, category: 'B' }))
    expect(registry.list().map((entry) => entry.id)).toEqual(['shown'])
    expect(registry.list({ includeHidden: true }).map((entry) => entry.id)).toEqual([
      'shown',
      'secret',
    ])
    expect(registry.categories()).toEqual(['A'])
    expect(registry.categories({ includeHidden: true })).toEqual(['A', 'B'])
  })

  it('lists categories in order of first appearance', () => {
    const { registry } = make()
    registry.register(command('1', { category: 'Consulta' }))
    registry.register(command('2', { category: 'Pestañas' }))
    registry.register(command('3', { category: 'Consulta' }))
    expect(registry.categories()).toEqual(['Consulta', 'Pestañas'])
  })
})

describe('shortcut conflicts', () => {
  it('throws a clear error when a shortcut is already taken', () => {
    const { registry } = make()
    registry.register(command('palette.open', { shortcuts: ['Mod+K'] }))
    const attempt = () => registry.register(command('other', { shortcuts: ['cmdorctrl+k'] }))
    expect(attempt).toThrow(ShortcutConflictError)
    expect(attempt).toThrow('El atajo Mod+K de «other» ya lo usa «palette.open».')
    try {
      attempt()
    } catch (error) {
      expect(error).toBeInstanceOf(CommandRegistrationError)
      expect(error).toMatchObject({
        shortcut: 'Mod+K',
        existingId: 'palette.open',
        incomingId: 'other',
      })
    }
    expect(registry.has('other')).toBe(false)
  })

  it('detects platform-dependent collisions', () => {
    const { registry } = make()
    registry.register(command('a', { shortcuts: ['Mod+Tab'] }))
    expect(() => registry.register(command('b', { shortcuts: ['Ctrl+Tab'] }))).toThrow(
      ShortcutConflictError,
    )
  })

  it('detects a shortcut repeated inside the same command', () => {
    const { registry } = make()
    expect(() => registry.register(command('a', { shortcuts: ['Mod+K', 'Mod+K'] }))).toThrow(
      'declara el atajo Mod+K más de una vez',
    )
    expect(registry.has('a')).toBe(false)
  })

  it('allows several distinct shortcuts per command and reports each one', () => {
    const { registry } = make()
    registry.register(command('a', { shortcuts: ['Mod+Enter', 'Ctrl+Alt+R'] }))
    expect(registry.get('a')?.shortcuts).toEqual(['Mod+Enter', 'Ctrl+Alt+R'])
  })
})

describe('availability', () => {
  it('is enabled without a precondition', () => {
    const { registry } = make()
    registry.register(command('a'))
    expect(registry.availability('a')).toEqual(ENABLED)
  })

  it('evaluates when() against the injected context each time', () => {
    const { registry, context } = make()
    registry.register(
      command('needs.connection', {
        when: (ctx) => (ctx.connected ? ENABLED : disabled('Requiere una conexión activa')),
      }),
    )
    expect(registry.availability('needs.connection')).toEqual({
      enabled: false,
      reason: 'Requiere una conexión activa',
    })
    context.connected = true
    expect(registry.availability('needs.connection')).toEqual({ enabled: true })
  })

  it('reports unknown ids as disabled', () => {
    const { registry } = make()
    expect(registry.availability('nope')).toEqual({
      enabled: false,
      reason: 'El comando «nope» no existe.',
    })
  })

  it('turns a throwing precondition into a disabled command', () => {
    const { registry } = make()
    registry.register(
      command('a', {
        when: () => {
          throw new Error('boom')
        },
      }),
    )
    const result = registry.availability('a')
    expect(result.enabled).toBe(false)
  })
})

describe('execute', () => {
  it('runs the command with the injected context and the arguments', async () => {
    const { registry, context } = make()
    const run = vi.fn()
    registry.register(command('a', { run }))
    await expect(registry.execute('a', { name: 'Prod' })).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(context, { name: 'Prod' })
  })

  it('awaits asynchronous commands', async () => {
    const { registry, context } = make()
    registry.register(
      command('slow', {
        run: async (ctx) => {
          await Promise.resolve()
          ctx.log.push('done')
        },
      }),
    )
    await registry.execute('slow')
    expect(context.log).toEqual(['done'])
  })

  it('refuses a disabled command with its reason and does not run it', async () => {
    const { registry, context } = make()
    registry.register(command('a', { when: () => disabled('Requiere una conexión activa') }))
    await expect(registry.execute('a')).resolves.toEqual({
      ok: false,
      reason: 'disabled',
      message: 'Requiere una conexión activa',
    })
    expect(context.log).toEqual([])
  })

  it('reports unknown commands', async () => {
    const { registry } = make()
    await expect(registry.execute('nope')).resolves.toMatchObject({ ok: false, reason: 'unknown' })
  })

  it('catches synchronous and asynchronous failures', async () => {
    const { registry } = make()
    const failure = new Error('sin espacio')
    registry.register(
      command('sync', {
        run: () => {
          throw failure
        },
      }),
    )
    registry.register(command('async', { run: () => Promise.reject('texto') }))
    await expect(registry.execute('sync')).resolves.toEqual({
      ok: false,
      reason: 'failed',
      message: 'sin espacio',
      error: failure,
    })
    await expect(registry.execute('async')).resolves.toMatchObject({
      ok: false,
      reason: 'failed',
      message: 'texto',
    })
  })
})

describe('findByKey', () => {
  const key = (init: { key: string; meta?: boolean; ctrl?: boolean; shift?: boolean }) => ({
    key: init.key,
    metaKey: init.meta ?? false,
    ctrlKey: init.ctrl ?? false,
    altKey: false,
    shiftKey: init.shift ?? false,
  })

  it('finds the command whose shortcut matches on the platform', () => {
    const { registry } = make()
    registry.register(command('run', { shortcuts: ['Mod+Enter'] }))
    registry.register(command('run.all', { shortcuts: ['Mod+Shift+Enter'] }))
    expect(registry.findByKey(key({ key: 'Enter', meta: true }), 'mac')?.id).toBe('run')
    expect(registry.findByKey(key({ key: 'Enter', meta: true, shift: true }), 'mac')?.id).toBe(
      'run.all',
    )
    expect(registry.findByKey(key({ key: 'Enter', ctrl: true }), 'windows')?.id).toBe('run')
    expect(registry.findByKey(key({ key: 'Enter', ctrl: true }), 'mac')).toBeUndefined()
    expect(registry.findByKey(key({ key: 'x', meta: true }), 'mac')).toBeUndefined()
  })

  it('finds commands through any of their shortcuts', () => {
    const { registry } = make()
    registry.register(command('a', { shortcuts: ['Mod+K', 'Ctrl+Alt+P'] }))
    expect(registry.findByKey({ ...key({ key: 'p', ctrl: true }), altKey: true }, 'mac')?.id).toBe(
      'a',
    )
  })
})

describe('shortcut display', () => {
  it('formats and describes the shortcuts of a command per platform', () => {
    const { registry } = make()
    registry.register(command('run.all', { shortcuts: ['Mod+Shift+Enter'] }))
    expect(registry.displayShortcuts('run.all', 'mac')).toEqual(['⇧⌘↵'])
    expect(registry.displayShortcuts('run.all', 'windows')).toEqual(['Ctrl+Shift+Enter'])
    expect(registry.ariaShortcuts('run.all', 'mac')).toEqual(['Meta+Shift+Enter'])
    expect(registry.displayShortcuts('missing', 'mac')).toEqual([])
    expect(registry.ariaShortcuts('missing', 'mac')).toEqual([])
  })
})

describe('internal commands and subscriptions', () => {
  it('finds the command that serves an internal command', () => {
    const { registry } = make()
    registry.register(command('connection.connect', { internal: 'connect' }))
    expect(registry.findByInternal('connect')?.id).toBe('connection.connect')
    expect(registry.findByInternal('theme')).toBeUndefined()
  })

  it('notifies subscribers of every registration and removal and bumps the version', () => {
    const { registry } = make()
    const listener = vi.fn()
    const stop = registry.subscribe(listener)
    expect(registry.version).toBe(0)
    registry.register(command('a'))
    registry.unregister('a')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(registry.version).toBe(2)
    stop()
    registry.register(command('b'))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not notify when nothing changed', () => {
    const { registry } = make()
    const listener = vi.fn()
    registry.subscribe(listener)
    registry.unregister('missing')
    expect(() => registry.register(command('a', { shortcuts: ['Nope'] }))).toThrow()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('agnostic of the host', () => {
  it('works with any context object, not just app state', async () => {
    const registry = new CommandRegistry<{ out: string[] }>({ context: () => ({ out: [] }) })
    const seen: string[][] = []
    registry.register({
      id: 'cli.hello',
      title: 'Saludar',
      description: 'Escribe un saludo',
      category: 'CLI',
      run: (context) => {
        context.out.push('hola')
        seen.push(context.out)
      },
    })
    await registry.execute('cli.hello')
    expect(seen).toEqual([['hola']])
  })
})
