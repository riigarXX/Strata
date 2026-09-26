# ADR 0010: Streaming de resultados de consultas

- **Estado:** Aceptado
- **Fecha:** 2026-09-16

## Contexto

El plan exige que ninguna consulta grande congele el renderer ni duplique memoria sin control (principio 5), y que los resultados se reciban por lotes con backpressure (sección 12, riesgo «Resultados muy grandes»). Hace falta fijar cómo fluyen los datos desde el driver hasta el grid virtualizado.

## Decisión

- **`DatabaseAdapter.execute()` devuelve un `AsyncIterable<QueryEvent>`** (ver interfaz en sección 5 del plan), no una promesa con el resultado completo. Cada adapter traduce el streaming nativo de su driver (cursores de `pg`, iteración por lotes del driver SQLite elegido) a este iterable común.
- **En main, el iterable se consume y se reenvía al renderer por IPC en chunks de tamaño acotado** (tamaño de lote configurable, con un valor por defecto conservador), no fila a fila ni de una sola vez.
- **El renderer se suscribe vía `window.db.query.onChunk(callback)`**, que devuelve una función de desuscripción; el store de resultados en Pinia acumula solo lo necesario para el grid virtualizado, con un límite de filas configurable (sección 8, Resultados) que corta el streaming cuando se alcanza.
- **Backpressure**: main no adelanta más chunks de los que el renderer ha confirmado consumir cuando el volumen es grande (aplica sobre todo a exportación futura; en el MVP, con límite de filas por defecto, el riesgo es acotado pero el mecanismo debe existir desde el diseño del contrato).
- **Cancelación (`cancel(requestId)`)** interrumpe el `AsyncIterable` en el adapter (cierra el cursor/consulta en el driver) y deja de emitir chunks; el estado de la sesión queda en un estado conocido (ver [ADR 0004](0004-politica-sql-transacciones.md) para el modelo de transacciones).

## Consecuencias

- `packages/contracts/src/events.ts` define `QueryEvent` como una unión discriminada (`chunk`, `done`, `error`, `cancelled`, `notice`) para que main y renderer compartan el mismo vocabulario.
- El grid de resultados (Fase 3) se implementa desde el inicio como consumidor incremental de chunks, no como consumidor de un array ya completo — evita un rediseño posterior.
- La exportación streaming mencionada en la sección 14 (post-MVP) reutiliza este mismo mecanismo de `AsyncIterable`, escribiendo a disco desde main en vez de reenviar por IPC.

## Referencias

- `PLAN_BBDD_CLI.md`, sección 5 (`DatabaseAdapter.execute`, flujo principal), sección 8 (Resultados), sección 12 (riesgo «Resultados muy grandes»).
- [ADR 0004](0004-politica-sql-transacciones.md), [ADR 0008](0008-contrato-ipc.md).
