import type { CredentialStore } from './credential-store'

/**
 * Difiere la creación del almacén hasta el primer uso: así arrancar la app, o listar y gestionar perfiles
 * sin password, no toca `safeStorage` ni dispara el diálogo de Keychain de macOS.
 */
export function createLazyCredentialStore(create: () => CredentialStore): CredentialStore {
  let store: CredentialStore | undefined
  const resolve = (): CredentialStore => (store ??= create())

  return {
    save: (secret, secretRef) => resolve().save(secret, secretRef),
    get: (secretRef) => resolve().get(secretRef),
    has: (secretRef) => resolve().has(secretRef),
    delete: (secretRef) => resolve().delete(secretRef),
    clearAll: () => resolve().clearAll(),
  }
}
