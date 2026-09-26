# ADR 0007: Elección de drivers de PostgreSQL y SQLite

- **Estado:** Aceptado
- **Fecha:** 2026-09-16 (SQLite confirmado el 2026-09-16 tras spike)

## Contexto

`db-core` necesita un driver por motor. El riesgo principal (sección 12 del plan) son las dependencias nativas: incompatibilidades ABI, rebuilds y errores dentro de ASAR al empaquetar con Electron.

## Decisión: PostgreSQL

Se adopta **`pg`** (node-postgres) como driver de PostgreSQL.

Razones:

- Es una librería en JavaScript puro (sin binarios nativos), lo que elimina el riesgo de ABI/rebuild para este motor y simplifica el empaquetado con `electron-builder`.
- Es el driver de PostgreSQL más usado y mantenido del ecosistema Node, con soporte maduro de streaming de resultados (necesario para el requisito de resultados por chunks) vía cursores o `pg-query-stream`.
- Compatible con PostgreSQL 13+ (ver [ADR 0003](0003-versiones-minimas-bbdd.md)) sin restricciones.

## Decisión: SQLite

Se adopta **`better-sqlite3`** como driver de SQLite, confirmado mediante el spike técnico ("Spike: validar driver SQLite dentro de una app Electron empaquetada", resultado completo en `spikes/sqlite-driver/RESULTADO.md`).

Resultados del spike:

- **Empaquetado**: funciona correctamente dentro del `.app` real generado con `electron-builder` en macOS arm64 (verificado ejecutando el binario empaquetado, no solo `electron .` en dev).
- **Versión de SQLite embebida**: `3.49.2`, muy por encima del mínimo 3.35+ de [ADR 0003](0003-versiones-minimas-bbdd.md).
- **Configuración necesaria**: `asarUnpack: ["**/node_modules/better-sqlite3/**"]` en `electron-builder`, más rebuild nativo vía `@electron/rebuild` (`electron-rebuild -f -w better-sqlite3`) — sin hooks ni configuración adicional.
- **`node:sqlite`** queda descartado: Electron embebe una versión de Node por debajo de la 22.5 requerida (experimental) para ese módulo.
- **`sql.js`** no fue necesario evaluarlo como respaldo: `better-sqlite3` no presentó ningún fallo irresoluble.

## Consecuencias

- El adapter de PostgreSQL (`packages/db-core/src/postgres`) y el de SQLite (`packages/db-core/src/sqlite`, sobre `better-sqlite3`) quedan desbloqueados para implementarse.
- El scaffold real (`apps/desktop`, vía `electron-vite`) debe reproducir en su configuración de `electron-builder` el mismo `asarUnpack` validado en el spike.
- `better-sqlite3` es una API **síncrona**: el adapter de `db-core` debe envolver sus llamadas para presentar la misma interfaz asíncrona (`AsyncIterable<QueryEvent>`, ver [ADR 0010](0010-streaming-resultados.md)) que expone el adapter de PostgreSQL, por ejemplo troceando la iteración de filas en chunks dentro de un generador async.
- La interfaz `DatabaseAdapter` no debe filtrar detalles específicos de `pg` ni de `better-sqlite3`; ambos adapters normalizan tipos y errores hacia el contrato común de `packages/contracts`.
- El proyecto en `spikes/sqlite-driver/` es desechable: no forma parte del monorepo final (`apps/`, `packages/`) y puede eliminarse una vez el adapter definitivo esté implementado y probado.

## Actualización (2026-09-19): implementación del adapter SQLite

