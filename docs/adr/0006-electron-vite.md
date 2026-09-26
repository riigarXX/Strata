# ADR 0006: Uso de electron-vite como base de build

- **Estado:** Aceptado
- **Fecha:** 2026-09-16

## Contexto

El plan (sección 4) propone `electron-vite` como herramienta de build para las tres capas de la app de escritorio (main, preload, renderer), en lugar de configurar Vite y el empaquetado de Electron manualmente o usar Electron Forge/electron-webpack.

## Decisión

Se adopta **`electron-vite`** como base del scaffold (`apps/desktop`).

Razones:

- Configura de forma coherente los tres entry points (main, preload, renderer) con Vite, evitando mantener tres pipelines de build distintos.
- HMR rápido en el renderer durante desarrollo, consistente con Vue 3 + Vite.
- Se integra directamente con `electron-builder` para la fase de distribución (Fase 6), sin capas intermedias adicionales.
- Es la opción con menor fricción para TypeScript estricto en las tres capas.

## Consecuencias

- El scaffold inicial (backlog ítem 5) usa la estructura de `electron-vite` (`electron.vite.config.ts` con `main`/`preload`/`renderer`).
- El equipo depende del ciclo de releases de `electron-vite` para actualizaciones de Electron; se revisa como parte del mantenimiento de dependencias, no bloquea el MVP.
- Actualización 2026-09-20 ([ADR 0011](0011-protocolo-app.md)): el renderer compilado se sirve por el esquema propio `app://strata`, no por `file://`. No se fija `base` en `electron.vite.config.ts`: electron-vite fuerza `./` en producción (correcto bajo `app://strata/`) y `/` en desarrollo (dev server, sin protocolo propio, HMR intacto).
- No se usa Electron Forge ni webpack; cualquier plugin de Vite usado en el renderer (p. ej. para CodeMirror) debe ser compatible con el pipeline de `electron-vite`.

## Referencias

- `PLAN_BBDD_CLI.md`, sección 4 (Stack propuesto — Aplicación).
