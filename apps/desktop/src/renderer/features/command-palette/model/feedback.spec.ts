import { describe, expect, it } from 'vitest'
import { describeBlocked } from './feedback'

describe('describeBlocked', () => {
  it('uses the infinitive of the title when it is an action', () => {
    expect(describeBlocked('Ejecutar', 'Esta pestaña no tiene una conexión abierta.')).toBe(
      'No se puede ejecutar: Esta pestaña no tiene una conexión abierta.',
    )
    expect(describeBlocked('Ejecutar todo', 'x')).toBe('No se puede ejecutar todo: x')
    expect(describeBlocked('Cerrar pestaña', 'No hay ninguna pestaña abierta')).toBe(
      'No se puede cerrar pestaña: No hay ninguna pestaña abierta',
    )
    expect(describeBlocked('Ir a la pestaña 3', 'No existe la pestaña 3')).toBe(
      'No se puede ir a la pestaña 3: No existe la pestaña 3',
    )
    expect(describeBlocked('Conectar a…', 'x')).toBe('No se puede conectar a…: x')
  })

  it('names the command when the title is a noun phrase', () => {
    expect(describeBlocked('Pestaña siguiente', 'Solo hay una pestaña abierta')).toBe(
      '«Pestaña siguiente» no está disponible: Solo hay una pestaña abierta',
    )
  })
})
