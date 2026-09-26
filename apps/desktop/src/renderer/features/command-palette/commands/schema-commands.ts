import { buildInternalInput, disabled, ENABLED } from '@strata/commands'
import type { AppCommandContext } from '../model/context'
import { resolveSchema, resolveTable } from '../model/resolve'
import { CATEGORIES, NO_CONNECTION, stringArg, type AppCommand } from './helpers'

const category = CATEGORIES.schema

const needsSchema = ({ schema }: AppCommandContext) => (schema ? ENABLED : disabled(NO_CONNECTION))

/** Esquema con el que abrir el explorador si no se indica: el habitual de cada motor, o el primero. */
function defaultSchema(schemas: readonly string[]): string | null {
  return schemas.find((name) => name === 'public' || name === 'main') ?? schemas[0] ?? null
}

export const SCHEMA_COMMANDS: readonly AppCommand[] = [
  {
    id: 'schema.refresh',
    title: 'Actualizar esquema',
    description: 'Vuelve a leer del servidor los esquemas, tablas y vistas.',
    category,
    keywords: ['recargar', 'refrescar', 'metadatos', 'refresh'],
    when: needsSchema,
    run: ({ actions }) => actions.refreshSchema(),
  },
  {
    id: 'schema.show',
    title: 'Ir al explorador de esquemas',
    description: 'Lleva el foco al explorador y quita el filtro.',
    category,
    keywords: ['schemas', 'esquemas', 'árbol', 'explorador'],
    internal: 'schemas',
    when: needsSchema,
    run: async ({ actions }) => {
      await actions.revealInSchema(null)
    },
  },
  {
    id: 'schema.tables',
    title: 'Mostrar tablas de un esquema',
    description: 'Expande un esquema en el explorador y lleva el foco a él.',
    category,
    keywords: ['tablas', 'vistas', 'tables', 'schema'],
    internal: 'tables',
    when: needsSchema,
    run: async ({ schema, actions }, args) => {
      const wanted = stringArg(args, 'schema')
      if (wanted !== undefined) {
        const found = resolveSchema(schema, wanted)
        if (!found.ok) throw new Error(found.message)
        await actions.revealInSchema({ schema: found.value })
        return
      }
      const fallback = defaultSchema(schema?.schemas ?? [])
      await actions.revealInSchema(fallback === null ? null : { schema: fallback })
    },
  },
  {
    id: 'schema.describe',
    title: 'Describir tabla…',
    description: 'Muestra en el explorador las columnas, claves e índices de una tabla.',
    category,
    keywords: ['columnas', 'estructura', 'describe', 'tabla', 'vista'],
    internal: 'describe',
    when: needsSchema,
    run: async ({ schema, actions }, args) => {
      const wanted = stringArg(args, 'table')
      if (wanted === undefined) {
        actions.openPalette('commands', `${buildInternalInput('describe')} `)
        return
      }
      const found = resolveTable(schema, wanted)
      if (!found.ok) throw new Error(found.message)
      await actions.revealInSchema({ schema: found.value.schema, table: found.value.name })
    },
  },
]
