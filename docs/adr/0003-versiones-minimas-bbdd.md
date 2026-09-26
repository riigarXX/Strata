# ADR 0003: Versiones mínimas soportadas de PostgreSQL y SQLite

- **Estado:** Aceptado
- **Fecha:** 2026-09-16

## Contexto

Los adapters de `db-core` y la elección de drivers necesitan un límite inferior de compatibilidad. Soportar versiones demasiado antiguas complica los adapters con ramas condicionales por feature; soportar solo versiones muy recientes reduce el público inicial.

## Decisión

- **PostgreSQL: 13+**
- **SQLite: 3.35+** (incluye soporte de `RETURNING`, usado por introspección y futuras operaciones de edición de filas post-MVP)

## Consecuencias

- El adapter de PostgreSQL puede asumir funciones disponibles desde la 13 sin comprobaciones de versión adicionales; cualquier feature que requiera una versión posterior (p. ej. `MERGE` de PG 15) debe declararse como capability opcional, no asumirse.
- El adapter de SQLite puede asumir `RETURNING` y otras mejoras de 3.35 sin fallback.
- El spike de SQLite (driver nativo candidato) debe validar la versión de SQLite embebida en el driver elegido y confirmar que es ≥ 3.35.
- `testConnection` en ambos adapters debe verificar la versión real del servidor/librería y devolver un error claro y no ambiguo si está por debajo del mínimo soportado, en lugar de fallar de forma opaca más adelante.

## Referencias

- `PLAN_BBDD_CLI.md`, sección 5 (`DatabaseAdapter`), sección 10 (Fase 0 y Fase 2).
