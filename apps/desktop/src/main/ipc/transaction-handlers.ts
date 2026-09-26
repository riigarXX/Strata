import { IPC_CHANNELS, TransactionRequestSchema, TransactionResultSchema } from '@strata/contracts'
import type { ConnectionManager } from '../services/connection-manager'
import {
  createSecureHandlerFactory,
  type IpcHandler,
  type SecureHandlerDependencies,
} from './secure-handler'

export interface TransactionHandlersDependencies extends SecureHandlerDependencies {
  connectionManager: Pick<ConnectionManager, 'begin' | 'commit' | 'rollback'>
}

/** Transacciones explícitas (ADR 0004): responden con el estado real que reporta el adapter, no con el pedido. */
export function createTransactionHandlers({
  connectionManager,
  ...security
}: TransactionHandlersDependencies): Readonly<Record<string, IpcHandler>> {
  const channels = IPC_CHANNELS.transaction
  const secure = createSecureHandlerFactory(security)
  const spec = {
    input: TransactionRequestSchema,
    output: TransactionResultSchema,
  }

  return {
    [channels.begin]: secure({ ...spec, run: (input) => connectionManager.begin(input) }),
    [channels.commit]: secure({ ...spec, run: (input) => connectionManager.commit(input) }),
    [channels.rollback]: secure({ ...spec, run: (input) => connectionManager.rollback(input) }),
  }
}
