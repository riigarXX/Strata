import {
  CancelRequestSchema,
  CancelResultSchema,
  ChunkAckSchema,
  IPC_CHANNELS,
  QueryRequestSchema,
  type CancelRequest,
  type ChunkAck,
  type QueryRequest,
} from '@strata/contracts'
import type { IpcSenderLike } from '../security/sender-validation'
import type { QueryExecutor } from '../services/query-executor'
import {
  createSecureHandlerFactory,
  nothing,
  type IpcHandler,
  type SecureHandlerDependencies,
} from './secure-handler'
import { createWebContentsSink, type EventTargetWebContents } from './web-contents-sink'

export type QueryIpcEvent = IpcSenderLike & {
  sender: IpcSenderLike['sender'] & EventTargetWebContents
}

export interface QueryHandlersDependencies extends SecureHandlerDependencies {
  queryExecutor: QueryExecutor
}

/**
 * `execute` responde en cuanto la ejecución queda aceptada; el resultado llega después como `QueryEvent`
 * por `IPC_CHANNELS.query.event`, solo al solicitante (ADR 0010). `cancel` y `ack` solo actúan sobre
 * ejecuciones de ese mismo solicitante.
 */
export function createQueryHandlers({
  queryExecutor,
  ...security
}: QueryHandlersDependencies): Readonly<Record<string, IpcHandler<QueryIpcEvent>>> {
  const channels = IPC_CHANNELS.query
  const secure = createSecureHandlerFactory(security)

  return {
    [channels.execute]: secure<QueryRequest, QueryIpcEvent>({
      input: QueryRequestSchema,
      output: nothing,
      run: async (request, { sender }) => {
        queryExecutor.execute(request, createWebContentsSink(sender))
      },
    }),
    [channels.cancel]: secure<CancelRequest, QueryIpcEvent>({
      input: CancelRequestSchema,
      output: CancelResultSchema,
      run: ({ requestId }, { sender }) => queryExecutor.cancel(requestId, sender),
    }),
    [channels.ack]: secure<ChunkAck, QueryIpcEvent>({
      input: ChunkAckSchema,
      output: nothing,
      run: async (ack, { sender }) => {
        queryExecutor.ack(ack, sender)
      },
    }),
  }
}
