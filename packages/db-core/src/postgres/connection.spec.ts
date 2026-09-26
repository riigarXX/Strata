import { describe, expect, it } from 'vitest'
import type { ResolvedPostgresProfile } from '../adapter'
import {
  clientConfigFor,
  formatVersionNumber,
  isSupportedPostgresVersion,
  redactionContextForPostgres,
} from './connection'

const profile: ResolvedPostgresProfile = {
  id: 'p1',
  name: 'main',
  engine: 'postgres',
  host: 'db.internal.example',
  port: 6543,
  user: 'alice',
  database: 'payroll',
  ssl: 'disable',
  readOnly: false,
  password: 's3cret-pass',
}

describe('clientConfigFor', () => {
  it('carries the profile parameters and a connection timeout', () => {
    expect(clientConfigFor(profile, { readOnly: false })).toMatchObject({
      host: 'db.internal.example',
      port: 6543,
      user: 'alice',
      database: 'payroll',
      password: 's3cret-pass',
      ssl: false,
      connectionTimeoutMillis: expect.any(Number),
    })
    expect(clientConfigFor(profile, { readOnly: false }).connectionTimeoutMillis).toBeGreaterThan(0)
  })

  it('maps the SSL mode: none, encrypted without verification, or fully verified', () => {
    expect(clientConfigFor({ ...profile, ssl: 'disable' }, { readOnly: false }).ssl).toBe(false)
    expect(clientConfigFor({ ...profile, ssl: 'require' }, { readOnly: false }).ssl).toEqual({
      rejectUnauthorized: false,
    })
    expect(clientConfigFor({ ...profile, ssl: 'verify-full' }, { readOnly: false }).ssl).toEqual({
      rejectUnauthorized: true,
    })
  })

  it('forces read-only transactions at connection time only for read-only sessions', () => {
    expect(clientConfigFor(profile, { readOnly: true }).options).toBe(
      '-c default_transaction_read_only=on',
    )
    expect(clientConfigFor(profile, { readOnly: false }).options).toBeUndefined()
  })

  it('leaves the password out when the profile has none', () => {
    const withoutPassword = { ...profile, password: undefined }
    expect(clientConfigFor(withoutPassword, { readOnly: false }).password).toBeUndefined()
  })
})

describe('redactionContextForPostgres', () => {
  it('lists everything that must not reach an error message', () => {
    expect(redactionContextForPostgres(profile)).toEqual({
      host: 'db.internal.example',
      user: 'alice',
      database: 'payroll',
      secrets: ['s3cret-pass'],
    })
    expect(redactionContextForPostgres({ ...profile, password: undefined }).secrets).toEqual([])
  })
})

describe('version checks', () => {
  it('accepts PostgreSQL 13 and later', () => {
    expect(isSupportedPostgresVersion(130000)).toBe(true)
    expect(isSupportedPostgresVersion(130023)).toBe(true)
    expect(isSupportedPostgresVersion(170004)).toBe(true)
  })

  it('rejects older or unreadable versions', () => {
    expect(isSupportedPostgresVersion(129999)).toBe(false)
    expect(isSupportedPostgresVersion(120022)).toBe(false)
    expect(isSupportedPostgresVersion(90624)).toBe(false)
    expect(isSupportedPostgresVersion(Number.NaN)).toBe(false)
  })

  it('honors a different minimum', () => {
    expect(isSupportedPostgresVersion(150000, 16)).toBe(false)
    expect(isSupportedPostgresVersion(160000, 16)).toBe(true)
  })

  it('formats server_version_num as major.minor', () => {
    expect(formatVersionNumber(170004)).toBe('17.4')
    expect(formatVersionNumber(130023)).toBe('13.23')
  })
})
