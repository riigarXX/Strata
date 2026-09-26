// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { CredentialStore } from './credential-store'
import { createLazyCredentialStore } from './lazy-credential-store'

function createStubStore(): CredentialStore {
  return {
    save: vi.fn(async () => 'ref'),
    get: vi.fn(async () => 'secret'),
    has: vi.fn(async () => true),
    delete: vi.fn(async () => true),
    clearAll: vi.fn(async () => {}),
  }
}

describe('createLazyCredentialStore', () => {
  it('no crea el almacén hasta el primer uso', () => {
    const create = vi.fn(createStubStore)

    createLazyCredentialStore(create)

    expect(create).not.toHaveBeenCalled()
  })

  it('lo crea una sola vez y delega en él', async () => {
    const stub = createStubStore()
    const create = vi.fn(() => stub)
    const store = createLazyCredentialStore(create)

    expect(await store.save('pw', 'ref')).toBe('ref')
    expect(await store.get('ref')).toBe('secret')
    await store.has('ref')
    await store.delete('ref')
    await store.clearAll()

    expect(create).toHaveBeenCalledOnce()
    expect(stub.save).toHaveBeenCalledWith('pw', 'ref')
  })
})
