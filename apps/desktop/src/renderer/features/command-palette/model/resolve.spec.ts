import { describe, expect, it } from 'vitest'
import type { ConnectionSummary, SchemaSummary } from './context'
import { resolveConnection, resolveSchema, resolveTable } from './resolve'

const connection = (id: string, name: string): ConnectionSummary => ({
  id,
  name,
  engine: 'postgres',
  readOnly: false,
  status: 'disconnected',
})

const CONNECTIONS = [
  connection('a', 'Producción'),
  connection('b', 'Producción réplica'),
  connection('c', 'Local'),
]

const table = (schema: string, name: string) => ({
  schema,
  name,
  kind: 'table' as const,
  qualifiedName: `${schema}.${name}`,
})

const SCHEMA: SchemaSummary = {
  schemas: ['public', 'sales', 'staging'],
  tables: [
    table('public', 'users'),
    table('public', 'orders'),
    table('sales', 'orders'),
    table('sales', 'Invoice Lines'),
  ],
}

describe('resolveConnection', () => {
  it('prefers an exact match ignoring case and accents', () => {
    expect(resolveConnection(CONNECTIONS, 'produccion')).toEqual({
      ok: true,
      value: CONNECTIONS[0],
    })
    expect(resolveConnection(CONNECTIONS, 'LOCAL')).toEqual({ ok: true, value: CONNECTIONS[2] })
  })

  it('falls back to a unique prefix and then a unique substring', () => {
    expect(resolveConnection(CONNECTIONS, 'Loc')).toEqual({ ok: true, value: CONNECTIONS[2] })
    expect(resolveConnection(CONNECTIONS, 'cal')).toEqual({ ok: true, value: CONNECTIONS[2] })
  })

  it('reports ambiguity with the candidates', () => {
    const result = resolveConnection(CONNECTIONS, 'Prod')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) {
      expect(result.message).toContain('«Producción», «Producción réplica»')
      expect(result.message).toContain('nombre completo')
    }
  })

  it('reports an unknown connection listing the available ones', () => {
    const result = resolveConnection(CONNECTIONS, 'staging')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('«staging»')
      expect(result.message).toContain('«Local»')
    }
  })

  it('handles no saved connections and an empty query', () => {
    expect(resolveConnection([], 'x')).toEqual({
      ok: false,
      message: 'No hay conexiones guardadas.',
    })
    expect(resolveConnection(CONNECTIONS, '  ').ok).toBe(false)
  })
})

describe('resolveSchema', () => {
  it('finds exact, prefix and unique matches', () => {
    expect(resolveSchema(SCHEMA, 'PUBLIC')).toEqual({ ok: true, value: 'public' })
    expect(resolveSchema(SCHEMA, 'sal')).toEqual({ ok: true, value: 'sales' })
  })

  it('reports ambiguity, typos with suggestions and a missing catalogue', () => {
    const ambiguous = resolveSchema(SCHEMA, 's')
    expect(ambiguous.ok).toBe(false)
    const typo = resolveSchema(SCHEMA, 'publik')
    expect(typo).toMatchObject({ ok: false })
    if (!typo.ok) expect(typo.message).toContain('¿Quisiste decir «public»?')
    const none = resolveSchema(SCHEMA, 'zzz')
    if (!none.ok) expect(none.message).toContain('Esquemas: «public», «sales», «staging»')
    expect(resolveSchema(null, 'public')).toMatchObject({ ok: false })
  })
})

describe('resolveTable', () => {
  it('resolves schema.table and a bare table name that is unique', () => {
    expect(resolveTable(SCHEMA, 'public.users')).toMatchObject({ ok: true })
    expect(resolveTable(SCHEMA, 'users')).toMatchObject({ ok: true, value: { name: 'users' } })
    expect(resolveTable(SCHEMA, 'INVOICE LINES')).toMatchObject({
      ok: true,
      value: { schema: 'sales' },
    })
  })

  it('asks for the schema when the name exists in several', () => {
    const result = resolveTable(SCHEMA, 'orders')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('«public.orders», «sales.orders»')
    expect(resolveTable(SCHEMA, 'sales.orders')).toMatchObject({ ok: true })
  })

  it('suggests close names and mentions that only loaded tables are searched', () => {
    const result = resolveTable(SCHEMA, 'public.usres')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('¿Quisiste decir «public.users»')
      expect(result.message).toContain('ya cargadas')
    }
    expect(resolveTable(null, 'users')).toMatchObject({ ok: false })
  })
})
