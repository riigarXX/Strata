import type { TransactionState } from '@strata/contracts'

export type ExecutionAction = 'run' | 'run-all' | 'cancel' | 'begin' | 'commit' | 'rollback'

export interface ActionAvailability {
  enabled: boolean
  /** Por qué no se puede; `null` si está habilitada. Se expone de forma accesible en el botón. */
  reason: string | null
}

export interface AvailabilityInput {
  /** `null`: la pestaña no tiene una sesión abierta. */
  transaction: TransactionState | null
  status: 'idle' | 'running' | 'cancelling'
  /** Otra pestaña está ejecutando en la misma sesión. */
  sessionBusyElsewhere: boolean
  /** Hay una petición begin/commit/rollback en vuelo desde esta pestaña. */
  transactionBusy: boolean
}

const ENABLED: ActionAvailability = { enabled: true, reason: null }
const blocked = (reason: string): ActionAvailability => ({ enabled: false, reason })

function common({
  transaction,
  status,
  sessionBusyElsewhere,
  transactionBusy,
}: AvailabilityInput): ActionAvailability | null {
  if (transaction === null) return blocked('Esta pestaña no tiene una conexión abierta.')
  if (status === 'running') return blocked('Hay una ejecución en curso.')
  if (status === 'cancelling') return blocked('Se está cancelando la ejecución.')
  if (transactionBusy) return blocked('Hay una operación de transacción en curso.')
  if (sessionBusyElsewhere)
    return blocked('La sesión está ocupada con una consulta de otra pestaña.')
  return null
}

/** Estado de cada acción de la barra de herramientas; una única fuente para botones y atajos. */
export function availabilityOf(
  input: AvailabilityInput,
): Record<ExecutionAction, ActionAvailability> {
  const busy = common(input)
  const { transaction, status } = input

  const cancel: ActionAvailability =
    status === 'running'
      ? ENABLED
      : blocked(
          status === 'cancelling' ? 'Ya se está cancelando.' : 'No hay ninguna ejecución en curso.',
        )

  const begin =
    busy ??
    (transaction === 'active'
      ? blocked('Ya hay una transacción activa.')
      : transaction === 'aborted'
        ? blocked('La transacción está abortada: revierte antes de iniciar otra.')
        : ENABLED)

  const commit =
    busy ??
    (transaction === 'active'
      ? ENABLED
      : blocked(
          transaction === 'aborted'
            ? 'La transacción está abortada: solo se puede revertir.'
            : 'No hay ninguna transacción activa.',
        ))

  const rollback =
    busy ?? (transaction === 'none' ? blocked('No hay ninguna transacción que revertir.') : ENABLED)

  // Con la transacción abortada, Ejecutar sigue habilitado: acepta un ROLLBACK escrito a mano y el texto del editor
  // no es un dato de este modelo. Qué se puede ejecutar entonces lo decide `canRunWhileAborted` en el controlador.
  return { run: busy ?? ENABLED, 'run-all': busy ?? ENABLED, cancel, begin, commit, rollback }
}
