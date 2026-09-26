import { editDistance } from './fuzzy'

/** Prefijo de los comandos internos: `\connect`, `\tables`… */
export const INTERNAL_PREFIX = '\\'

export type InternalCommandName =
  | 'connect'
  | 'disconnect'
  | 'connections'
  | 'schemas'
  | 'tables'
  | 'describe'
  | 'history'
  | 'ask'
  | 'timing'
  | 'clear'
  | 'theme'

export const THEME_CHOICES = ['dark', 'light', 'system'] as const
export const TIMING_CHOICES = ['on', 'off'] as const

export interface InternalParam {
  /** Clave en `args` del resultado. */
  key: string
  /** Nombre que se muestra en el uso: `<nombre>`, `[schema]`. */
  label: string
  required: boolean
  description: string
  /** Valores admitidos, si son un conjunto cerrado. */
  choices?: readonly string[]
}

export interface InternalCommandSpec {
  name: InternalCommandName
  description: string
  params: readonly InternalParam[]
}

export const INTERNAL_COMMANDS: readonly InternalCommandSpec[] = [
  {
    name: 'connect',
    description: 'Conecta a un perfil guardado.',
    params: [
      { key: 'name', label: 'nombre', required: true, description: 'Nombre de la conexión' },
    ],
  },
  { name: 'disconnect', description: 'Cierra la conexión activa.', params: [] },
  { name: 'connections', description: 'Abre la gestión de conexiones.', params: [] },
  { name: 'schemas', description: 'Va al explorador de esquemas.', params: [] },
  {
    name: 'tables',
    description: 'Muestra las tablas de un esquema en el explorador.',
    params: [
      {
        key: 'schema',
        label: 'schema',
        required: false,
        description: 'Esquema a abrir (por defecto, el principal)',
      },
    ],
  },
  {
    name: 'describe',
    description: 'Muestra columnas, claves e índices de una tabla.',
    params: [
      {
        key: 'table',
        label: 'tabla',
        required: true,
        description: 'Tabla o vista, con o sin esquema (schema.tabla)',
      },
    ],
  },
  { name: 'history', description: 'Abre el historial de consultas.', params: [] },
  {
    name: 'ask',
    description: 'Pregunta a la base en lenguaje natural (IA local).',
    params: [],
  },
  {
    name: 'timing',
    description: 'Muestra u oculta la duración en Mensajes.',
    params: [
      {
        key: 'mode',
        label: 'on|off',
        required: false,
        description: 'Activar o desactivar; sin valor, alterna',
        choices: TIMING_CHOICES,
      },
    ],
  },
  { name: 'clear', description: 'Limpia mensajes y resultados de la pestaña.', params: [] },
  {
    name: 'theme',
    description: 'Cambia el tema de la interfaz.',
    params: [
      {
        key: 'mode',
        label: 'dark|light|system',
        required: true,
        description: 'Tema oscuro, claro o el del sistema',
        choices: THEME_CHOICES,
      },
    ],
  },
]

export interface InternalArgs {
  connect: { name: string }
  disconnect: Record<string, never>
  connections: Record<string, never>
  schemas: Record<string, never>
  tables: { schema?: string }
  describe: { table: string }
  history: Record<string, never>
  ask: Record<string, never>
  timing: { mode?: (typeof TIMING_CHOICES)[number] }
  clear: Record<string, never>
  theme: { mode: (typeof THEME_CHOICES)[number] }
}

export type InternalInvocation = {
  [Name in InternalCommandName]: { command: Name; args: InternalArgs[Name] }
}[InternalCommandName]

export type InternalErrorCode =
  | 'not-internal'
  | 'empty'
  | 'unknown-command'
  | 'unterminated-quote'
  | 'missing-argument'
  | 'too-many-arguments'
  | 'invalid-argument'

export interface InternalParseError {
  code: InternalErrorCode
  /** Mensaje en castellano, listo para mostrar. */
  message: string
  /** Comando al que se refiere el error, si se llegó a reconocer. */
  command?: InternalCommandName
  /** Alternativas: comandos (`\tables`) o valores válidos (`dark`) más parecidos a lo escrito. */
  suggestions: readonly string[]
}

export type InternalParseResult =
  { ok: true; invocation: InternalInvocation } | { ok: false; error: InternalParseError }

const SPECS = new Map<string, InternalCommandSpec>(
  INTERNAL_COMMANDS.map((spec) => [spec.name, spec]),
)

export function findInternalSpec(name: string): InternalCommandSpec | undefined {
  return SPECS.get(name.toLowerCase())
}

/** `\connect <nombre>`, `\tables [schema]`. */
export function usageOf(spec: InternalCommandSpec): string {
  const params = spec.params.map((param) =>
    param.required ? `<${param.label}>` : `[${param.label}]`,
  )
  return [`${INTERNAL_PREFIX}${spec.name}`, ...params].join(' ')
}

