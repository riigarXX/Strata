import type { Engine } from '@strata/contracts'
import { AdapterError, analyzeSql, createNormalizedError } from '@strata/db-core'

/**
 * Defensa real del modo read-only (ADR 0004): se evalúa en main, antes del adapter, con lista de permitidos.
 * Todo el documento se analiza; una sola sentencia no permitida lo rechaza entero. El mensaje nunca cita el SQL.
 */
export function assertReadOnlyAllowed(engine: Engine, sql: string): void {
  const violation = analyzeSql(engine, sql).find((statement) => !statement.allowedInReadOnly)
  if (!violation) return
  throw new AdapterError(
    createNormalizedError(
      'read_only_violation',
      violation.changesMode
        ? 'This statement changes the session mode and is not allowed on a read-only connection'
        : 'Only read statements are allowed on a read-only connection',
      { retryable: false },
    ),
  )
}

/**
 * Ejecución «pura lectura» pedida por la petición (`enforceReadOnly`, ADR 0012): además de la lista de permitidos
 * del modo read-only, solo se admiten consultas. El control de transacciones también se rechaza: el adapter de
 * PostgreSQL envuelve la ejecución en su propia transacción READ ONLY y un `COMMIT` la cerraría antes de tiempo.
 */
export function assertPureReadAllowed(engine: Engine, sql: string): void {
  assertReadOnlyAllowed(engine, sql)
  if (analyzeSql(engine, sql).every((statement) => statement.type === 'query')) return
  throw new AdapterError(
    createNormalizedError(
      'read_only_violation',
      'Only plain queries are allowed in a read-only run',
      { retryable: false },
    ),
  )
}
