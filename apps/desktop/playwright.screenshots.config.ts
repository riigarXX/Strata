import path from 'node:path'
import { defineConfig } from '@playwright/test'

// Config aparte de la de los E2E: las capturas del README no forman parte de `pnpm test:e2e` ni del CI.
export default defineConfig({
  testDir: path.join(__dirname, 'e2e/screenshots'),
  testMatch: '**/*.shot.ts',
  globalSetup: path.join(__dirname, 'e2e/global-setup.ts'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
})
