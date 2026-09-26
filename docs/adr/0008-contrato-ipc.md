# ADR 0008: Diseño del contrato IPC

- **Estado:** Aceptado
- **Fecha:** 2026-09-16

## Contexto

Toda comunicación entre el renderer Vue y el proceso main pasa por IPC a través de un preload aislado (principio 3 del plan: «Contratos explícitos»). Es necesario fijar cómo se estructura ese contrato antes de implementar `packages/contracts`, el preload y los handlers de main.

## Decisión

- **Fuente de verdad única en `packages/contracts`**: tipos TypeScript + schemas runtime (Zod) para cada request/response y cada evento. Tanto main como preload como renderer importan de aquí; no se duplican tipos.
- **Superficie del preload = API de métodos concretos**, no `ipcRenderer` genérico. Cada método (`window.db.connections.list()`, `window.db.query.execute(...)`, etc.) mapea a un canal IPC concreto y fijo.
- **Un canal por operación**, nombrado por dominio y acción (p. ej. `db:connections:list`, `db:query:execute`, `db:query:cancel`), nunca un canal genérico tipo `db:invoke` con un payload de "comando" libre.
- **Validación en ambos extremos**: el renderer valida antes de enviar (feedback rápido de UI), pero main **revalida siempre** con el mismo schema Zod antes de actuar — el renderer nunca es la única barrera (ver `docs/threat-model.md`).
- **Streaming por eventos, no por respuesta única**: operaciones que devuelven datos por lotes (resultados de queries) usan un patrón de suscripción (`onChunk(callback)` → devuelve función de desuscripción), no un único `invoke` que espera todo el resultado.
- **Eventos push de solo lectura** (actualización 2026-09-20): además de `db:query:event`, main empuja `db:history:changed` (alta, borrado, vaciado y purga del historial; schema `HistoryChangeSchema`). Se envía **solo a la ventana principal** y solo si su frame principal sigue en el origen de la app (`ipc/history-events.ts`); main valida el payload antes de enviarlo y el renderer lo vuelve a validar. El preload lo expone como `window.db.history.onChange(callback)`, que devuelve la desuscripción; no admite peticiones (el canal no tiene handler).
- **Dominio `ai`** (actualización 2026-09-21, [ADR 0012](0012-ia-local.md)): cinco canales de petición (`db:ai:status`, `list-models`, `generate-sql`, `pull-model`, `cancel`) y un evento push, `db:ai:pull-progress` (schema `AiPullProgressSchema`), con las mismas reglas que `history:changed`: solo a la ventana principal y con el origen de la app verificado (`ipc/ai-events.ts`). El preload lo expone como `window.db.ai` y `window.db.ai.onPullProgress(callback)` devuelve la desuscripción. Sus errores usan los códigos de `NormalizedError` existentes.
- **Errores normalizados**: todo error que cruza IPC hacia el renderer usa el tipo `NormalizedError` de `packages/contracts` (código, mensaje seguro para mostrar, sin detalles sensibles), nunca el error crudo del driver.
- **Resultado como valor, no como excepción** (actualización 2026-09-19): los métodos de `window.db` devuelven `IpcResult<T>` (`{ ok: true, data } | { ok: false, error: NormalizedError }`, definido en `apps/desktop/src/shared/ipc-result.ts`), porque una excepción lanzada en un handler cruza IPC como texto opaco de Electron y no como `NormalizedError`. La única excepción es un remitente no confiable, que se rechaza con `throw`.
- **Aprobación de rutas por main**: el renderer no puede registrar rutas de archivo arbitrarias; las de SQLite las aprueba el selector de archivos de main (`db:connections:pick-sqlite-file`) y cualquier otra se rechaza con `permission_denied`.

## Consecuencias

- `packages/contracts/src/events.ts` define el catálogo cerrado de canales; añadir un canal nuevo implica añadirlo ahí primero, no crearlo ad-hoc en preload o main.
- El preload (`apps/desktop/src/preload/db-api.ts`) es un mapeo mecánico 1:1 entre métodos de `window.db.*` y canales — no contiene lógica de negocio.
- Los handlers de main (`apps/desktop/src/main/ipc/`) son los únicos que invocan `ConnectionManager`/`db-core`; validan el payload con Zod antes de nada.
- Este diseño es compatible con reutilizar `packages/contracts` y `db-core` en un futuro binario CLI headless (ver [ADR 0001](0001-alcance-cli-bbdd.md)), ya que el contrato no asume Electron.

## Referencias

- `PLAN_BBDD_CLI.md`, sección 5 (Responsabilidades por capa — Preload, Proceso main), sección 3 (referencia al contrato IPC de BRAID).
- `docs/threat-model.md`.
