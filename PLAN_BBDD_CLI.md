# Plan de desarrollo: cliente moderno de bases de datos

## 1. Visión del producto

Construir una aplicación de escritorio moderna para trabajar con bases de datos mediante una experiencia **keyboard-first**, desarrollada con Electron, Vite, Vue 3 y TypeScript.

En este documento, «CLI de BBDD» significa un cliente de escritorio centrado en una consola SQL, una paleta de comandos y flujos que puedan completarse prácticamente sin utilizar el ratón. No incluye inicialmente un binario headless para terminal. La arquitectura deberá permitir añadirlo más adelante reutilizando el mismo núcleo de acceso a datos.

El producto debe ofrecer:

- Gestión segura de conexiones.
- Consola y editor SQL con pestañas.
- Navegación de schemas, tablas, columnas e índices.
- Resultados rápidos y virtualizados.
- Paleta de comandos y atajos de teclado.
- Historial local configurable.
- Temas oscuro, claro y del sistema.
- Compatibilidad inicial con PostgreSQL y SQLite.
- Una identidad visual basada en los design tokens de BRAID.

## 2. Principios del proyecto

1. **Keyboard-first:** todas las operaciones principales deben disponer de un comando y un atajo.
2. **Seguridad por diseño:** el renderer no tendrá acceso a Node.js, drivers, filesystem ni credenciales.
3. **Contratos explícitos:** toda comunicación entre Vue y Electron se realizará mediante APIs IPC tipadas y validadas.
4. **Adaptadores por motor:** no se intentará ocultar las diferencias reales entre dialectos SQL.
5. **Resultados escalables:** ninguna consulta grande deberá congelar la interfaz ni duplicar memoria sin control.
6. **Tokens, no colores sueltos:** todos los componentes consumirán variables semánticas del sistema visual.
7. **MVP enfocado:** primero se resolverá de forma excelente el ciclo conectar, consultar e inspeccionar.

## 3. Referencia técnica de BRAID

BRAID utiliza una separación clara entre renderer, preload, proceso principal y paquetes de dominio. Su contrato IPC compartido actúa como fuente de verdad para todas las capas. Este patrón debe reutilizarse conceptualmente en BBDD.

Referencias locales:

- Arquitectura: `/Users/rigarxx/Desktop/projects/electron/Braid/README.md`, líneas 212-251.
- Tokens de color y tipografía: `/Users/rigarxx/Desktop/projects/electron/Braid/apps/renderer/src/index.css`, líneas 28-80 y 141-178.
- Integración de tokens con Tailwind: `/Users/rigarxx/Desktop/projects/electron/Braid/apps/renderer/tailwind.config.ts`, líneas 15-67.
- Contrato IPC: `/Users/rigarxx/Desktop/projects/electron/Braid/packages/shared-types/src/index.ts`.
- API acotada del preload: `/Users/rigarxx/Desktop/projects/electron/Braid/apps/preload/src/index.ts`.
- Configuración de la ventana Electron: `/Users/rigarxx/Desktop/projects/electron/Braid/apps/desktop/src/index.ts`, líneas 1020-1045.
- Almacenamiento cifrado con `safeStorage`: `/Users/rigarxx/Desktop/projects/electron/Braid/apps/desktop/src/index.ts`, líneas 67-105.
- Paleta de comandos: `/Users/rigarxx/Desktop/projects/electron/Braid/apps/renderer/src/components/command-palette/command-palette.tsx`.

BRAID utiliza React, Zustand, Radix React y Tailwind. BBDD no copiará esos componentes ni su lógica de estado: se reutilizarán la identidad, los tokens y los patrones de arquitectura, reimplementándolos idiomáticamente en Vue.

## 4. Stack propuesto

### Aplicación