- **Versión fijada: `better-sqlite3` 12.11.1**, no la 11.10.0 del spike. La 11.10.0 no compila contra los headers de Electron 44 (error en `v8::External::Value`); el spike solo se validó con Electron 32. La 12.11.1 recompila con `@electron/rebuild` para Electron 44.4.3 y carga bajo `ELECTRON_RUN_AS_NODE` (SQLite 3.53).
- **El empaquetado con `electron-builder` debe revalidarse con Electron 44 + 12.11.1** en la tarea de empaquetado: el resultado del spike (`asarUnpack` + rebuild) queda como referencia, no como garantía.
- **La premisa contra `node:sqlite` está desactualizada**: Electron 44 embebe Node 24 (el spike usaba Node 20.18.1). Se mantiene `better-sqlite3` (adapter ya implementado y probado, API de iteración madura), pero conviene reevaluar `node:sqlite` si el rebuild nativo resulta costoso en el empaquetado.
- **ABI dual (resuelto)**: el binario de `better-sqlite3` es único y se compila para Electron 44 (ABI 149) en el `postinstall` de `apps/desktop` (`install-electron && electron-rebuild -w better-sqlite3`; se omite si ya está compilado para ese ABI). Los tests de `db-core` (`test` y `test:integration`) se ejecutan con el Node de Electron (`ELECTRON_RUN_AS_NODE=1`), así que el Node del sistema (ABI 127) ya no puede cargar el módulo nativo, pero ningún test lo usa así. Un `pnpm install` deja todo listo, sin pasos manuales; requiere Xcode Command Line Tools y red la primera vez. `better-sqlite3`, `pg` y `pg-cursor` son dependencias de `apps/desktop` y quedan externos en `out/main` para que resuelvan en runtime. Sigue pendiente revalidar `asarUnpack` en el empaquetado.
- **Cancelación cooperativa**: `better-sqlite3` es síncrono; `timeoutMs` y `cancel` solo se evalúan entre filas/chunks y un `SELECT` pesado bloquea el proceso main. Mitigación prevista: ejecutar el adapter en un `worker_thread` o `utilityProcess`.

## Actualización (2026-09-20): empaquetado revalidado con Electron 44.4.3 + better-sqlite3 12.11.1

La revalidación pendiente se ha hecho con `electron-builder` 26.15.3 sobre el paquete real (`apps/desktop/electron-builder.yml`, guía en [`docs/packaging.md`](../packaging.md)). Resultado: **funciona**, en macOS arm64.

- **Configuración final**: `asarUnpack: ['**/node_modules/better-sqlite3/**']` (el mismo glob del spike) y `npmRebuild: true` con `buildDependenciesFromSource: false`. El rebuild de electron-builder es idempotente respecto al `postinstall` de `apps/desktop` (mismo binario, ABI 149, arm64): no rompe el binario único de `node_modules`, y `pnpm test` y `pnpm test:integration` siguen pasando tras empaquetar. `files` deja en el asar solo `out/**` y los módulos de runtime, sin fuentes de SQLite, árbol de compilación ni `prebuild-install`.
- **Dependencias**: para que el asar no arrastre Vue, CodeMirror, Pinia ni los `@strata/*` (que Vite ya bundlea), `package.json#dependencies` de `apps/desktop` se reduce a lo que main carga en runtime (`better-sqlite3`, `pg`, `pg-cursor`); el resto pasa a `devDependencies`.
- **Verificación en el `.app` empaquetado** (CDP con `--remote-debugging-port`, `userData` temporal): el `.node` se mapea desde `Contents/Resources/app.asar.unpacked/.../better_sqlite3.node`; SQLite 3.53.2 conecta, consulta y lista tablas; PostgreSQL 17 (contenedor efímero) crea perfil, prueba, conecta, consulta y desconecta; cierre limpio. Con los fuses endurecidos aplicados (`docs/packaging.md`).
- **Veredicto sobre `node:sqlite`: no se cambia la decisión.** Electron 44.4.3 embebe Node 24.21.0 y `node:sqlite` está disponible y funciona (SQLite 3.53.4, `DatabaseSync`, `StatementSync.iterate`), así que la premisa de descartarlo por versión ya no aplica. Pero el motivo que sugería reevaluarlo (que el rebuild nativo resultara costoso al empaquetar) no se ha dado: el rebuild es idempotente, `asarUnpack` es una sola línea y el empaquetado tarda segundos. Migrar supondría reescribir y volver a validar un adapter ya probado a cambio de eliminar la restricción de ABI dual, y `node:sqlite` sigue marcado como release candidate por Node. Se reconsiderará cuando sea estable y si el módulo nativo empieza a dar problemas (x64/universal, Windows o Linux).
- **Sigue pendiente**: validar x64/universal (el rebuild de otra arquitectura sobrescribiría el binario único de desarrollo) y la firma y notarización con Hardened Runtime.

## Referencias

- `PLAN_BBDD_CLI.md`, sección 4 (Datos), sección 12 (riesgo «Dependencias nativas de SQLite»).
- [ADR 0003](0003-versiones-minimas-bbdd.md).
