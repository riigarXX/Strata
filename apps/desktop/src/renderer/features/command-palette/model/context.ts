import type { Engine, ThemePreference, TableKind } from '@strata/contracts'
import type { ConnectionUiStatus } from '../../connections'
import type { ActionAvailability, ExecutionAction } from '../../execution/model/availability'
import type { TransactionAction } from '../../execution/model/presentation'
import type { SchemaTarget } from '../../schema-browser'
import type { SettingsSection } from '../../settings/stores/settings'

export type ConnectionStatus = ConnectionUiStatus

/**
 * Lo único que los comandos saben de una conexión. Sin host, usuario, ruta de archivo ni `secretRef`:
 * el contexto se inyecta en cada comando y no debe arrastrar nada que no haga falta para elegirla.
 */
export interface ConnectionSummary {
  readonly id: string
  readonly name: string
  readonly engine: Engine
  readonly readOnly: boolean
  readonly status: ConnectionStatus
}

export interface TableSummary {
  readonly schema: string
  readonly name: string
  readonly kind: TableKind
  /** Nombre listo para pegar en una consulta (cualificado y citado según el motor). */
  readonly qualifiedName: string
}

/** Catálogo ya cargado en la caché de la sesión activa: nunca provoca peticiones nuevas. */
export interface SchemaSummary {
  readonly schemas: readonly string[]
  readonly tables: readonly TableSummary[]
}

export interface ExecutionSummary {
  readonly availability: Readonly<Record<ExecutionAction, ActionAvailability>>
  /** `false` mientras hay una ejecución u operación de transacción en curso. */
  readonly idle: boolean
  /** La última ejecución de la pestaña dejó una entrada en el historial que aún se puede quitar. */
  readonly canExcludeFromHistory: boolean
}

export type PaletteMode = 'commands' | 'goto'

export interface AppCommandActions {
  newTab(): void
  closeActiveTab(): void
  selectRelativeTab(delta: 1 | -1): void
  selectTabAt(index: number): void
  selectLastTab(): void
  run(): Promise<void>
  runAll(): Promise<void>
  cancel(): Promise<void>
  transaction(action: TransactionAction): Promise<void>
  openSettings(section?: SettingsSection): void
  openHistory(): void
  /** Abre el diálogo «Preguntar a la base» (IA local). */
  openAsk(): void
  excludeFromHistory(): Promise<void>
  formatDocument(): Promise<boolean>
  focusEditor(): boolean
  refreshSchema(): void
  revealInSchema(target: SchemaTarget | null): Promise<boolean>
  insertText(text: string): void
  openConnections(): void
  connect(profileId: string): Promise<void>
  disconnect(profileId: string): Promise<void>
  openPalette(mode: PaletteMode, query?: string): void
  togglePalette(): void
  setTiming(value: boolean | 'toggle'): boolean
  /** Guarda el tema en las preferencias; `false` si no se pudo guardar. */
  setTheme(theme: ThemePreference): Promise<boolean>
  clearActiveTab(): boolean
  /** Anuncia un mensaje a las tecnologías de apoyo (región `aria-live` de la paleta). */
  announce(message: string): void
}

/**
 * Contexto que se inyecta a `when` y `run` de todos los comandos de la aplicación: hechos de solo lectura
 * (reactivos: se leen dentro de `computed`) más las acciones que pueden ejecutar. El registro de
 * comandos no sabe de Vue ni de Pinia; toda la fontanería vive en `stores/command-center.ts`.
 */
export interface AppCommandContext {
  readonly tabs: { readonly count: number; readonly activeIndex: number }
  readonly connections: readonly ConnectionSummary[]
  /** Conexión que gobierna el workspace: la de la pestaña activa o, si no la tiene, la seleccionada. */
  readonly activeConnection: ConnectionSummary | null
  readonly schema: SchemaSummary | null
  /** `null` sin pestaña activa. */
  readonly execution: ExecutionSummary | null
  readonly editorReady: boolean
  readonly preferences: { readonly theme: ThemePreference; readonly showTiming: boolean }
  readonly paletteOpen: boolean
  readonly actions: AppCommandActions
}