- Electron.
- `electron-vite`.
- Vue 3 con Composition API y componentes SFC.
- TypeScript en modo estricto.
- Pinia para estado de interfaz y metadatos no sensibles.
- Vue Router si las áreas principales requieren navegación direccionable.
- CodeMirror 6 para el editor SQL del MVP.
- Una librería Vue accesible de primitivas, como Reka UI, solo donde aporte comportamiento complejo.
- `lucide-vue-next` para iconografía consistente.

### Datos

- PostgreSQL mediante un driver mantenido compatible con Electron.
- SQLite mediante un driver que se validará en un spike técnico por sus implicaciones de binarios nativos y empaquetado.
- Validación runtime de contratos con Zod o una alternativa equivalente.
- Almacenamiento local separado para perfiles, preferencias e historial.
- `safeStorage` de Electron para cifrar secretos mediante las capacidades del sistema operativo.

### Calidad

- ESLint y Prettier.
- Vitest.
- Vue Test Utils.
- Playwright con soporte para Electron.
- Tests de integración contra SQLite temporal y PostgreSQL efímero.
- `electron-builder` para distribución.
- pnpm workspaces.

## 5. Arquitectura propuesta

```text
BBDD/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/
│       │   │   ├── index.ts
│       │   │   ├── windows/
│       │   │   ├── ipc/
│       │   │   ├── security/
│       │   │   └── services/
│       │   │       ├── connection-manager/
│       │   │       ├── credential-store/
│       │   │       └── history-store/
│       │   ├── preload/
│       │   │   ├── index.ts
│       │   │   └── db-api.ts
│       │   └── renderer/
│       │       ├── app/
│       │       ├── router/
│       │       ├── components/
│       │       ├── composables/
│       │       ├── stores/
│       │       └── features/
│       │           ├── connections/
│       │           ├── workspace/
│       │           ├── query-editor/
│       │           ├── results/
│       │           ├── schema-browser/
│       │           ├── history/
│       │           ├── command-palette/
│       │           └── settings/
│       └── electron-builder.yml
├── packages/
│   ├── contracts/
│   │   └── src/
│   │       ├── connections.ts
│   │       ├── queries.ts
│   │       ├── metadata.ts
│   │       ├── events.ts
│   │       └── errors.ts
│   ├── db-core/
│   │   └── src/
│   │       ├── adapter.ts
│   │       ├── registry.ts
│   │       ├── normalization.ts
│   │       ├── postgres/
│   │       └── sqlite/
│   └── design-tokens/
│       ├── tokens/
│       ├── src/
│       └── dist/
└── tests/
    ├── integration/
    ├── e2e/
    └── fixtures/
```

### Flujo principal

```text
Vue renderer
    ↓ API window.db con métodos explícitos
Preload aislado
    ↓ IPC tipado y validado
Electron main / ConnectionManager
    ↓
DatabaseAdapter
    ├── PostgreSQL
    └── SQLite

DatabaseAdapter
    ↓ eventos por lotes y estado de ejecución
Electron main → preload → Vue → grid virtualizado
```

### Responsabilidades por capa

#### Renderer Vue

- Renderizar la interfaz.
- Mantener estado de presentación.
- Gestionar pestañas, selección, filtros y preferencias.
- Solicitar operaciones mediante `window.db`.
- No importar módulos Node ni drivers.
- No almacenar passwords ni resultados masivos en Pinia.

#### Preload

- Exponer una API pequeña y estable con `contextBridge`.
- Mapear métodos concretos a canales IPC concretos.
- Convertir eventos IPC en callbacks seguros.
- Devolver una función de desuscripción para cada listener.
- No exponer `ipcRenderer`, `send` ni `invoke` directamente.

Ejemplo conceptual de superficie:

```ts
window.db.connections.list()
window.db.connections.test(profile)
window.db.connections.connect(profileId)
window.db.query.execute(request)
window.db.query.cancel(requestId)
window.db.metadata.listTables(sessionId)
window.db.query.onChunk(callback)
```

#### Proceso main

