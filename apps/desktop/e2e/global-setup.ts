import { existsSync } from 'node:fs'
import path from 'node:path'

const REQUIRED_BUILD_FILES = ['main/index.js', 'preload/index.js', 'renderer/index.html']

export default function globalSetup(): void {
  const outDir = path.resolve(__dirname, '../out')
  const missing = REQUIRED_BUILD_FILES.filter((file) => !existsSync(path.join(outDir, file)))
  if (missing.length > 0) {
    throw new Error(
      `Falta el build de la app en ${outDir} (${missing.join(', ')}). Ejecuta «pnpm build» o usa «pnpm test:e2e» desde la raíz, que construye antes.`,
    )
  }
}
