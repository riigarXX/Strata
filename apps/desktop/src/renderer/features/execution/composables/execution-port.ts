import { shallowRef } from 'vue'
import type { ActionAvailability, ExecutionAction } from '../model/availability'
import type { TransactionAction } from '../model/presentation'

/**
 * Lo que la barra de ejecución de la pestaña activa ofrece al resto de la aplicación (registro de
 * comandos, paleta): las mismas acciones y la misma disponibilidad que sus botones, sin duplicar lógica.
 */
export interface ExecutionPort {
  /** Lectura reactiva: dentro de un `computed` se recalcula cuando cambia la ejecución. */
  availability(): Record<ExecutionAction, ActionAvailability>
  run(): Promise<void>
  runAll(): Promise<void>
  cancel(): Promise<void>
  transaction(action: TransactionAction): Promise<void>
  /** ¿La última ejecución de la pestaña dejó una entrada en el historial que aún se puede quitar? Reactivo. */
  canExcludeFromHistory(): boolean
  /** Quita esa entrada del historial (ADR 0005: opt-out «justo después» de ejecutar); anuncia el resultado. */
  excludeFromHistory(): Promise<void>
  /** Muestra en la barra el motivo por el que un atajo no hizo nada. */
  showHint(message: string): void
}

// Solo hay una barra montada a la vez (la de la pestaña activa): un único registro basta.
const current = shallowRef<ExecutionPort | null>(null)

/** Lo llama la barra al montarse; devuelve la función que la retira. */
export function registerExecutionPort(port: ExecutionPort): () => void {
  current.value = port
  return () => {
    if (current.value === port) current.value = null
  }
}

/** Puerto de la pestaña activa o `null` sin pestañas. Reactivo. */
export function currentExecutionPort(): ExecutionPort | null {
  return current.value
}