- Ser el único propietario de conexiones y drivers.
- Validar de nuevo todos los argumentos IPC.
- Administrar sesiones mediante `ConnectionManager`.
- Gestionar timeouts, cancelación y límites.
- Cifrar y recuperar credenciales.
- Persistir historial y perfiles sin secretos.
- Normalizar errores antes de devolverlos al renderer.

#### `db-core`

Definirá una interfaz similar a:

```ts
interface DatabaseAdapter {
  testConnection(profile: ConnectionProfile): Promise<TestResult>
  connect(profile: ResolvedConnectionProfile): Promise<Session>
  disconnect(sessionId: string): Promise<void>
  execute(request: QueryRequest): AsyncIterable<QueryEvent>
  cancel(requestId: string): Promise<CancelResult>
  listSchemas(sessionId: string): Promise<SchemaInfo[]>
  listTables(sessionId: string, schema?: string): Promise<TableInfo[]>
  describeTable(sessionId: string, table: TableRef): Promise<TableDetails>
  begin(sessionId: string): Promise<void>
  commit(sessionId: string): Promise<void>
  rollback(sessionId: string): Promise<void>
}
```

Cada adapter declarará capacidades como cancelación, schemas, explain, transacciones y modo read-only. La UI no asumirá que todos los motores soportan lo mismo.

## 6. Sistema de diseño derivado de BRAID

### Identidad que se conserva

- Fondo oscuro principal: `#0F172A`.
- Superficie card oscura: `#1B2336`.
- Verde corporativo: `#22C55E`.
- Paleta de superficies slate.
- Estados destructivos rojos, advertencias ámbar y acento secundario morado.
- IBM Plex Sans para la interfaz.
- JetBrains Mono para SQL, datos y metadatos técnicos.
- Densidad de aplicación profesional de escritorio.
- Radios suaves, sombras profundas y glass discreto.

### Elementos de BRAID que no se trasladan directamente

- Colores de ramas del grafo Git.
- Paletas de diff específicas de Git.
- JSX o componentes React.
- Stores Zustand.
- Primitivas Radix React.
- Colores hardcodeados dentro de componentes.

### Fuente única de tokens

Se creará un paquete versionado `@empresa/braid-design-tokens`. Idealmente se extraerá para que BRAID y BBDD consuman la misma versión, evitando copiar `index.css` manualmente entre repositorios.

Capas:

1. **Primitivos:** slate, green, red, amber, purple, blanco, negro, espaciado y tipografía.
2. **Semánticos:** canvas, card, texto, borde, acción, foco y estados.
3. **Componentes:** button, input, sidebar, tab, dialog, editor y grid.
4. **Dominio BBDD:** consulta, transacción, conexión y tipos de datos.

Ejemplos:

```css
--surface-canvas;
--surface-card;
--surface-elevated;
--text-primary;
--text-muted;
--border-subtle;
--action-primary;
--action-primary-hover;
--focus-ring;
--status-success;
--status-warning;
--status-error;
--query-running;
--transaction-active;
--connection-online;
--connection-offline;
```

La fuente se almacenará en JSON compatible con DTCG y generará:

- `tokens.css` para la aplicación.
- `tokens.json` para herramientas.
- Tipos TypeScript.
- Una página o Storybook de referencia visual.

Los temas se aplicarán con `data-theme="dark"`, `data-theme="light"` y resolución del tema del sistema. La aplicación deberá escuchar cambios del sistema operativo en tiempo real.

### Mejoras necesarias antes de reutilizar los tokens

- Corregir el contraste del texto sobre el verde del tema claro, actualmente insuficiente para texto normal.
- Crear una escala formal de espaciado.
- Normalizar radios y sombras que hoy tienen excepciones hardcodeadas.
- Añadir `prefers-reduced-motion`.
- Evitar usar únicamente verde y rojo para comunicar estados.
- Añadir icono, texto o patrón a estados críticos.
- Prohibir hexadecimales y valores RGB fuera del paquete de tokens mediante lint o CI.

## 7. Diseño de experiencia

### Layout principal

