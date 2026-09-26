import {
  ConnectionProfileInputSchema,
  ConnectionProfileUpdateSchema,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionProfileUpdate,
  type Engine,
  type SslMode,
} from '@strata/contracts'

/** Estado transitorio del formulario. `password` no sale nunca del componente que lo posee. */
export interface ProfileDraft {
  engine: Engine
  name: string
  readOnly: boolean
  host: string
  port: string
  user: string
  database: string
  ssl: SslMode
  password: string
  filePath: string
}

export type FieldName =
  'name' | 'engine' | 'host' | 'port' | 'user' | 'database' | 'ssl' | 'password' | 'filePath'
export type FieldErrors = Partial<Record<FieldName, string>>

export type ProfileRequest = ConnectionProfileInput | ConnectionProfileUpdate
export type BuildResult = { ok: true; request: ProfileRequest } | { ok: false; errors: FieldErrors }

export const DEFAULT_POSTGRES_PORT = '5432'

/** Orden visual de los campos: sirve para enfocar el primer error. */
export const FIELD_ORDER: readonly FieldName[] = [
  'name',
  'engine',
  'host',
  'port',
  'user',
  'database',
  'ssl',
  'password',
  'filePath',
]

const FIELD_MESSAGES: Record<FieldName, string> = {
  name: 'Escribe un nombre de entre 1 y 100 caracteres.',
  engine: 'Elige un motor de base de datos.',
  host: 'Escribe un host válido, sin espacios ni caracteres como / \\ @ ? #.',
  port: 'Escribe un puerto entero entre 1 y 65535.',
  user: 'Escribe el usuario (máximo 128 caracteres).',
  database: 'Escribe el nombre de la base de datos (máximo 128 caracteres).',
  ssl: 'Elige un modo SSL.',
  password: 'La contraseña no es válida (máximo 1024 caracteres).',
  filePath: 'Elige un archivo SQLite con el botón «Elegir archivo».',
}

export const PASSWORD_REENTRY_MESSAGE =
  'Has cambiado el host, el puerto o el usuario: vuelve a escribir la contraseña.'

export function emptyDraft(): ProfileDraft {
  return {
    engine: 'postgres',
    name: '',
    readOnly: false,
    host: '',
    port: DEFAULT_POSTGRES_PORT,
    user: '',
    database: '',
    ssl: 'disable',
    password: '',
    filePath: '',
  }
}

export function draftFromProfile(profile: ConnectionProfile | null): ProfileDraft {
  const draft = emptyDraft()
  if (!profile) return draft
  draft.engine = profile.engine
  draft.name = profile.name
  draft.readOnly = profile.readOnly
  if (profile.engine === 'sqlite') {
    draft.filePath = profile.filePath
  } else {
    draft.host = profile.host
    draft.port = String(profile.port)
    draft.user = profile.user
    draft.database = profile.database
    draft.ssl = profile.ssl
  }
  return draft
}

export function hasStoredPassword(stored: ConnectionProfile | null): boolean {
  return stored?.engine === 'postgres' && stored.secretRef !== undefined
}

/**
 * Refleja la regla de main (`assertStoredSecretReusable`): la password guardada solo se reutiliza
 * contra el mismo host, puerto y usuario. La barrera real sigue siendo main.
 */
export function requiresPasswordReentry(
  draft: ProfileDraft,
  stored: ConnectionProfile | null,
): boolean {
  if (stored?.engine !== 'postgres' || stored.secretRef === undefined) return false
  if (draft.engine !== 'postgres' || draft.password !== '') return false
  return !(
    stored.host.toLowerCase() === draft.host.trim().toLowerCase() &&
    String(stored.port) === draft.port.trim() &&
    stored.user === draft.user
  )
}

function parsePort(raw: string): number | undefined {
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : Number(trimmed)
}

function toCandidate(draft: ProfileDraft, storedId: string | undefined): unknown {
  const common = {
    ...(storedId === undefined ? {} : { id: storedId }),
    name: draft.name,
    readOnly: draft.readOnly,
  }
  if (draft.engine === 'sqlite') {
    return { ...common, engine: 'sqlite', filePath: draft.filePath }
  }
  return {
    ...common,
    engine: 'postgres',
    host: draft.host,
    port: parsePort(draft.port),
    user: draft.user,
    database: draft.database,
    ssl: draft.ssl,
    ...(draft.password === '' ? {} : { password: draft.password }),
  }
}

function isFieldName(value: unknown): value is FieldName {
  return typeof value === 'string' && (FIELD_ORDER as readonly string[]).includes(value)
}

/**
 * Valida el borrador con los schemas de `@strata/contracts` y devuelve la petición lista para IPC
 * (con los valores ya normalizados por el schema) o mensajes propios por campo. El texto de Zod no
 * se muestra: puede citar el valor enviado, p. ej. una password.
 */
export function buildRequest(draft: ProfileDraft, stored: ConnectionProfile | null): BuildResult {
  const errors: FieldErrors = {}
  if (requiresPasswordReentry(draft, stored)) errors.password = PASSWORD_REENTRY_MESSAGE

  const schema = stored ? ConnectionProfileUpdateSchema : ConnectionProfileInputSchema
  const parsed = schema.safeParse(toCandidate(draft, stored?.id))
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0]
      if (isFieldName(field) && errors[field] === undefined) errors[field] = FIELD_MESSAGES[field]
    }
  }

  if (!parsed.success && Object.keys(errors).length === 0) errors.engine = FIELD_MESSAGES.engine
  if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, request: parsed.data }
}

/** Petición de prueba de un perfil ya guardado: sin password, main reutiliza la guardada. */
export function requestFromStored(profile: ConnectionProfile): ConnectionProfileUpdate {
  const common = { id: profile.id, name: profile.name, readOnly: profile.readOnly }
  if (profile.engine === 'sqlite') {
    return { ...common, engine: 'sqlite', filePath: profile.filePath }
  }
  return {
    ...common,
    engine: 'postgres',
    host: profile.host,
    port: profile.port,
    user: profile.user,
    database: profile.database,
    ssl: profile.ssl,
  }
}
