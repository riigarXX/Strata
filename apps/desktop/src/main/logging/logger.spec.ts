// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createLogger, type LogSink } from './logger'
import { installProcessErrorLogging } from './process-errors'

const SECRET = 'hunter2-s3cret-pw'
const HOST = 'db.internal.example.com'
const USER = 'svc_admin_user'
const HOME = '/Users/rigarxx'

function memorySink() {
  const lines: string[] = []
  const sink: LogSink = { warn: (line) => lines.push(line), error: (line) => lines.push(line) }
  return { lines, sink }
}

function leakyError(): Error {
  const error = Object.assign(
    new Error(`connect ECONNREFUSED ${HOST}:5432 user=${USER} password=${SECRET} ${HOME}/db`),
    { code: 'ECONNREFUSED', host: HOST, password: SECRET },
  )
  error.stack = `Error: ${error.message}\n    at ${HOME}/Library/Application Support/Strata/x.js:1:1`
  return error
}

describe('createLogger', () => {
  it('de una causa solo escribe su clase y su código, nunca mensaje, pila ni propiedades', () => {
    const { lines, sink } = memorySink()
    const logger = createLogger({ sink, paths: [HOME] })

    logger.error('Query failed', leakyError())

    expect(lines).toEqual(['[strata] Query failed [Error ECONNREFUSED]'])
  })

  it.each([
    ['una cadena', `password=${SECRET} host=${HOST}`],
    ['un objeto', { message: SECRET, user: USER }],
    ['un número', 42],
    ['null', null],
  ])('no vuelca el contenido de una causa que es %s', (_name, reason) => {
    const { lines, sink } = memorySink()
    createLogger({ sink, paths: [HOME] }).warn('Something failed', reason)

    const text = lines.join('\n')
    for (const marker of [SECRET, HOST, USER]) expect(text).not.toContain(marker)
  })

  it('ignora un código o un nombre de error que no tengan forma de identificador', () => {
    const { lines, sink } = memorySink()
    const logger = createLogger({ sink, paths: [HOME] })
    const tricky = Object.assign(new Error('x'), {
      code: `password=${SECRET}`,
      name: `Error ${HOST}`,
    })

    logger.warn('Failed', tricky)

    expect(lines).toEqual(['[strata] Failed [object]'])
  })

  it('redacta las rutas del sistema, las cadenas de conexión y los pares clave=valor del texto', () => {
    const { lines, sink } = memorySink()
    const logger = createLogger({ sink, paths: [HOME] })

    logger.warn(`Cannot read ${HOME}/Library/x for postgres://${USER}:${SECRET}@${HOST}/db`)
    logger.warn(`retry user=${USER} host=${HOST} password=${SECRET}`)

    const text = lines.join('\n')
    for (const marker of [HOME, SECRET, HOST, USER]) expect(text).not.toContain(marker)
    expect(text).toContain('[redacted]')
  })

  it('escribe una sola línea acotada', () => {
    const { lines, sink } = memorySink()
    createLogger({ sink, paths: [] }).warn(`a\nb\n${'x'.repeat(2000)}`)

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('\n')
    expect(lines[0]?.length).toBeLessThanOrEqual(300)
  })

  it('warn usa el canal de aviso y error el de error', () => {
    const sink = { warn: vi.fn(), error: vi.fn() }
    const logger = createLogger({ sink, paths: [] })

    logger.warn('w')
    logger.error('e')

    expect(sink.warn).toHaveBeenCalledExactlyOnceWith('[strata] w')
    expect(sink.error).toHaveBeenCalledExactlyOnceWith('[strata] e')
  })
})

describe('installProcessErrorLogging', () => {
  it('registra excepciones y rechazos no capturados sin su mensaje', () => {
    const { lines, sink } = memorySink()
    const emitter = new EventEmitter()
    installProcessErrorLogging(emitter as never, createLogger({ sink, paths: [HOME] }))

    emitter.emit('uncaughtException', leakyError())
    emitter.emit('unhandledRejection', leakyError())

    expect(lines).toEqual([
      '[strata] Uncaught exception in the main process [Error ECONNREFUSED]',
      '[strata] Unhandled promise rejection in the main process [Error ECONNREFUSED]',
    ])
  })
})