- Barra superior integrada con controles de ventana.
- Sidebar izquierda para conexiones y explorador de schemas.
- Área central con pestañas SQL.
- Panel inferior redimensionable para resultados, mensajes y plan de ejecución.
- Barra de estado con conexión, base activa, transacción y tiempo de consulta.
- Paleta global de comandos superpuesta.

### Flujo principal

1. Abrir la aplicación.
2. Crear o seleccionar un perfil.
3. Probar la conexión.
4. Conectar.
5. Crear una pestaña SQL.
6. Escribir o recuperar una consulta.
7. Ejecutar la selección o el documento.
8. Ver filas, duración, mensajes y registros afectados.
9. Inspeccionar una tabla desde el schema browser.
10. Reabrir la consulta desde el historial.

### Atajos iniciales

- `Cmd/Ctrl + K`: abrir paleta de comandos.
- `Cmd/Ctrl + Enter`: ejecutar selección o consulta actual.
- `Shift + Cmd/Ctrl + Enter`: ejecutar todo el documento.
- `Esc`: cancelar consulta o cerrar overlay.
- `Cmd/Ctrl + L`: enfocar consola/editor.
- `Cmd/Ctrl + T`: nueva pestaña SQL.
- `Cmd/Ctrl + W`: cerrar pestaña.
- `Cmd/Ctrl + P`: buscar tabla, vista o conexión.

### Comandos internos iniciales

- `\connect`
- `\disconnect`
- `\connections`
- `\schemas`
- `\tables`
- `\describe`
- `\history`
- `\timing`
- `\clear`
- `\theme`

El registro de comandos será declarativo y agnóstico de Vue para poder reutilizarlo en una futura CLI terminal.

## 8. Alcance funcional del MVP

### Conexiones

- Crear, editar y eliminar perfiles.
- PostgreSQL mediante host, puerto, usuario, base de datos y SSL.
- SQLite mediante selector controlado de archivos.
- Probar conexión sin guardarla.
- Conectar, desconectar y reconectar.
- Marcar perfiles como read-only.
- Mostrar estado y errores seguros.

### Editor SQL

- Pestañas múltiples.
- Resaltado SQL por dialecto.
- Ejecutar selección o documento.
- Formateo opcional.
- Indicador de consulta en ejecución.
- Timeout configurable.
- Cancelación por `requestId`.
- Transacción explícita.
- Confirmación configurable para operaciones destructivas.

### Resultados

- Columnas tipadas.
- Filas virtualizadas.
- Resultados recibidos por lotes.
- Duración y número de filas.
- Registros afectados y notices.
- Copiar celda, fila o selección.
- Filtro local sobre resultados cargados.
- Límite de filas configurable.
- Exportación CSV pospuesta fuera del MVP salvo que se convierta en requisito prioritario.

### Explorador de esquema

- Schemas.
- Tablas y vistas.
- Columnas y tipos.
- Claves primarias y foráneas.
- Índices.
- Acción para insertar el nombre cualificado en el editor.
- Refresco manual y caché por sesión.

### Historial

- Consulta, motor, perfil, fecha, duración y estado.
- Reabrir en una pestaña.
- Buscar y filtrar.
- Borrar elementos o todo el historial.
- Retención configurable.
- Opción para no guardar consultas.
- Nunca almacenar resultados.

## 9. Seguridad

### Configuración Electron

- `contextIsolation: true`.
- `nodeIntegration: false`.
- `sandbox: true`.
- CSP restrictiva.
- Bloquear navegación inesperada.
- Bloquear `window.open` salvo destinos explícitamente permitidos.
- No utilizar contenido remoto ejecutable.
- Validar `sender`, origen y payload de todos los mensajes IPC.
- Mantener Electron y dependencias actualizados.

BRAID mantiene actualmente `sandbox: false`; BBDD no heredará esa configuración. Los drivers quedarán en el proceso principal para que el renderer pueda permanecer aislado.

### Credenciales

