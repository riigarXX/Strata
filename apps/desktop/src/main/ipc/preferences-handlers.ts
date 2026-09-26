import { IPC_CHANNELS, PreferencesPatchSchema, PreferencesSchema } from '@strata/contracts'
import type { PreferencesStore } from '../services/preferences-store'
import {
  createSecureHandlerFactory,
  nothing,
  type IpcHandler,
  type SecureHandlerDependencies,
} from './secure-handler'

export interface PreferencesHandlersDependencies extends SecureHandlerDependencies {
  preferencesStore: Pick<PreferencesStore, 'get' | 'update'>
}

/** `update` recibe un parche parcial y responde con las preferencias completas ya persistidas. */
export function createPreferencesHandlers({
  preferencesStore,
  ...security
}: PreferencesHandlersDependencies): Readonly<Record<string, IpcHandler>> {
  const channels = IPC_CHANNELS.preferences
  const secure = createSecureHandlerFactory(security)

  return {
    [channels.get]: secure({
      input: nothing,
      output: PreferencesSchema,
      run: () => preferencesStore.get(),
    }),
    [channels.update]: secure({
      input: PreferencesPatchSchema,
      output: PreferencesSchema,
      run: (patch) => preferencesStore.update(patch),
    }),
  }
}
