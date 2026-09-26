import type { InternalCommandName } from './internal-commands'
import {
  ariaKeyShortcut,
  canonicalShortcut,
  formatShortcut,
  matchesShortcut,
  parseShortcut,
  shortcutsConflict,
  type Chord,
  type KeyEventLike,
  type Platform,
} from './shortcuts'

/** Resultado de la precondición de un comando: habilitado o el motivo (en castellano) por el que no lo está. */
export type Availability =
  { readonly enabled: true } | { readonly enabled: false; readonly reason: string }

export const ENABLED: Availability = Object.freeze({ enabled: true })

export function disabled(reason: string): Availability {
  return { enabled: false, reason }
}

/** Argumentos que un comando recibe al ejecutarse (los de un comando interno `\connect nombre`, p. ej.). */
export type CommandArgs = Readonly<Record<string, unknown>>

/** Cómo debe tratar un anfitrión con teclado el atajo del comando; el registro solo lo declara. */
export interface KeyboardBehavior {
  /** El comando se repite mientras se mantiene la tecla (siguiente pestaña). Por defecto, no. */
  repeat?: boolean
  /**
   * El atajo no consume el evento (no se hace `preventDefault`) y solo actúa si el comando está habilitado.
   * Es el caso de Esc, que también sirve al editor y a los diálogos.
   */
  passthrough?: boolean
  /** El atajo sigue activo con un overlay modal abierto (la propia paleta). Por defecto, no. */
  whileModal?: boolean
}

export interface CommandDefinition<Context> {
  /** Estable y único: `tab.new`, `query.run`. Es la clave de recencia, ayuda y tests. */
  id: string
  /** Título en castellano, en imperativo o infinitivo corto: «Nueva pestaña SQL». */
  title: string
  description: string
  category: string
  keywords?: readonly string[]
  /** Atajos con `Mod` (Cmd en macOS, Ctrl en el resto): `Mod+Shift+Enter`. */
  shortcuts?: readonly string[]
  keyboard?: KeyboardBehavior
  /** Comando interno (`\connect`) que ejecuta este comando. */
  internal?: InternalCommandName
  /** No se lista en la paleta, pero sigue siendo ejecutable por atajo. */
  hidden?: boolean
  when?(context: Context): Availability
  run(context: Context, args?: CommandArgs): void | Promise<void>
}

/** Comando ya registrado: definición validada, con sus atajos analizados. */
export interface Command<Context> extends CommandDefinition<Context> {
  readonly keywords: readonly string[]
  readonly shortcuts: readonly string[]
  readonly chords: readonly Chord[]
  readonly keyboard: Readonly<KeyboardBehavior>
  readonly hidden: boolean
}

export type ExecuteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unknown'; readonly message: string }
  | { readonly ok: false; readonly reason: 'disabled'; readonly message: string }
  | {
      readonly ok: false
      readonly reason: 'failed'
      readonly message: string
      readonly error: unknown
    }

export class CommandRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandRegistrationError'
  }
}

export class ShortcutConflictError extends CommandRegistrationError {
  constructor(
    readonly shortcut: string,
    readonly existingId: string,
    readonly incomingId: string,
  ) {
    super(
      existingId === incomingId
        ? `El comando «${incomingId}» declara el atajo ${shortcut} más de una vez.`
        : `El atajo ${shortcut} de «${incomingId}» ya lo usa «${existingId}».`,
    )
    this.name = 'ShortcutConflictError'
  }
}

export interface RegistryOptions<Context> {
  /** Se llama en cada `when` y cada `run`: el registro no sabe de dónde sale el contexto (Vue, una CLI…). */
  context: () => Context
}

export interface ListOptions {
  includeHidden?: boolean
}

/**
 * Registro declarativo de comandos, sin dependencias de Vue, Electron ni del DOM: el mismo registro sirve
 * a la paleta de la aplicación y a una futura CLI headless (ADR 0001).
 */
export class CommandRegistry<Context> {
  readonly #commands = new Map<string, Command<Context>>()
  readonly #listeners = new Set<() => void>()
  readonly #context: () => Context
  #version = 0

  constructor(options: RegistryOptions<Context>) {
    this.#context = options.context
  }

  /** Cambia con cada alta o baja: permite a una interfaz reactiva saber que debe volver a listar. */
  get version(): number {
    return this.#version
  }

