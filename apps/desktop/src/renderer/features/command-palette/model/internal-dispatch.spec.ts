import { INTERNAL_COMMANDS, parseInternalCommand, type InternalInvocation } from '@strata/commands'
import { describe, expect, it } from 'vitest'
import { APP_COMMANDS } from '../commands'
import type { ConnectionSummary, SchemaSummary } from './context'
import { commandIdOfInternal, resolveInternal } from './internal-dispatch'

const context: { connections: ConnectionSummary[]; schema: SchemaSummary } = {
  connections: [
    { id: 'pg1', name: 'Producción', engine: 'postgres', readOnly: false, status: 'connected' },
  ],
  schema: {
    schemas: ['public'],
    tables: [{ schema: 'public', name: 'users', kind: 'table', qualifiedName: 'public.users' }],
  },
}

function invocation(input: string): InternalInvocation {
  const parsed = parseInternalCommand(input)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.invocation
}

describe('commandIdOfInternal', () => {
  it('maps every internal command to a registered command that declares it', () => {
    for (const spec of INTERNAL_COMMANDS) {
      const id = commandIdOfInternal(spec.name)
      const command = APP_COMMANDS.find((entry) => entry.id === id)
      expect(command, `${spec.name} -> ${id}`).toBeDefined()
      expect(command?.internal).toBe(spec.name)
    }
  })
})

describe('resolveInternal', () => {
  it('resolves the connection name into a profile id', () => {
    expect(resolveInternal(context, invocation('\\connect producción'))).toEqual({
      ok: true,
      value: { commandId: 'connection.connect', args: { profileId: 'pg1' } },
    })
    expect(resolveInternal(context, invocation('\\connect nada'))).toMatchObject({ ok: false })
  })

  it('resolves schemas and tables against the loaded catalogue', () => {
    expect(resolveInternal(context, invocation('\\tables'))).toEqual({
      ok: true,
      value: { commandId: 'schema.tables', args: {} },
    })
    expect(resolveInternal(context, invocation('\\tables PUB'))).toEqual({
      ok: true,
      value: { commandId: 'schema.tables', args: { schema: 'public' } },
    })
    expect(resolveInternal(context, invocation('\\tables zzz'))).toMatchObject({ ok: false })
    expect(resolveInternal(context, invocation('\\describe users'))).toEqual({
      ok: true,
      value: { commandId: 'schema.describe', args: { table: 'public.users' } },
    })
    expect(resolveInternal(context, invocation('\\describe nope'))).toMatchObject({ ok: false })
  })

  it('passes modes through and needs nothing for the rest', () => {
    expect(resolveInternal(context, invocation('\\theme light'))).toEqual({
      ok: true,
      value: { commandId: 'theme.set', args: { mode: 'light' } },
    })
    expect(resolveInternal(context, invocation('\\timing'))).toEqual({
      ok: true,
      value: { commandId: 'preferences.timing', args: {} },
    })
    for (const name of ['disconnect', 'connections', 'schemas', 'history', 'clear']) {
      expect(resolveInternal(context, invocation(`\\${name}`))).toMatchObject({ ok: true })
    }
  })
})
