import { disabled, ENABLED, type Availability, type CommandDefinition } from '@strata/commands'
import type { ExecutionAction } from '../../execution/model/availability'
import type { AppCommandContext } from '../model/context'

export type AppCommand = CommandDefinition<AppCommandContext>

/** Categorías en el orden en que se muestran; también desempatan la búsqueda. */
export const CATEGORIES = {
  tabs: 'Pestañas',
  query: 'Consulta',
  transaction: 'Transacción',
  editor: 'Editor',
  schema: 'Esquema',
  connections: 'Conexiones',
  app: 'Aplicación',
} as const

export const CATEGORY_ORDER: readonly string[] = Object.values(CATEGORIES)

export const NO_TABS = 'No hay ninguna pestaña abierta'
export const NO_CONNECTION = 'Requiere una conexión activa'

export function needsTab(context: AppCommandContext): Availability {
  return context.tabs.count > 0 ? ENABLED : disabled(NO_TABS)
}

export function needsConnection(context: AppCommandContext): Availability {
  return context.activeConnection ? ENABLED : disabled(NO_CONNECTION)
}

/** Disponibilidad de una acción de la barra de ejecución: la misma que ven sus botones. */
export function executionAction(
  action: ExecutionAction,
): (context: AppCommandContext) => Availability {
  return ({ execution }) => {
    if (!execution) return disabled(NO_TABS)
    const state = execution.availability[action]
    return state.enabled ? ENABLED : disabled(state.reason ?? 'No disponible ahora mismo')
  }
}

export function stringArg(
  args: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = args?.[key]
  return typeof value === 'string' ? value : undefined
}
