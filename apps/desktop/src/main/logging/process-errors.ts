import type { Logger } from './logger'

type ErrorEmitter = Pick<NodeJS.Process, 'on'>

/**
 * Sin estos listeners Electron muestra un diálogo con el mensaje y la pila del error del proceso main, que
 * pueden incluir host, usuario o rutas. Con ellos el fallo queda como una línea redactada.
 */
export function installProcessErrorLogging(emitter: ErrorEmitter, logger: Logger): void {
  emitter.on('uncaughtException', (reason) => {
    logger.error('Uncaught exception in the main process', reason)
  })
  emitter.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection in the main process', reason)
  })
}
