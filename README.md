# Strata

Cliente de escritorio moderno para bases de datos, con una experiencia **keyboard-first**: consola SQL, paleta de comandos y flujos que se pueden completar casi sin ratón. Solo macOS por ahora ([ADR 0002](docs/adr/0002-sistemas-operativos-objetivo.md)).

Compatible con **PostgreSQL 13+** y **SQLite 3.35+**.

## Qué incluye

- Conexiones guardadas con credenciales cifradas (`safeStorage`); el renderer nunca ve contraseñas ni drivers.
- Editor SQL con pestañas (CodeMirror 6), resultados virtualizados por streaming y cancelación de consultas.
- Explorador de esquemas, tablas, columnas e índices.
- Transacciones explícitas y confirmación obligatoria en operaciones destructivas; bloqueo real en perfiles de solo lectura ([ADR 0004](docs/adr/0004-politica-sql-transacciones.md)).
- Paleta de comandos y atajos de teclado para las operaciones principales.
- Historial local con retención configurable ([ADR 0005](docs/adr/0005-retencion-historial.md)); nunca guarda resultados.
- Temas oscuro, claro y del sistema, basados en design tokens.
- Asistente de IA **local** («Preguntar»): lenguaje natural a SQL con Ollama o LM Studio en el propio equipo. Al modelo solo le llegan el esquema y la pregunta; el SQL generado solo se ejecuta solo si es de solo lectura ([ADR 0012](docs/adr/0012-ia-local.md)).

## Puesta en marcha

Requisitos: macOS en Apple Silicon, Node ≥ 22.12 (`.nvmrc`), pnpm 11 y las Xcode Command Line Tools. Docker es opcional y solo hace falta para los tests con PostgreSQL.

```bash
pnpm install   # instala, descarga Electron y recompila better-sqlite3
pnpm dev       # arranca la app con recarga en caliente
```

Comprobaciones habituales: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`. Para generar el instalador: `pnpm dist`.

## Estructura

```text
apps/desktop/      App Electron: main (drivers, sesiones, credenciales), preload y renderer Vue 3
packages/
  contracts/       Contrato IPC tipado y validado (Zod)
  db-core/         Adapters PostgreSQL y SQLite, análisis SQL y límites de resultados
  commands/        Registro de comandos, atajos y búsqueda difusa
  design-tokens/   Tokens de diseño y su generación
docs/              Guía de desarrollo, ADRs, modelo de amenazas y empaquetado
```

## Documentación

- [Guía de desarrollo](docs/DEVELOPMENT.md): requisitos, scripts, tests, CI y cómo verificar de verdad.
- [Decisiones de arquitectura (ADRs)](docs/adr/)
- [Modelo de amenazas](docs/threat-model.md) y [auditoría de seguridad](docs/security-audit.md)
- [Empaquetado](docs/packaging.md)
- [Plan del producto](PLAN_BBDD_CLI.md)