export interface InputToken {
  value: string
  /** Posición absoluta en la entrada de la que sale, incluida la comilla de apertura. */
  start: number
  end: number
  quoted: boolean
}

export interface Tokenized {
  tokens: InputToken[]
  /** Comilla que quedó sin cerrar en el último token, si la hay. */
  unterminated: string | null
  /** La entrada acaba en espacio: el siguiente argumento aún no ha empezado. */
  trailingSpace: boolean
}

/**
 * Separa por espacios respetando comillas. Una comilla (`"` o `'`) solo abre un argumento si va al
 * principio de él, así que `O'Brien` es una palabra; dentro de comillas, `\"` y `\\` son literales.
 */
export function tokenize(text: string, offset = 0): Tokenized {
  const tokens: InputToken[] = []
  let unterminated: string | null = null
  let index = 0

  while (index < text.length) {
    if (/\s/.test(text[index]!)) {
      index += 1
      continue
    }
    const start = index
    let value = ''
    let quoted = false
    const opener = text[index]!
    if (opener === '"' || opener === "'") {
      quoted = true
      index += 1
      let closed = false
      while (index < text.length) {
        const char = text[index]!
        if (char === '\\' && (text[index + 1] === opener || text[index + 1] === '\\')) {
          value += text[index + 1]
          index += 2
        } else if (char === opener) {
          closed = true
          index += 1
          break
        } else {
          value += char
          index += 1
        }
      }
      if (!closed) unterminated = opener
    }
    while (index < text.length && !/\s/.test(text[index]!)) {
      value += text[index]
      index += 1
    }
    tokens.push({ value, start: offset + start, end: offset + index, quoted })
  }

  return { tokens, unterminated, trailingSpace: text.length > 0 && /\s$/.test(text) }
}

