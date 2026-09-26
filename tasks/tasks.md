# 🗂️ Tareas del repositorio

Tablero de trabajo de este repositorio, agrupado por tipo de tarea.
Pensado para leerse igual de bien por una persona que por un agente.

> Gestionado por el script `task-manager.js` (skill **task-manager**).
> Puedes editar libremente **este preámbulo**; todo lo que hay entre las marcas
> `task-manager:start` / `end` se regenera solo en cada operación.

<!-- task-manager:start -->
<!-- Bloque generado por task-manager.js: se reescribe entero en cada operación. -->
<!-- Edita el preámbulo de arriba libremente; aquí dentro, usa el script. -->

## 📖 Cómo leer este archivo

Hay **1 tareas activas** repartidas en **1 categoría**: 🔵 1 en progreso.

Cada categoría tiene su propia sección con título, descripción y tabla. La categoría de una tarea es la sección en la que vive, no una columna.

### 🗂️ Categorías

| Categoría | Tareas | Qué entra aquí |
|---|---|---|
| 🐛 **Bugs** <br>`bug` | — | Algo que ya existe y no funciona como debería. Corregir comportamiento incorrecto. |
| ✨ **Features** <br>`feature` | — | Funcionalidad nueva que el producto todavía no tiene. |
| 🚀 **Mejoras** <br>`mejora` | — | Algo que ya funciona y se pule: usabilidad, rendimiento, ergonomía, robustez. |
| 🎨 **Diseño y UI** <br>`diseno` | — | Estilos, layout, design system, componentes visuales y accesibilidad. |
| ♻️ **Refactor** <br>`refactor` | — | Reorganización interna sin cambiar el comportamiento observable. Deuda técnica. |
| 🏗️ **Arquitectura y fundaciones** <br>`arquitectura` | — | Estructura del proyecto, contratos de dominio, módulos base y decisiones estructurales ya tomadas. |
| 🔐 **Seguridad y privacidad** <br>`seguridad` | — | Permisos, datos sensibles, ejecución de código de terceros y políticas de privacidad. |
| 🧪 **Tests y QA** <br>`test` | — | Pruebas automáticas, fixtures, verificación y control de calidad. |
| 📚 **Documentación** <br>`docs` | — | README, guías de uso, documentación técnica y de integración. |
| 🔧 **Infraestructura y build** <br>`infra` | 1 | Build, empaquetado, distribución, CI, dependencias y tooling. |
| 🔍 **Investigación y decisiones** <br>`investigacion` | — | Spikes, comparativas y decisiones pendientes de confirmar antes de implementar. |
| 📌 **Sin clasificar** <br>`sin-clasificar` | — | Tareas que todavía no tienen categoría. Reclasifícalas con `update <id> category <categoría>`. |

> ¿Falta una categoría? No la metas a mano: créala usando el tipo nuevo
> (`create ... --type=<nueva>`) o con `categories add`, y el archivo se reorganiza solo.

### 🧭 Columnas

| Columna | Significado |
|---|---|
| **ID** | Identificador único de la tarea (UUID). Es el que se pasa al script. |
| **Título** | Qué hay que hacer, en una línea. |
| **Descripción** | Contexto, entregable, criterios de aceptación y dependencias. |
| **Agente** | Agente responsable de ejecutarla. Vacío = lo decide el orquestador. |
| **Nº Agentes** | Cuántos agentes se despliegan para la tarea (metadato de planificación). |
| **Estado** | 🟡 `pendiente` · 🔵 `en_progreso` · ✅ `finalizada`. |
| **Bugs** | Problemas encontrados durante la tarea: `BUG: … → SOL: …`. |
| **Creada** / **Actualizada** | Fechas (`YYYY-MM-DD`). |

> Al pasar una tarea a ✅ `finalizada` se archiva sola en `tasksDone.md`.

---

<!-- cat:infra -->
## 🔧 Infraestructura y build

> Build, empaquetado, distribución, CI, dependencias y tooling.
>
> **1** tarea · 🔵 1 en progreso

| ID | Título | Descripción | Agente | Nº Agentes | Estado | Bugs | Creada | Actualizada |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10db1509-e643-4b5a-957d-7c97ef80bfc0 | Ejecutar los tests E2E de Playwright en el CI de macOS | `pnpm test:e2e` (raíz) construye la app y lanza 16 tests E2E de Playwright (apps/desktop/e2e) que abren ventanas reales de Electron, por lo que necesitan sesión gráfica. Añadir un job al workflow .github/workflows/ci.yml (o uno propio) en macos-latest con sesión gráfica que ejecute esos tests, subir test-results y playwright-report como artefacto en caso de fallo y actualizar la nota sobre CI en docs/DEVELOPMENT.md. Depende de: Configurar CI en GitHub Actions para macOS (591a5a3b) y de que exista remoto de git. Job e2e añadido y subido en el commit 838d8d0; pendiente confirmar que pasa en GitHub Actions. | implementador | 1 | 🔵 en_progreso |  | 2026-09-20 | 2026-09-26 |

<!-- task-manager:end -->
