import { DEFAULT_PREFERENCES } from '@strata/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { usePreferencesApi } from './use-preferences-api'

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
})

describe('usePreferencesApi', () => {
  it('passes the patch through and returns the validated preferences', async () => {
    const fake = createFakeDb()
    installFakeDb(fake.db)

    const result = await usePreferencesApi().update({ appearance: { theme: 'dark' } })

    expect(fake.preferences.update).toHaveBeenCalledWith({ appearance: { theme: 'dark' } })
    expect(result).toEqual({
      ok: true,
      data: { ...DEFAULT_PREFERENCES, appearance: { theme: 'dark' } },
    })
  })

  it('turns an exception, a missing bridge or a malformed answer into a normalised error', async () => {
    const fake = createFakeDb()
    installFakeDb(fake.db)
    fake.preferences.get.mockRejectedValueOnce(new Error('sender rejected'))
    expect(await usePreferencesApi().get()).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    })

    fake.preferences.get.mockResolvedValueOnce(ipcOk({ theme: 'dark' } as never))
    expect(await usePreferencesApi().get()).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    })

    Reflect.deleteProperty(window, 'db')
    expect(await usePreferencesApi().get()).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    })
  })
})
