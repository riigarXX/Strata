import type { InternalInvocation } from '@strata/commands'
import type { CommandArgs } from '@strata/commands'
import type { AppCommandContext } from './context'
import {
  qualified,
  resolveConnection,
  resolveSchema,
  resolveTable,
  type Resolution,
} from './resolve'

/** Comando del registro que atiende cada comando interno, con los argumentos ya resueltos contra el contexto. */
export interface InternalTarget {
  commandId: string
  args: CommandArgs
}

const COMMAND_IDS = {
  connect: 'connection.connect',
  disconnect: 'connection.disconnect',
  connections: 'connection.manage',
  schemas: 'schema.show',
  tables: 'schema.tables',
  describe: 'schema.describe',
  history: 'history.open',
  ask: 'ask.open',
  timing: 'preferences.timing',
  clear: 'results.clear',
  theme: 'theme.set',
} as const

export const commandIdOfInternal = (name: InternalInvocation['command']): string =>
  COMMAND_IDS[name]

/**
 * Traduce lo que analizó el parser a un comando y argumentos concretos, resolviendo los nombres
 * (conexión, esquema, tabla) contra lo que ya hay cargado. Es lo que permite mostrar el error en la
 * propia paleta, con ella abierta, en lugar de fallar después de cerrarla.
 */
export function resolveInternal(
  context: Pick<AppCommandContext, 'connections' | 'schema'>,
  invocation: InternalInvocation,
): Resolution<InternalTarget> {
  const commandId = COMMAND_IDS[invocation.command]
  const done = (args: CommandArgs = {}): Resolution<InternalTarget> => ({
    ok: true,
    value: { commandId, args },
  })

  switch (invocation.command) {
    case 'connect': {
      const found = resolveConnection(context.connections, invocation.args.name)
      return found.ok ? done({ profileId: found.value.id }) : found
    }
    case 'tables': {
      if (invocation.args.schema === undefined) return done()
      const found = resolveSchema(context.schema, invocation.args.schema)
      return found.ok ? done({ schema: found.value }) : found
    }
    case 'describe': {
      const found = resolveTable(context.schema, invocation.args.table)
      return found.ok ? done({ table: qualified(found.value) }) : found
    }
    case 'timing':
    case 'theme':
      return done(invocation.args.mode === undefined ? {} : { mode: invocation.args.mode })
    default:
      return done()
  }
}
