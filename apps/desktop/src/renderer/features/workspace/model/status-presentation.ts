import type { ConnectionProfile, TransactionState } from '@strata/contracts'

// El estado siempre se comunica con texto; el glifo y el color de refuerzo los pone el CSS desde los tokens.
export const TRANSACTION_LABELS: Record<TransactionState, string> = {
  none: 'Sin transacción',
  active: 'Transacción activa',
  aborted: 'Transacción abortada: hay que revertir',
}

export interface TransactionLabelParts {
  lead: string
  /** Aclaración tras los dos puntos, si la hay; en anchos reducidos se omite a la vista. */
  tail: string
}

/** «Transacción abortada: hay que revertir» → «Transacción abortada» y «: hay que revertir». `lead + tail` es la etiqueta entera. */
export function splitTransactionLabel(state: TransactionState): TransactionLabelParts {
  const label = TRANSACTION_LABELS[state]
  const cut = label.indexOf(':')
  return cut === -1
    ? { lead: label, tail: '' }
    : { lead: label.slice(0, cut), tail: label.slice(cut) }
}

/** PostgreSQL: la base del perfil; SQLite: el nombre del archivo (la ruta completa no cabe en la barra). */
export function databaseName(profile: ConnectionProfile): string {
  if (profile.engine === 'postgres') return profile.database
  return profile.filePath.split('/').filter(Boolean).pop() ?? profile.filePath
}
