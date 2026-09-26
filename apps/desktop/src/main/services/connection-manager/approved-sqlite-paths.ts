import { normalize } from 'node:path'

/**
 * Rutas SQLite elegidas por el usuario en el diálogo nativo de main. Solo viven en memoria:
 * el renderer no puede registrar rutas arbitrarias, solo reutilizar las que main aprobó.
 */
export interface ApprovedSqlitePaths {
  approve(filePath: string): void
  isApproved(filePath: string): boolean
}

export function isSamePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b)
}

export function createApprovedSqlitePaths(): ApprovedSqlitePaths {
  const approved = new Set<string>()
  return {
    approve: (filePath) => void approved.add(normalize(filePath)),
    isApproved: (filePath) => approved.has(normalize(filePath)),
  }
}