  /** Da de alta un comando y devuelve la función que lo da de baja. */
  register(definition: CommandDefinition<Context>): () => void {
    const command = this.#validate(definition)
    this.#commands.set(command.id, command)
    this.#changed()
    return () => {
      if (this.#commands.get(command.id) === command) this.unregister(command.id)
    }
  }

  /** Alta atómica: si uno falla no se registra ninguno. */
  registerAll(definitions: readonly CommandDefinition<Context>[]): () => void {
    const registered: (() => void)[] = []
    try {
      for (const definition of definitions) registered.push(this.register(definition))
    } catch (error) {
      for (const undo of registered.reverse()) undo()
      throw error
    }
    return () => {
      for (const undo of registered.reverse()) undo()
    }
  }

  unregister(id: string): boolean {
    const removed = this.#commands.delete(id)
    if (removed) this.#changed()
    return removed
  }

  has(id: string): boolean {
    return this.#commands.has(id)
  }

  get(id: string): Command<Context> | undefined {
    return this.#commands.get(id)
  }

  /** Comandos en orden de registro. */
  list({ includeHidden = false }: ListOptions = {}): Command<Context>[] {
    const all = [...this.#commands.values()]
    return includeHidden ? all : all.filter((command) => !command.hidden)
  }

  /** Categorías en el orden en que aparecen por primera vez. */
  categories(options?: ListOptions): string[] {
    return [...new Set(this.list(options).map((command) => command.category))]
  }

  findByInternal(name: InternalCommandName): Command<Context> | undefined {
    return [...this.#commands.values()].find((command) => command.internal === name)
  }

  availability(id: string): Availability {
    const command = this.#commands.get(id)
    if (!command) return disabled(`El comando «${id}» no existe.`)
    return this.#availabilityOf(command)
  }

  async execute(id: string, args?: CommandArgs): Promise<ExecuteResult> {
    const command = this.#commands.get(id)
    if (!command) {
      return { ok: false, reason: 'unknown', message: `El comando «${id}» no existe.` }
    }
    const availability = this.#availabilityOf(command)
    if (!availability.enabled) {
      return { ok: false, reason: 'disabled', message: availability.reason }
    }
    try {
      await command.run(this.#context(), args)
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
        error,
      }
    }
  }

  /** Comando cuyo atajo coincide con el evento, o `undefined`. No comprueba su precondición. */
  findByKey(event: KeyEventLike, platform: Platform): Command<Context> | undefined {
    for (const command of this.#commands.values()) {
      if (command.chords.some((chord) => matchesShortcut(chord, event, platform))) return command
    }
    return undefined
  }

  /** Atajos del comando listos para mostrar en la plataforma (`⌘K`, `Ctrl+K`). */
  displayShortcuts(id: string, platform: Platform): string[] {
    return (this.#commands.get(id)?.chords ?? []).map((chord) => formatShortcut(chord, platform))
  }

  /** Atajos del comando en formato `aria-keyshortcuts` para la plataforma. */
  ariaShortcuts(id: string, platform: Platform): string[] {
    return (this.#commands.get(id)?.chords ?? []).map((chord) => ariaKeyShortcut(chord, platform))
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #availabilityOf(command: Command<Context>): Availability {
    if (!command.when) return ENABLED
    try {
      return command.when(this.#context())
    } catch {
      return disabled('No se pudo comprobar si el comando está disponible.')
    }
  }

  #changed(): void {
    this.#version += 1
    for (const listener of [...this.#listeners]) listener()
  }

  #validate(definition: CommandDefinition<Context>): Command<Context> {
    const { id } = definition
    if (id.trim() === '') throw new CommandRegistrationError('Un comando necesita un id.')
    if (this.#commands.has(id)) {
      throw new CommandRegistrationError(`Ya hay un comando registrado con el id «${id}».`)
    }
    for (const field of ['title', 'description', 'category'] as const) {
      if (definition[field].trim() === '') {
        throw new CommandRegistrationError(`El comando «${id}» necesita ${field}.`)
      }
    }

    const chords = (definition.shortcuts ?? []).map((shortcut) => parseShortcut(shortcut))
    chords.forEach((chord, index) => {
      const shortcut = canonicalShortcut(chord)
      for (const earlier of chords.slice(0, index)) {
        if (shortcutsConflict(earlier, chord)) throw new ShortcutConflictError(shortcut, id, id)
      }
      for (const other of this.#commands.values()) {
        if (other.chords.some((existing) => shortcutsConflict(existing, chord))) {
          throw new ShortcutConflictError(shortcut, other.id, id)
        }
      }
    })

    return Object.freeze({
      ...definition,
      keywords: Object.freeze([...(definition.keywords ?? [])]),
      shortcuts: Object.freeze(chords.map(canonicalShortcut)),
      chords: Object.freeze(chords),
      keyboard: Object.freeze({ ...definition.keyboard }),
      hidden: definition.hidden ?? false,
    })
  }
}
