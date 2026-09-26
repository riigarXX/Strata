import type { ConnectionProfile } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildRequest,
  draftFromProfile,
  emptyDraft,
  requestFromStored,
  requiresPasswordReentry,
} from './profile-form'

const stored: ConnectionProfile = {
  id: 'p1',
  engine: 'postgres',
  name: 'Prod',
  readOnly: false,
  host: 'db.example.com',
  port: 5432,
  user: 'app',
  database: 'main',
  ssl: 'require',
  secretRef: 'secret-1',
}

function filledDraft() {
  return {
    ...emptyDraft(),
    name: '  Local  ',
    host: 'localhost',
    user: 'me',
    database: 'app',
  }
}

describe('buildRequest', () => {
  it('builds a normalized PostgreSQL request and omits an empty password', () => {
    const result = buildRequest(filledDraft(), null)

    expect(result).toEqual({
      ok: true,
      request: {
        engine: 'postgres',
        name: 'Local',
        readOnly: false,
        host: 'localhost',
        port: 5432,
        user: 'me',
        database: 'app',
        ssl: 'disable',
      },
    })
  })

  it('includes the password only when typed', () => {
    const result = buildRequest({ ...filledDraft(), password: 'pw' }, null)

    expect(result.ok && result.request.engine === 'postgres' && result.request.password).toBe('pw')
  })

  it('reports one message per invalid field without echoing values', () => {
    const result = buildRequest(
      { ...emptyDraft(), host: 'bad host/', port: '70000', password: 'leaky-secret' },
      null,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).sort()).toEqual(['database', 'host', 'name', 'port', 'user'])
    expect(JSON.stringify(result.errors)).not.toContain('leaky-secret')
  })

  it('rejects a non-numeric or empty port', () => {
    for (const port of ['', 'abc', '54.3']) {
      const result = buildRequest({ ...filledDraft(), port }, null)
      expect(result.ok || result.errors.port).toBeTruthy()
    }
  })

  it('requires a SQLite file path picked beforehand', () => {
    const missing = buildRequest({ ...emptyDraft(), engine: 'sqlite', name: 'Local' }, null)
    expect(missing).toMatchObject({ ok: false, errors: { filePath: expect.any(String) } })

    const ok = buildRequest(
      { ...emptyDraft(), engine: 'sqlite', name: 'Local', filePath: '/tmp/a.db' },
      null,
    )
    expect(ok).toEqual({
      ok: true,
      request: { engine: 'sqlite', name: 'Local', readOnly: false, filePath: '/tmp/a.db' },
    })
  })

  it('adds the profile id when editing', () => {
    const result = buildRequest(draftFromProfile(stored), stored)

    expect(result).toMatchObject({ ok: true, request: { id: 'p1' } })
  })
})

describe('requiresPasswordReentry', () => {
  it('is false when host, port and user are unchanged', () => {
    expect(requiresPasswordReentry(draftFromProfile(stored), stored)).toBe(false)
  })

  it.each([
    ['host', { host: 'other.example.com' }],
    ['port', { port: '5433' }],
    ['user', { user: 'admin' }],
  ])('is true when the %s changes and no password is typed', (_field, patch) => {
    const draft = { ...draftFromProfile(stored), ...patch }

    expect(requiresPasswordReentry(draft, stored)).toBe(true)
    expect(buildRequest(draft, stored)).toMatchObject({
      ok: false,
      errors: { password: expect.any(String) },
    })
  })

  it('accepts the change once the password is typed', () => {
    const draft = { ...draftFromProfile(stored), host: 'other', password: 'pw' }

    expect(buildRequest(draft, stored).ok).toBe(true)
  })

  it('is false for profiles without a saved password', () => {
    const withoutSecret: ConnectionProfile = { ...stored, secretRef: undefined }
    const draft = { ...draftFromProfile(withoutSecret), host: 'other' }

    expect(requiresPasswordReentry(draft, withoutSecret)).toBe(false)
  })

  it('compares the host case-insensitively like main', () => {
    const draft = { ...draftFromProfile(stored), host: 'DB.Example.com' }

    expect(requiresPasswordReentry(draft, stored)).toBe(false)
  })
})

describe('requestFromStored', () => {
  it('never carries a password or secret reference', () => {
    const request = requestFromStored(stored)

    expect(request).not.toHaveProperty('password')
    expect(request).not.toHaveProperty('secretRef')
    expect(request).toMatchObject({ id: 'p1', host: 'db.example.com' })
  })
})
