import { buildInternalInput, disabled, ENABLED } from '@strata/commands'
import { resolveConnection } from '../model/resolve'
import { CATEGORIES, needsConnection, stringArg, type AppCommand } from './helpers'

const category = CATEGORIES.connections

export const CONNECTION_COMMANDS: readonly AppCommand[] = [
  {
    id: 'connection.connect',
    title: 'Conectar a…',
    description: 'Conecta a un perfil guardado y lo asocia a la pestaña activa.',
    category,
    keywords: ['conexión', 'base de datos', 'abrir', 'connect'],
    internal: 'connect',
    when: ({ connections }) =>
      connections.length > 0 ? ENABLED : disabled('No hay conexiones guardadas'),
    run: async (context, args) => {
      const profileId = stringArg(args, 'profileId')
      const name = stringArg(args, 'name')
      if (profileId === undefined && name === undefined) {
        context.actions.openPalette('commands', `${buildInternalInput('connect')} `)
        return
      }
      if (profileId !== undefined) return context.actions.connect(profileId)
      const found = resolveConnection(context.connections, name ?? '')
      if (!found.ok) throw new Error(found.message)
      await context.actions.connect(found.value.id)
    },
  },
  {
    id: 'connection.disconnect',
    title: 'Desconectar',
    description: 'Cierra la conexión activa.',
    category,
    keywords: ['cerrar', 'conexión', 'disconnect'],
    internal: 'disconnect',
    when: needsConnection,
    run: async ({ activeConnection, actions }) => {
      if (activeConnection) await actions.disconnect(activeConnection.id)
    },
  },
  {
    id: 'connection.manage',
    title: 'Gestionar conexiones',
    description: 'Crea, edita o elimina perfiles de conexión.',
    category,
    keywords: ['perfiles', 'conexiones', 'nueva', 'editar', 'connections'],
    internal: 'connections',
    run: ({ actions }) => actions.openConnections(),
  },
]
