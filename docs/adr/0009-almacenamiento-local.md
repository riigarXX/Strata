# ADR 0009: Estrategia de almacenamiento local

- **Estado:** Aceptado
- **Fecha:** 2026-09-16

## Contexto

La aplicación necesita persistir tres tipos de datos locales con requisitos muy distintos: perfiles de conexión (públicos), secretos de esas conexiones (passwords, altamente sensibles) e historial de consultas (potencialmente sensible, con retención). Ninguno de los tres debe mezclarse en el mismo almacén.

## Decisión

- **Secretos (passwords, cadenas de conexión sensibles):** cifrados con `safeStorage` de Electron, gestionados exclusivamente por `CredentialStore` (proceso main). Se referencian desde el perfil por id, nunca se devuelven en claro al renderer.
- **Perfiles de conexión (público):** metadatos no sensibles (nombre, host, puerto, usuario, motor, flags como `read-only`) en un almacén separado de `CredentialStore`, gestionado por `ConnectionManager`. Un perfil sin su secreto asociado debe seguir siendo legible (para poder listarlo, editarlo o borrarlo) aunque no se pueda conectar.
- **Historial de consultas:** almacén propio (`history-store`), separado de perfiles y de secretos, con el job de purga descrito en [ADR 0005](0005-retencion-historial.md). Nunca contiene resultados de consultas.
- **Formato:** JSON en disco dentro del directorio de datos de usuario de Electron (`app.getPath('userData')`), un archivo o carpeta por almacén (`connections.json`, `history.json`), sin base de datos embebida adicional para esto en el MVP — no se justifica la complejidad de SQLite-para-metadatos cuando el volumen de datos es pequeño (perfiles, historial acotado a 30 días por defecto).
- **Ninguno de los tres almacenes vive en el renderer** ni es accesible por `localStorage`/`IndexedDB` del renderer: toda lectura/escritura pasa por IPC hacia main.

## Consecuencias

- `apps/desktop/src/main/services/connection-manager/`, `credential-store/` y `history-store/` son tres módulos independientes con sus propios archivos de persistencia; ninguno importa directamente el almacén de otro.
- Un fallo o corrupción en `history-store` no puede impedir cargar los perfiles de conexión, y viceversa.
- Migrar en el futuro a un motor embebido (p. ej. si el historial crece mucho) es un cambio interno de `history-store` que no afecta al contrato IPC ni al resto de módulos.
- Pinia (renderer) nunca es la fuente de verdad de estos datos: solo cachea lo que main le entrega vía IPC para la sesión actual.

## Referencias

- `PLAN_BBDD_CLI.md`, sección 5 (`ConnectionManager`, `CredentialStore`, `HistoryStore`), sección 9 (Seguridad — Credenciales).
- [ADR 0005](0005-retencion-historial.md).