- Passwords y secretos cifrados con `safeStorage`.
- Persistencia separada entre perfil público y secreto cifrado.
- Referencia por identificador, nunca por password devuelto al renderer.
- Fallar de forma segura si el sistema operativo no ofrece cifrado.
- No incluir secretos en logs, errores, snapshots ni telemetría.
- Permitir borrar completamente los secretos guardados.

### Consultas y datos

- El SQL escrito por el usuario es una entrada intencional, pero los comandos internos y consultas de metadatos deben validar parámetros estrictamente.
- No interpolar nombres o parámetros recibidos del renderer sin validación.
- Limitar filas y tiempo por defecto.
- Añadir modo read-only.
- Confirmar acciones destructivas cuando corresponda.
- Redactar host, usuario y cadenas de conexión en errores mostrados o registrados.
- No persistir resultados de consultas.

## 10. Fases de implementación

### Fase 0: definición y decisiones arquitectónicas

Objetivos:

- Confirmar que el producto es desktop keyboard-first.
- Confirmar sistemas operativos objetivo.
- Definir versiones mínimas de PostgreSQL y SQLite.
- Decidir política de consultas múltiples, DDL, DML y transacciones.
- Definir retención del historial.
- Crear threat model.
- Crear ADRs para `electron-vite`, drivers, IPC, almacenamiento y streaming.
- Realizar un spike del driver SQLite dentro de una aplicación empaquetada.

Criterios de aceptación:

- Alcance MVP cerrado.
- Decisiones críticas documentadas.
- Driver SQLite elegido y probado en un paquete Electron.
- Diagrama de amenazas y límites de confianza revisado.

### Fase 1: fundación

Objetivos:

- Crear el scaffold Electron + Vite + Vue + TypeScript.
- Configurar pnpm workspaces.
- Crear `contracts`, `db-core` y `design-tokens`.
- Configurar lint, formato, typecheck y tests.
- Construir la ventana endurecida y un preload mínimo.
- Implementar shell visual inicial.
- Importar tokens dark/light derivados de BRAID.

Criterios de aceptación:

- `dev`, `build`, `lint`, `typecheck` y `test` funcionan.
- El renderer no puede acceder a Node.js.
- El sandbox está activo.
- Los temas oscuro, claro y system funcionan sin flash visible significativo.
- Los textos esenciales cumplen WCAG AA.

### Fase 2: conexiones y adaptadores

Objetivos:

- Definir `DatabaseAdapter` y registro de adapters.
- Implementar PostgreSQL y SQLite.
- Crear `ConnectionManager`.
- Crear `CredentialStore` con `safeStorage`.
- Implementar CRUD de perfiles.
- Añadir test de conexión, conexión, desconexión y reconexión.
- Añadir introspección inicial.

Criterios de aceptación:

- Los secretos no aparecen en Pinia, IPC de respuesta, logs ni disco en claro.
- Existen tests de integración para ambos motores.
- Los errores de conexión son útiles sin filtrar información sensible.
- Las conexiones se cierran correctamente al salir de la aplicación.

### Fase 3: workspace de consultas

Objetivos:

- Implementar pestañas.
- Integrar CodeMirror 6.
- Ejecutar selección o documento.
- Añadir timeout, límite de filas y cancelación.
- Emitir resultados por chunks.
- Implementar grid virtualizado.
- Mostrar errores, notices, duración y registros afectados.
- Gestionar begin, commit y rollback.

Criterios de aceptación:

- Una consulta grande no congela el renderer.
- La aplicación no mantiene copias ilimitadas de resultados.
- La cancelación deja la sesión en un estado conocido.
- Un error permite corregir y volver a ejecutar sin reiniciar la app.
- El estado de la transacción siempre es visible.

### Fase 4: experiencia command-first

Objetivos:

- Crear un `CommandRegistry` declarativo.
- Implementar paleta con búsqueda fuzzy.
- Añadir atajos globales y contextuales.
- Implementar comandos internos.
- Añadir historial con filtros, reapertura y retención.
- Mostrar comandos deshabilitados y su precondición.

