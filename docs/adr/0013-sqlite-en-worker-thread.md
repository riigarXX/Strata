# ADR 0013: El adapter SQLite se ejecuta en un worker_thread

- **Estado:** Aceptado
- **Fecha:** 2026-09-27

## Contexto

`better-sqlite3` es síncrono. Medido en main: el streaming de 100 000 filas retrasa el event loop como máximo 0,7 ms, pero una sentencia pesada de un solo paso (un agregado sobre 8 M de filas) lo bloquea ~600 ms y, mientras dura, ni `timeoutMs` ni `cancel` pueden actuar (ver [ADR 0007](0007-drivers-postgresql-sqlite.md), «Cancelación cooperativa»). Hay que decidir dónde vive el driver.

## Decisión

**`worker_thread`, un hilo por sesión SQLite**, con la misma interfaz `DatabaseAdapter` (transparente para `ConnectionManager`).

| Criterio       | `worker_thread`                                                                                          | `utilityProcess`                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ABI nativo     | Mismo proceso y mismo ABI de Electron: no cambia nada del rebuild ni del ABI dual (Node de Electron en tests). | Otro proceso de Electron, mismo ABI; pero solo existe dentro de la app.                            |
| Tests          | Corre en Vitest (`ELECTRON_RUN_AS_NODE`) igual que en la app: los tests de db-core prueban el camino real. | Solo se puede lanzar desde una app Electron; los tests de `db-core` no podrían ejercitarlo.        |
| Empaquetado    | Un chunk más en `out/`, cargado desde el asar; `better-sqlite3` sigue en `asarUnpack`.                   | Igual, más un `fork` con `serviceName` y gestión de ciclo de vida del proceso.                     |
| Seguridad      | No añade superficie: los fuses (`runAsNode` off) no lo afectan.                                          | Proceso adicional con acceso a disco; sin ganancia real de aislamiento (el worker ya lo tiene igual que main). |
| Streaming      | `postMessage` con clonado estructurado; los chunks ya son acotados.                                      | Igual, por `MessagePort`.                                                                          |
| Matar el hilo  | `terminate()` no interrumpe código nativo: el hilo termina cuando vuelve del paso en curso.               | `kill()` sí corta la sentencia y libera la CPU al instante.                                        |

`utilityProcess` gana solo en el último punto. Se descarta porque el beneficio (liberar CPU antes en un caso extremo) no compensa perder los tests reales de cancelación en `db-core` ni añadir un ciclo de vida de procesos.

## Diseño

- `packages/db-core/src/sqlite/engine.ts` es el adapter síncrono de siempre; `worker.ts` lo aloja y `adapter.ts` (main) es el `DatabaseAdapter` público, que habla con el worker por un protocolo petición/respuesta (`worker-protocol.ts`).
- `execute` es un stream dirigido por main: `open`, un `pull` por evento (el worker nunca se adelanta al consumidor) y `abort`.
- `cancel` y `timeoutMs` se resuelven **en main**: se emite `cancelled` / `timeout` de inmediato y se pide al worker que aborte. Si no confirma en 150 ms (está dentro de un paso de SQLite), se abandona el hilo con `terminate()` y se abre uno nuevo con el mismo `sessionId` y perfil.
- El estado de transacción se copia en cada respuesta del worker, así que `transactionState()` sigue siendo síncrono.
- `cancellationMode` pasa a `'immediate'`.

## Consecuencias

- Cancelar o agotar el tiempo de una sentencia pesada de un solo paso ya no espera a que termine. Tests en `sqlite/adapter.spec.ts` («a heavy single-step statement»).
- Si hubo que abandonar el worker, una transacción abierta se pierde (equivale a un rollback) y `transactionState()` pasa a `none`.
- El hilo abandonado sigue consumiendo CPU hasta que SQLite devuelva el control (no se puede interrumpir con `better-sqlite3`), y si escribía puede retener el bloqueo de escritura hasta entonces.
- El desktop obtiene la ruta del worker con `import … from '@strata/db-core/sqlite/worker?modulePath'` (electron-vite) y se la pasa a `createSqliteAdapter({ workerPath })`.
- Cada conexión (y cada «probar conexión») arranca un hilo: unas decenas de ms.
