# ADR 0005: Política de retención del historial de consultas

- **Estado:** Aceptado
- **Fecha:** 2026-09-16

## Contexto

El historial local puede contener SQL con datos personales, tokens o valores sensibles escritos por el usuario (sección 9 del plan, riesgo «Información sensible en historial»). Nunca se almacenan resultados, pero sí el texto de la consulta, el motor, el perfil, la fecha, la duración y el estado.

## Decisión

- **Retención por defecto: 30 días**, tras los cuales las entradas se purgan automáticamente.
- **Configurable** por el usuario en ajustes (valores como 7/30/90 días o "ilimitado" quedan disponibles como opciones, pero 30 días es el valor por defecto de fábrica).
- **Opt-out por consulta**: el usuario puede marcar una ejecución para que no se guarde en el historial en absoluto, decidido antes o justo después de ejecutar.
- **Borrado manual** disponible en cualquier momento: por entrada individual o vaciado completo del historial.
- **Nunca se almacenan resultados**, solo metadatos y el texto de la consulta.

### Actualización 2026-09-20: cómo se concretan el opt-out «justo después» y los filtros

- **Antes de ejecutar:** la casilla «Guardar en el historial» de la barra (`saveToHistory: false`), sin cambios.
- **Justo después:** acción «Quitar del historial» (botón de la barra de la pestaña y comando `history.exclude` de la paleta, sin atajo propio para no colisionar), disponible solo mientras exista la entrada que dejó la **última ejecución de esa pestaña**. No hay canal IPC nuevo ni cambia el contrato de ejecución: reutiliza `history.delete`. El id de la entrada llega en el cambio `added` que main empuja por `db:history:changed` junto al `requestId` de la ejecución (el `requestId` no se guarda en disco). El renderer solo recuerda pares `requestId → id` de las últimas ejecuciones, nunca el SQL. Si la entrada ya no existe (purga, borrado desde el panel) se informa y la acción desaparece; el resultado se anuncia a lectores de pantalla y el foco vuelve al editor. Sin diálogo de confirmación: es reversible en la práctica (el texto sigue en el editor) y borrar una entrada propia de esta ejecución no es destructivo para los datos del usuario.
- **Filtros por fecha:** el panel expone «Desde» y «Hasta» (`<input type="date">` nativos, hora **local** del usuario, ambos días incluidos: `from` = 00:00:00.000 local y `to` = 23:59:59.999 local del día elegido, enviados al contrato como ISO 8601 UTC). Se valida `Desde ≤ Hasta` antes de pedir; un rango inválido no se envía a main y se explica junto al campo.

## Consecuencias

- `history-store` (proceso main) necesita un job de purga periódica (al iniciar la app y/o en un intervalo) que borre entradas más antiguas que la retención configurada.
- El esquema de almacenamiento del historial debe incluir un flag por entrada para excluirla de la purga o marcarla como no persistida (para el opt-out), y no debe compartir almacenamiento con `CredentialStore`.
- La UI de historial (sección 8 del plan) debe exponer: buscar/filtrar, reabrir en pestaña, borrar entrada o todo el historial, y el ajuste de retención.
- Pendiente para una fase posterior (no bloqueante para el MVP): heurísticas de redacción de valores sensibles dentro del propio texto SQL guardado (mencionado como mitigación "cuando sea viable" en la sección 12 del plan).

## Referencias

- `PLAN_BBDD_CLI.md`, sección 8 (Historial), sección 9 (Seguridad — Consultas y datos), sección 12 (riesgo «Información sensible en historial»).
