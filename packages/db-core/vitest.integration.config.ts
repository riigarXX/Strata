import { defineConfig } from 'vitest/config'

// Kept apart from the default config so `pnpm test` never needs Docker; the *.integration.ts suffix keeps these files out of it too.
export default defineConfig({
  test: {
    include: ['src/**/*.integration.ts'],
    globalSetup: ['src/postgres/integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
