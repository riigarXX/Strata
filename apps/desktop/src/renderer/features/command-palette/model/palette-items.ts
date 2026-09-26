import {
  analyzeInternalInput,
  INTERNAL_COMMANDS,
  INTERNAL_PREFIX,
  quoteArgument,
  searchItems,
  usageOf,
  type CommandRegistry,
  type InternalCommandSpec,
  type MatchRange,
  type Platform,
} from '@strata/commands'
import { CATEGORY_ORDER } from '../commands'
import type { AppCommandContext, ConnectionStatus, PaletteMode } from './context'
import { qualified } from './resolve'

export type PaletteAction =
  | { type: 'command'; commandId: string }
  /** Elegir un comando interno de la lista: se ejecuta si no necesita argumentos y, si no, se completa en el campo. */
  | { type: 'internal-command'; name: InternalCommandSpec['name']; needsArguments: boolean }
  /** Entrada de comando interno completa (`\connect "Mi base"`): se analiza y se ejecuta. */
  | { type: 'internal'; input: string }
  | { type: 'connect'; profileId: string }
  | { type: 'insert'; text: string }

export interface PaletteItem {
  key: string
  label: string
  /** Rangos de `label` que coinciden con la búsqueda, para resaltarlos. */
  ranges: readonly MatchRange[]
  /** Encabezado del grupo al que pertenece; `null` si la lista no se agrupa. */
  group: string | null
  category: string | null
  description: string | null
  /** Texto del atajo ya formateado para la plataforma. */
  shortcut: string | null
  detail: string | null
  /** Por qué no se puede ejecutar; el elemento se muestra igualmente, con `aria-disabled`. */
  disabledReason: string | null
  /** Texto con el que el campo se autocompleta al pulsar Tab. */
  completion: string | null
  action: PaletteAction
}

export interface PaletteView {
  items: PaletteItem[]
  /** Ayuda bajo el campo: para qué sirve este modo o el uso del comando interno que se escribe. */
  help: string
  emptyMessage: string
  /** Total de coincidencias, aunque solo se muestren los primeros. */
  total: number
}

export const MAX_ITEMS = 200

export const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'conectada',
  connecting: 'conectando',
  disconnected: 'desconectada',
  error: 'con error',
}

const KIND_LABELS = {
  table: 'tabla',
  partitioned_table: 'tabla particionada',
  foreign_table: 'tabla foránea',
  view: 'vista',
  materialized_view: 'vista materializada',
} as const

const ENGINE_LABELS = { postgres: 'PostgreSQL', sqlite: 'SQLite' } as const

export interface BuildInput {
  registry: CommandRegistry<AppCommandContext>
  context: AppCommandContext
  platform: Platform
  mode: PaletteMode
  query: string
  /** Ids de comandos ejecutados, el más reciente primero. */
  recents: readonly string[]
}

const shift = (ranges: readonly MatchRange[], by: number): MatchRange[] =>
  ranges.map((range) => ({ start: range.start + by, end: range.end + by }))

function commandView({ registry, platform, query, recents }: BuildInput): PaletteView {
  const commands = registry.list()
  const searching = query.trim() !== ''
  const recency = (id: string): number => {
    const at = recents.indexOf(id)
    return at < 0 ? 0 : recents.length - at
  }
  const results = searchItems(commands, query, {
    fields: (command) => ({
      text: command.title,
      keywords: command.keywords,
      category: command.category,
      description: command.description,
    }),
    categoryOrder: CATEGORY_ORDER,
    ...(searching ? { recency: (command) => recency(command.id) } : {}),
  })

  const items = results.map(({ item: command, ranges }): PaletteItem => {
    const availability = registry.availability(command.id)
    return {
      key: `command:${command.id}`,
      label: command.title,
      ranges,
      group: searching ? null : command.category,
      category: command.category,
      description: command.description,
      shortcut: registry.displayShortcuts(command.id, platform)[0] ?? null,
      detail: null,
      disabledReason: availability.enabled ? null : availability.reason,
      completion: null,
      action: { type: 'command', commandId: command.id },
    }
  })
  return {
    items,
    help: `Escribe para buscar un comando o ${INTERNAL_PREFIX} para los comandos internos.`,
    emptyMessage: `Ningún comando coincide con «${query.trim()}».`,
    total: items.length,
  }
}

function internalCommandItem(
  spec: InternalCommandSpec,
  ranges: readonly MatchRange[],
  { registry }: BuildInput,
): PaletteItem {
  const target = registry.findByInternal(spec.name)
  const availability = target ? registry.availability(target.id) : null
  const needsArguments = spec.params.some((param) => param.required)
  return {
    key: `internal-command:${spec.name}`,
    label: usageOf(spec),
    // El rango se calculó sobre `name`; en la etiqueta lleva delante la barra invertida.
    ranges: shift(ranges, INTERNAL_PREFIX.length),
    group: null,
    category: 'Comandos internos',
    description: spec.description,
    shortcut: null,
    detail: null,
    disabledReason: !availability || availability.enabled ? null : availability.reason,
    completion: `${INTERNAL_PREFIX}${spec.name}${spec.params.length > 0 ? ' ' : ''}`,
    action: { type: 'internal-command', name: spec.name, needsArguments },
  }
}

function completionItem(
  name: string,
  label: string,
  ranges: readonly MatchRange[],
  detail: string | null,
  input: string,
  completion: string,
): PaletteItem {
  return {
    key: `internal:${name}:${label}`,
    label,
    ranges,
    group: null,
    category: null,
    description: null,
    shortcut: null,
    detail,
    disabledReason: null,
    completion,
    action: { type: 'internal', input },
  }
}

