import type { Engine } from '@strata/contracts'
import { analyzeSql } from '@strata/db-core'

// Con la transacción abortada PostgreSQL solo admite lo que la cierra o vuelve a un savepoint; COMMIT y END
// equivalen a ROLLBACK en ese estado. `type === 'transaction'` deja fuera ROLLBACK PREPARED y demás.
const CLOSING_COMMANDS: ReadonlySet<string> = new Set(['ROLLBACK', 'ABORT', 'END', 'COMMIT'])

/**
 * ¿Puede ejecutarse este texto con la transacción abortada? Basta con que la primera sentencia sea de cierre:
 * desde ahí la transacción ya no está abortada y el resto se ejecuta con las reglas de siempre, igual que en el
 * servidor. Un texto sin sentencias se deja pasar: no llega a ejecutarse.
 */
export function canRunWhileAborted(engine: Engine, sql: string): boolean {
  const [first] = analyzeSql(engine, sql)
  return (
    first === undefined || (first.type === 'transaction' && CLOSING_COMMANDS.has(first.command))
  )
}
