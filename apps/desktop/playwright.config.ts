import path from 'node:path'
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  testMatch: '**/*.e2e.ts',
  globalSetup: path.join(__dirname, 'e2e/global-setup.ts'),
  // Cada test lanza su propia app con su userData; en serie porque comparten pantalla y foco del sistema.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
})