Criterios de aceptación:

- El flujo conectar, consultar e inspeccionar puede completarse sin ratón.
- Los atajos funcionan en macOS, Windows y Linux.
- La paleta tiene semántica accesible de diálogo/listbox.
- El foco vuelve al lugar correcto al cerrar overlays.

### Fase 5: hardening y calidad

Objetivos:

- Completar validación runtime del IPC.
- Validar remitentes y origen.
- Añadir CSP y restricciones de navegación.
- Redactar logs y errores.
- Añadir modo read-only y confirmaciones destructivas.
- Completar tests unitarios, de componentes, integración y E2E.
- Auditar accesibilidad y navegación por teclado.
- Probar contraste, zoom y reduced motion.

Criterios de aceptación:

- Payloads inválidos y canales no autorizados se rechazan.
- La navegación externa inesperada queda bloqueada.
- No aparecen secretos en artefactos de prueba.
- Todos los flujos principales tienen cobertura automatizada.
- La interfaz es utilizable mediante teclado y lector de pantalla en operaciones esenciales.

### Fase 6: distribución

Objetivos:

- Configurar `electron-builder`.
- Resolver rebuild y `asarUnpack` de dependencias nativas.
- Crear iconos y metadatos.
- Añadir matriz CI por sistema operativo objetivo.
- Probar instalación, actualización y migración de configuración.
- Preparar firma y notarización cuando existan las cuentas necesarias.

Criterios de aceptación:

- Existe un instalador verificable por cada sistema operativo objetivo.
- PostgreSQL y SQLite funcionan dentro de la aplicación empaquetada.
- Los datos de configuración sobreviven a una actualización.
- Una migración fallida no destruye los perfiles existentes.

## 11. Estrategia de pruebas

### Unitarias

- Contratos y schemas runtime.
- Registro de adapters.
- Normalización de resultados y errores.
- Parser de comandos internos.
- Registro y precondiciones de comandos.
- Stores y composables.
- Política de límites y timeouts.

### Integración

- SQLite dentro de un directorio temporal.
- PostgreSQL efímero en CI.
- Conexión y reconexión.
- Introspección.
- SELECT, DML y transacciones.
- Cancelación.
- Errores de sintaxis y permisos.
- Cierre limpio de sesiones.

### Componentes Vue

- Estados vacío, cargando, éxito y error.
- Paleta de comandos.
- Atajos y gestión de foco.
- Ciclo de vida de una consulta.
- Temas dark/light/system.
- Grid de resultados.

### E2E Electron

- Arranque de la aplicación.
- Apertura de una fixture SQLite.
- Ejecución de una consulta.
- Visualización de resultados.
- Historial.
- Cierre y reapertura.
- Persistencia de preferencias.
- Comprobación de la configuración segura de `BrowserWindow`.
- Comprobación de la superficie expuesta por preload.

### CI

Cada pull request deberá ejecutar:

1. Lint.
2. Formato.
3. Typecheck.
4. Tests unitarios.
5. Tests de componentes.
6. Tests de integración.
7. Build.
8. Smoke test del paquete cuando el cambio afecte a Electron, drivers o distribución.

## 12. Riesgos y mitigaciones

### Dependencias nativas de SQLite

Riesgo: incompatibilidades ABI, rebuilds y errores dentro de ASAR.

Mitigación: resolverlo en un spike inicial, fijar versiones compatibles, automatizar rebuild y probar el artefacto empaquetado en CI.

### Resultados muy grandes

Riesgo: saturación del IPC, memoria excesiva o congelación de Vue.

Mitigación: chunks, backpressure, límite por defecto, paginación cuando sea posible, grid virtualizado y futura exportación streaming desde main.

### Cancelación desigual

Riesgo: cada driver implementa cancelación de forma distinta.

Mitigación: modelarla como capability del adapter, mostrar estado `cancelling` y documentar el fallback de cerrar y reconstruir una sesión cuando sea necesario.