function internalView(input: BuildInput): PaletteView {
  const { context, query } = input
  const analysis = analyzeInternalInput(query)

  if (analysis.stage === 'command' || analysis.stage === 'unknown') {
    const typed = analysis.typed
    const specs =
      analysis.stage === 'unknown'
        ? INTERNAL_COMMANDS.filter((spec) =>
            analysis.suggestions.includes(`${INTERNAL_PREFIX}${spec.name}`),
          )
        : INTERNAL_COMMANDS
    const results = searchItems(specs, analysis.stage === 'command' ? typed : '', {
      fields: (spec) => ({ text: spec.name, description: spec.description }),
    })
    const items = results.map(({ item, ranges }) => internalCommandItem(item, ranges, input))
    return {
      items,
      help: `Comandos internos: elige uno y pulsa Enter, o Tab para completar.`,
      emptyMessage: `Ningún comando interno se parece a «${INTERNAL_PREFIX}${typed}».`,
      total: items.length,
    }
  }

  if (analysis.stage !== 'argument') {
    return { items: [], help: '', emptyMessage: '', total: 0 }
  }

  const { spec, param, typed } = analysis
  const usage = usageOf(spec)
  const help = param ? `${usage} — ${param.description}` : `${usage} — no admite más argumentos.`
  const build = (
    values: readonly { value: string; detail: string | null; label?: string }[],
    emptyMessage: string,
  ): PaletteView => {
    const results = searchItems(values, typed, {
      fields: (entry) => ({ text: entry.label ?? entry.value }),
    })
    const prefix = query.slice(0, analysis.replaceFrom)
    const items = results.map(({ item, ranges }) => {
      const text = `${INTERNAL_PREFIX}${spec.name} ${quoteArgument(item.value)}`
      return completionItem(
        spec.name,
        item.label ?? item.value,
        ranges,
        item.detail,
        text,
        `${prefix}${quoteArgument(item.value)}`,
      )
    })
    return { items, help, emptyMessage, total: items.length }
  }

  if (!param || analysis.index > 0) return { items: [], help, emptyMessage: '', total: 0 }

  switch (`${spec.name}.${param.key}`) {
    case 'connect.name':
      return build(
        context.connections.map((connection) => ({
          value: connection.name,
          detail: `${ENGINE_LABELS[connection.engine]} · ${CONNECTION_STATUS_LABELS[connection.status]}`,
        })),
        'No hay conexiones que coincidan.',
      )
    case 'tables.schema':
      return build(
        (context.schema?.schemas ?? []).map((name) => ({ value: name, detail: 'esquema' })),
        context.schema
          ? 'No hay esquemas que coincidan.'
          : 'Conecta una base de datos para ver sus esquemas.',
      )
    case 'describe.table':
      return build(
        (context.schema?.tables ?? []).map((table) => ({
          value: qualified(table),
          detail: KIND_LABELS[table.kind],
        })),
        context.schema
          ? 'No hay tablas cargadas que coincidan. Expande el esquema en el explorador para cargarlas.'
          : 'Conecta una base de datos para ver sus tablas.',
      )
    default:
      return build(
        (param.choices ?? []).map((choice) => ({ value: choice, detail: null })),
        `Valores válidos: ${(param.choices ?? []).join(', ')}.`,
      )
  }
}

function gotoView({ context, query }: Pick<BuildInput, 'context' | 'query'>): PaletteView {
  const canInsert = context.tabs.count > 0
  const base = {
    ranges: [],
    group: null,
    description: null,
    shortcut: null,
    completion: null,
  } as const
  const entries: { search: string; item: PaletteItem }[] = [
    ...context.connections.map((connection) => ({
      search: connection.name,
      item: {
        ...base,
        key: `connection:${connection.id}`,
        label: connection.name,
        category: 'Conexiones',
        detail: `${ENGINE_LABELS[connection.engine]} · ${CONNECTION_STATUS_LABELS[connection.status]}`,
        disabledReason: connection.status === 'connecting' ? 'Ya se está conectando' : null,
        action: { type: 'connect', profileId: connection.id },
      } satisfies PaletteItem,
    })),
    ...(context.schema?.tables ?? []).map((table) => ({
      search: qualified(table),
      item: {
        ...base,
        key: `table:${qualified(table)}`,
        label: qualified(table),
        category: 'Tablas y vistas',
        detail: KIND_LABELS[table.kind],
        disabledReason: canInsert ? null : 'Requiere una pestaña abierta',
        action: { type: 'insert', text: table.qualifiedName },
      } satisfies PaletteItem,
    })),
  ]
  // Las conexiones van antes que las tablas en la lista: a igual puntuación se conserva ese orden.
  const results = searchItems(entries, query, { fields: (entry) => ({ text: entry.search }) })
  const items = results
    .slice(0, MAX_ITEMS)
    .map(({ item, ranges }): PaletteItem => ({ ...item.item, ranges }))
  return {
    items,
    help: 'Elige una conexión para conectarla o una tabla para insertar su nombre en el editor.',
    emptyMessage:
      query.trim() === ''
        ? 'No hay conexiones ni tablas cargadas. Conecta una base de datos para buscar en su esquema.'
        : `Ninguna conexión, tabla ni vista coincide con «${query.trim()}».`,
    total: results.length,
  }
}

/** Todo lo que la paleta muestra ahora mismo, calculado a partir del modo, el texto y el contexto. */
export function buildPaletteView(input: BuildInput): PaletteView {
  if (input.mode === 'goto') return gotoView(input)
  return analyzeInternalInput(input.query).stage === 'not-internal'
    ? commandView(input)
    : internalView(input)
}
