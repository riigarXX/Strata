# ADR 0002: Sistemas operativos objetivo del MVP

- **Estado:** Aceptado
- **Fecha:** 2026-09-16

## Contexto

El plan requiere confirmar qué sistemas operativos soporta el MVP antes de decidir drivers nativos, firma/notarización, matriz de CI y estrategia de empaquetado (`electron-builder`).

## Decisión

El MVP soporta **únicamente macOS**. Windows y Linux quedan fuera del alcance inicial y se evaluarán en una fase posterior, una vez validado el ciclo conectar → consultar → inspeccionar en macOS.

## Consecuencias

- La matriz de CI y los smoke tests de empaquetado (Fase 6) se limitan a macOS.
- La firma y notarización a resolver en Fase 6 es la de Apple (Developer ID / notarización de Apple), no Authenticode ni paquetes `.deb`/`.rpm`/`AppImage`.
- El spike del driver SQLite (tarea "Spike: validar driver SQLite dentro de una app Electron empaquetada") solo necesita validar binarios nativos para macOS (arm64 y, si se decide dar soporte a Intel, x64) en esta fase.
- Añadir Windows o Linux más adelante implicará revisar: rutas de `safeStorage` (usa Keychain en macOS, DPAPI en Windows, libsecret en Linux), atajos de teclado específicos de plataforma, y la matriz de CI/distribución.

## Referencias

- `PLAN_BBDD_CLI.md`, sección 10 (Fase 0 y Fase 6), sección 12 (riesgo «Firma y distribución»).