/** Escribe `value` como argumento: entre comillas dobles si tiene espacios o comillas. */
export function quoteArgument(value: string): string {
  if (value !== '' && !/[\s"'\\]/.test(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** `\connect "Mi base"`: inversa de `parseInternalCommand` para un comando y sus argumentos. */
export function buildInternalInput(
  name: InternalCommandName,
  args: readonly string[] = [],
): string {
  return [`${INTERNAL_PREFIX}${name}`, ...args.map(quoteArgument)].join(' ')
}

const tolerance = (typed: string): number => Math.max(2, Math.ceil(typed.length / 3))

/**
 * Los `limit` valores más parecidos a `typed`: primero los que empiezan por lo escrito y después los que
 * están a poca distancia de edición (falta una letra, dos intercambiadas…).
 */
export function closestMatches(typed: string, candidates: readonly string[], limit = 3): string[] {
  const wanted = typed.toLowerCase()
  if (wanted === '') return []
  const ranked: { value: string; rank: number }[] = []
  for (const value of candidates) {
    const lower = value.toLowerCase()
    if (wanted !== '' && lower.startsWith(wanted)) {
      ranked.push({ value, rank: lower.length - wanted.length })
      continue
    }
    const distance = editDistance(wanted, lower)
    if (distance <= tolerance(wanted)) ranked.push({ value, rank: 1000 + distance })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.value.localeCompare(b.value))
  return ranked.slice(0, limit).map((entry) => entry.value)
}

function unknownCommand(typed: string): InternalParseError {
  const suggestions = closestMatches(
    typed,
    INTERNAL_COMMANDS.map((spec) => spec.name),
  ).map((name) => `${INTERNAL_PREFIX}${name}`)
  const hint =
    suggestions.length > 0
      ? `¿Quisiste decir ${suggestions.join(' o ')}?`
      : `Escribe ${INTERNAL_PREFIX} para ver los comandos disponibles.`
  return {
    code: 'unknown-command',
    message: `Comando desconocido «${INTERNAL_PREFIX}${typed}». ${hint}`,
    suggestions,
  }
}

interface Head {
  /** Nombre escrito tras la barra, tal cual. */
  name: string
  /** Dónde acaba, para tokenizar el resto. */
  end: number
}

function readHead(input: string): Head | null {
  const lead = input.length - input.trimStart().length
  if (input[lead] !== INTERNAL_PREFIX) return null
  let end = lead + 1
  while (end < input.length && !/\s/.test(input[end]!)) end += 1
  return { name: input.slice(lead + 1, end), end }
}

/** ¿Hay que interpretar la entrada como comando interno? */
export function isInternalInput(input: string): boolean {
  return input.trimStart().startsWith(INTERNAL_PREFIX)
}

/**
 * Analiza `\comando arg1 "arg con espacios"`. Devuelve el comando y sus argumentos tipados, o un error
 * de validación con un mensaje claro y sugerencias. Los nombres no distinguen mayúsculas.
 */
export function parseInternalCommand(input: string): InternalParseResult {
  const fail = (error: InternalParseError): InternalParseResult => ({ ok: false, error })

  const head = readHead(input)
  if (!head) {
    return fail({
      code: 'not-internal',
      message: `Los comandos internos empiezan por «${INTERNAL_PREFIX}», como ${INTERNAL_PREFIX}tables.`,
      suggestions: [],
    })
  }
  if (head.name === '') {
    return fail({
      code: 'empty',
      message: `Escribe el nombre del comando después de «${INTERNAL_PREFIX}».`,
      suggestions: INTERNAL_COMMANDS.map((spec) => `${INTERNAL_PREFIX}${spec.name}`),
    })
  }
  const spec = findInternalSpec(head.name)
  if (!spec) return fail(unknownCommand(head.name.toLowerCase()))

  const { tokens, unterminated } = tokenize(input.slice(head.end), head.end)
  const usage = usageOf(spec)
  const base = { command: spec.name, suggestions: [] as string[] }
  if (unterminated !== null) {
    return fail({
      ...base,
      code: 'unterminated-quote',
      message: `Falta cerrar las comillas (${unterminated}) del argumento. Uso: ${usage}`,
    })
  }

  const values = tokens.map((token) => token.value)
  const missing = spec.params.find((param, index) => param.required && values[index] === undefined)
  if (missing) {
    return fail({
      ...base,
      code: 'missing-argument',
      message: `${INTERNAL_PREFIX}${spec.name} necesita «${missing.label}»: ${missing.description}. Uso: ${usage}`,
    })
  }
  if (values.length > spec.params.length) {
    const quoteHint =
      spec.params.length === 1 && spec.params[0]!.choices === undefined
        ? ` Si el valor tiene espacios, escríbelo entre comillas: ${buildInternalInput(spec.name, [values.join(' ')])}`
        : ''
    return fail({
      ...base,
      code: 'too-many-arguments',
      message:
        spec.params.length === 0
          ? `${INTERNAL_PREFIX}${spec.name} no admite argumentos. Uso: ${usage}`
          : `${INTERNAL_PREFIX}${spec.name} admite ${spec.params.length === 1 ? 'un solo argumento' : `como mucho ${spec.params.length} argumentos`}. Uso: ${usage}.${quoteHint}`,
    })
  }

  const args: Record<string, string> = {}
  for (const [index, param] of spec.params.entries()) {
    const value = values[index]
    if (value === undefined) continue
    if (param.choices) {
      const chosen = param.choices.find((choice) => choice === value.toLowerCase())
      if (!chosen) {
        return fail({
          command: spec.name,
          code: 'invalid-argument',
          message: `«${value}» no es un valor válido para ${INTERNAL_PREFIX}${spec.name}. Usa ${param.choices.join(', ')}.`,
          suggestions: closestMatches(value, param.choices),
        })
      }
      args[param.key] = chosen
    } else {
      args[param.key] = value
    }
  }
  return { ok: true, invocation: { command: spec.name, args } as InternalInvocation }
}

/** Dónde está el usuario dentro de un comando interno, para ofrecer ayuda y completado. */
export type InternalInputContext =
  | { stage: 'not-internal' }
  | { stage: 'command'; typed: string }
  | { stage: 'unknown'; typed: string; suggestions: readonly string[] }
  | {
      stage: 'argument'
      spec: InternalCommandSpec
      /** Argumentos ya completos, sin comillas. */
      previous: readonly string[]
      /** Posición (0-based) del argumento que se está escribiendo. */
      index: number
      /** `undefined` si ya se han escrito más argumentos de los que admite el comando. */
      param: InternalParam | undefined
      /** Lo escrito del argumento actual, sin la comilla de apertura. */
      typed: string
      /** Desde dónde se sustituye el argumento actual al completarlo. */
      replaceFrom: number
    }

export function analyzeInternalInput(input: string): InternalInputContext {
  const head = readHead(input)
  if (!head) return { stage: 'not-internal' }
  if (head.end === input.length) return { stage: 'command', typed: head.name }

  const spec = findInternalSpec(head.name)
  if (!spec) {
    return {
      stage: 'unknown',
      typed: head.name,
      suggestions: unknownCommand(head.name).suggestions,
    }
  }

  const { tokens, trailingSpace } = tokenize(input.slice(head.end), head.end)
  const editing = trailingSpace || tokens.length === 0 ? undefined : tokens[tokens.length - 1]
  const finished = editing ? tokens.slice(0, -1) : tokens
  const index = finished.length
  return {
    stage: 'argument',
    spec,
    previous: finished.map((token) => token.value),
    index,
    param: spec.params[index],
    typed: editing?.value ?? '',
    replaceFrom: editing?.start ?? input.length,
  }
}
