import vue from '@vitejs/plugin-vue'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts'],
    // Los E2E de Playwright (e2e/) se ejecutan con `pnpm test:e2e`, no con Vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