### Diferencias de dialecto

Riesgo: crear una abstracción falsa que pierda funciones específicas del motor.

Mitigación: contrato común pequeño, capability flags y módulos de introspección por motor.

### Información sensible en historial

Riesgo: el SQL puede contener datos personales, tokens o valores privados.

Mitigación: opt-out, retención configurable, borrado sencillo, redacción cuando sea viable y prohibición de almacenar resultados.

### Deriva del design system

Riesgo: copiar los tokens de BRAID y que ambas aplicaciones evolucionen por separado.

Mitigación: paquete compartido, versionado SemVer, changelog, tests de contrato y actualización automatizada de consumidores.

### Contraste y accesibilidad

Riesgo: algunos colores y transparencias actuales de BRAID no cumplen contraste en todos los contextos.

Mitigación: corregir tokens antes de adoptarlos, pruebas automatizadas de contraste y revisión visual de todos los estados en ambos temas.

### Firma y distribución

Riesgo: descubrir demasiado tarde requisitos de certificados, notarización o licencias de drivers.

Mitigación: confirmar sistemas objetivo y requisitos de distribución en la fase 0.

## 13. Definition of Done del MVP

El MVP estará terminado cuando:

- La aplicación se pueda instalar en los sistemas operativos acordados.
- Se puedan crear perfiles PostgreSQL y SQLite sin almacenar secretos en claro.
- El renderer permanezca aislado y sin acceso a Node.js.
- Se pueda conectar, explorar el esquema y ejecutar SQL.
- Las consultas se puedan cancelar y tengan límites configurables.
- Los resultados grandes se procesen por lotes y se rendericen virtualmente.
- Las transacciones tengan estado visible y controles explícitos.
- El flujo principal se pueda completar con teclado.
- Existan temas oscuro, claro y system basados en BRAID.
- Los componentes no contengan colores corporativos hardcodeados.
- Pasen lint, typecheck, tests unitarios, integración y E2E principales.
- Exista al menos un artefacto empaquetado y probado por sistema operativo objetivo.
- Los riesgos o funcionalidades aplazadas estén documentados.

## 14. Trabajo posterior al MVP

- MySQL/MariaDB.
- SQL Server.
- CockroachDB y otros motores compatibles con PostgreSQL.
- Exportación CSV/JSON/Parquet mediante streaming.
- Importación de datos.
- Edición segura de filas.
- Diagramas de relaciones.
- Explain visual.
- Snippets sincronizables.
- Comparación de schemas.
- Túneles SSH.
- Integración con gestores externos de secretos.
- Sesiones y layouts de workspace.
- Plugins de adapters.
- Binario CLI headless que reutilice `db-core` y `CommandRegistry`.
- Actualizaciones automáticas firmadas.

## 15. Primer backlog ejecutable

1. Crear ADR del alcance y significado de «CLI».
2. Confirmar macOS, Windows y Linux objetivo.
3. Crear threat model.
4. Probar el driver SQLite dentro de Electron empaquetado.
5. Crear scaffold `electron-vite` con Vue y TypeScript.
6. Crear los paquetes `contracts`, `db-core` y `design-tokens`.
7. Extraer y normalizar los tokens corporativos de BRAID.
8. Corregir contraste claro y añadir reduced motion.
9. Endurecer `BrowserWindow` y crear preload mínimo.
10. Definir contratos de perfiles, sesiones, consultas y eventos.
11. Implementar `ConnectionManager`.
12. Implementar `CredentialStore`.
13. Crear adapter PostgreSQL.
14. Crear adapter SQLite.
15. Implementar pantalla de conexiones.
16. Implementar shell, pestañas y schema browser.
17. Integrar editor SQL.
18. Implementar ejecución, chunks y cancelación.
19. Implementar grid virtualizado.
20. Crear paleta y registro de comandos.
21. Añadir historial y política de retención.
22. Completar hardening, E2E y empaquetado.

