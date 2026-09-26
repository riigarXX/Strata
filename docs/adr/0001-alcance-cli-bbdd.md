# ADR 0001: Alcance y significado de «CLI de BBDD»

- **Estado:** Aceptado
- **Fecha:** 2026-09-16

## Contexto

El nombre de trabajo del proyecto («CLI de BBDD») es ambiguo: podría interpretarse como un binario headless de terminal o como un cliente de escritorio con una experiencia centrada en teclado. Es necesario fijar el significado antes de tomar decisiones de arquitectura, UX y stack.

## Decisión

«CLI de BBDD» significa un **cliente de escritorio keyboard-first**: consola y editor SQL, paleta de comandos, navegación de schemas y flujos que puedan completarse prácticamente sin ratón.

No incluye, en el MVP, un binario headless para terminal. La arquitectura (en particular `db-core` y el `CommandRegistry`, agnóstico de Vue) debe permitir añadir ese binario CLI headless más adelante reutilizando el mismo núcleo de acceso a datos y el mismo registro de comandos, sin reescritura.

## Consecuencias

- El producto se distribuye como aplicación Electron, no como paquete npm ejecutable en terminal.
- `db-core` y `CommandRegistry` deben mantenerse desacoplados de Vue y de Electron-specific APIs en su superficie pública, para no cerrar la puerta a un binario CLI futuro (ver sección 14 del plan, «Trabajo posterior al MVP»).
- La UX (atajos, paleta de comandos, comandos internos `\connect`, `\tables`, etc.) es el criterio de éxito de UX, no la existencia de un terminal.

## Referencias

- `PLAN_BBDD_CLI.md`, secciones 1 y 7.
