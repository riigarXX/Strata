import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'

// Los paquetes del workspace apuntan a `src/index.ts` (sin build): deben bundlearse, no externalizarse.
const workspacePackages = ['@strata/contracts', '@strata/db-core', '@strata/design-tokens']

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: workspacePackages } },
  },
  preload: {
    // El preload sandboxed no puede hacer `require` de módulos externos (solo `electron` y unos pocos
    // built-ins): todo lo que importe, incluido zod vía contracts, debe quedar dentro del bundle.
    build: { externalizeDeps: false },
  },
  renderer: {
    // Sin `base`: electron-vite fuerza `./` en producción, que resuelve bien bajo `app://strata/` (el documento
    // vive siempre en la raíz, `/` o `/index.html`), y `/` en desarrollo, donde manda el dev server (HMR intacto).
    root: resolve(__dirname, 'src/renderer'),
    build: {
      // La CSP (`font-src 'self'`) prohíbe fuentes `data:`: ningún asset se inlinea, las fuentes van como archivos.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [vue()],
  },
})
