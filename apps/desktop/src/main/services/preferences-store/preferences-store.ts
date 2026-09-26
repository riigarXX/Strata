import {
  applyPreferencesPatch,
  DEFAULT_PREFERENCES,
  PreferencesPatchSchema,
  PreferencesSchema,
  recoverPreferences,
  type Preferences,
  type PreferencesPatch,
} from '@strata/contracts'
import { createJsonFile, createSerialQueue, type StorageFileSystem } from '../local-storage'

export const PREFERENCES_FILE_NAME = 'preferences.json'

const FILE_VERSION = 1

export interface PreferencesStoreDependencies {
  fileSystem: StorageFileSystem
  filePath: string
}

export type PreferencesListener = (next: Preferences, previous: Preferences) => void

/**
 * Preferencias del usuario en un archivo propio (`preferences.json`, ADR 0009): sin secretos ni relación
 * con perfiles, credenciales o historial. Un archivo ilegible o inválido nunca tumba la app: se parte de
 * los valores por defecto (campo a campo) y se conserva una copia del original.
 */
export interface PreferencesStore {
  get(): Promise<Preferences>
  /** Aplica una actualización parcial y devuelve las preferencias completas ya persistidas. */
  update(patch: PreferencesPatch): Promise<Preferences>
  /** Se avisa tras cada cambio persistido; un fallo del oyente no afecta al resto. */
  subscribe(listener: PreferencesListener): () => void
}

interface Migrated {
  /** Contenido de las preferencias tal como estaba, aún sin validar. */
  preferences: unknown
  migrated: boolean
  damaged: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// v0 (sin `version`): las secciones colgaban de la raíz del archivo. v1: `{ version, preferences }`.
// Una versión posterior a la conocida se lee campo a campo con lo que se entienda de ella.
function migrate(parsed: unknown): Migrated {
  if (!isRecord(parsed)) return { preferences: undefined, migrated: false, damaged: true }
  if (!('version' in parsed)) return { preferences: parsed, migrated: true, damaged: false }
  const { version } = parsed
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { preferences: undefined, migrated: false, damaged: true }
  }
  const preferences = parsed['preferences']
  return { preferences, migrated: false, damaged: preferences === undefined }
}

const serialize = (preferences: Preferences): string =>
  JSON.stringify({ version: FILE_VERSION, preferences }, null, 2)

const copy = (preferences: Preferences): Preferences => PreferencesSchema.parse(preferences)

export function createPreferencesStore({
  fileSystem,
  filePath,
}: PreferencesStoreDependencies): PreferencesStore {
  const file = createJsonFile({
    fileSystem,
    filePath,
    failureMessage: 'Could not access the saved preferences',
  })
  const enqueue = createSerialQueue()
  const listeners = new Set<PreferencesListener>()
  let cache: Preferences | undefined

  async function load(): Promise<Preferences> {
    if (cache) return cache

    const raw = await file.read()
    if (raw === undefined) return (cache = copy(DEFAULT_PREFERENCES))

    let parsed: unknown
    let damaged = false
    try {
      parsed = JSON.parse(raw)
    } catch {
      damaged = true
    }
    const migration = damaged
      ? { preferences: undefined, migrated: false, damaged: true }
      : migrate(parsed)
    const recovered = recoverPreferences(migration.preferences)

    if (migration.damaged || recovered.damaged) await file.keepCorruptCopy(raw)
    cache = recovered.preferences
    if (migration.migrated) await file.write(serialize(cache)).catch(() => undefined)
    return cache
  }

  function notify(next: Preferences, previous: Preferences): void {
    for (const listener of [...listeners]) {
      try {
        listener(copy(next), copy(previous))
      } catch {
        // Un oyente defectuoso no debe impedir que el cambio ya persistido se aplique ni avisar a los demás.
      }
    }
  }

  return {
    get: () => enqueue(async () => copy(await load())),

    update: (patch) =>
      enqueue(async () => {
        const previous = await load()
        const next = applyPreferencesPatch(previous, PreferencesPatchSchema.parse(patch))
        if (JSON.stringify(next) === JSON.stringify(previous)) return copy(previous)
        await file.write(serialize(next))
        cache = next
        notify(next, previous)
        return copy(next)
      }),

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
