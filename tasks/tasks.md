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

Hay **6 tareas activas** repartidas en **4 categorías**: 🟡 4 pendientes · 🔵 2 en progreso.

Cada categoría tiene su propia sección con título, descripción y tabla. La categoría de una tarea es la sección en la que vive, no una columna.

### 🗂️ Categorías

| Categoría | Tareas | Qué entra aquí |
|---|---|---|
| 🐛 **Bugs** <br>`bug` | — | Algo que ya existe y no funciona como debería. Corregir comportamiento incorrecto. |
| ✨ **Features** <br>`feature` | — | Funcionalidad nueva que el producto todavía no tiene. |
| 🚀 **Mejoras** <br>`mejora` | 2 | Algo que ya funciona y se pule: usabilidad, rendimiento, ergonomía, robustez. |
| 🎨 **Diseño y UI** <br>`diseno` | 1 | Estilos, layout, design system, componentes visuales y accesibilidad. |
| ♻️ **Refactor** <br>`refactor` | — | Reorganización interna sin cambiar el comportamiento observable. Deuda técnica. |
| 🏗️ **Arquitectura y fundaciones** <br>`arquitectura` | — | Estructura del proyecto, contratos de dominio, módulos base y decisiones estructurales ya tomadas. |
| 🔐 **Seguridad y privacidad** <br>`seguridad` | — | Permisos, datos sensibles, ejecución de código de terceros y políticas de privacidad. |
| 🧪 **Tests y QA** <br>`test` | — | Pruebas automáticas, fixtures, verificación y control de calidad. |
| 📚 **Documentación** <br>`docs` | 1 | README, guías de uso, documentación técnica y de integración. |
| 🔧 **Infraestructura y build** <br>`infra` | 2 | Build, empaquetado, distribución, CI, dependencias y tooling. |
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

<!-- cat:mejora -->
## 🚀 Mejoras

> Algo que ya funciona y se pule: usabilidad, rendimiento, ergonomía, robustez.
>
> **2** tareas · 🟡 1 pendiente · 🔵 1 en progreso

| ID | Título | Descripción | Agente | Nº Agentes | Estado | Bugs | Creada | Actualizada |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 332eab5f-5e14-4f4e-8a0d-c0fdff624919 | Aislar el adapter SQLite en un utilityProcess o worker_thread | better-sqlite3 es síncrono: un SELECT pesado o un step lento bloquea el proceso main y timeoutMs/cancel solo se evalúan entre filas y chunks. Ejecutar el adapter en un worker_thread o utilityProcess y terminarlo para cancelar de forma inmediata, manteniendo la misma interfaz DatabaseAdapter y el cambio transparente para ConnectionManager. Debe decidirse/estimarse antes de cerrar la ejecución de consultas. Depende de: Registrar adapters reales en main y resolver el ABI dual de better-sqlite3. Prioridad baja tras medir en main: el streaming de 100 000 filas retrasa el event loop como máximo 0,7 ms; solo una sentencia pesada de un único paso (agregado sobre 8 M filas) lo bloquea ~600 ms, momento en que ni timeout ni cancelación pueden actuar. Un worker solo aporta valor para consultas pesadas de un solo paso; reevaluar tras el grid y con uso real. | implementador | 1 | 🟡 pendiente |  | 2026-09-19 | 2026-09-19 |
| e9d14ee0-ce22-4412-b2ae-13e61ca5dc30 | Prosa del modelo cuya primera palabra coincide con un comando SQL se abre como pestaña | Límite del analizador que no se tocó en la tarea anterior (46e27feb, prosa sin SQL como pestaña «Desconocida»): una respuesta como «Do you mean…?» en PostgreSQL da el comando DO y sigue abriéndose como pestaña (segura, nunca se ejecuta sola). Endurecer classifySql (main/services/ai-service/sql-output.ts) con una comprobación estructural adicional para sentencias con palabra clave suelta (p. ej. DO, SET, SHOW, CALL, VACUUM, GRANT sin la forma sintáctica mínima esperada, o texto con puntuación de frase final y espacios entre palabras sin operadores SQL), sin rechazar SQL legítimo. Aceptación: añadir casos de prueba con prosa en español e inglés y con SQL legítimo de cada comando; typecheck, lint, format y tests en verde. | implementador | 1 | 🔵 en_progreso |  | 2026-09-21 | 2026-09-26 |

<!-- cat:diseno -->
## 🎨 Diseño y UI

> Estilos, layout, design system, componentes visuales y accesibilidad.
>
> **1** tarea · 🔵 1 en progreso

| ID | Título | Descripción | Agente | Nº Agentes | Estado | Bugs | Creada | Actualizada |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 81d9db32-55f0-41d8-9c67-65d3a00816ca | Estilar el panel «Preguntar» y los ajustes de IA | Contexto común: Strata es un cliente de BBDD keyboard-first (Electron 44 + Vue 3, macOS). El usuario quiere hablar en lenguaje natural con un modelo IA LOCAL y obtener la consulta SQL y su resultado. Máquina del usuario (Apple M4, 24 GB): Ollama en http://127.0.0.1:11434 con qwen3:14b (Q4_K_M, ~9 GB) y nomic-embed-text, y LM Studio en http://127.0.0.1:1234 con qwen/qwen3.8-27b; ambos exponen API compatible con OpenAI. Decisiones tomadas: (a) el motor NO va dentro de la app: se usa el servidor local del usuario (Ollama o LM Studio); (b) los pesos se descargan bajo demanda vía la API de pull de Ollama, con progreso; (c) solo sale hacia el modelo el esquema y la pregunta, nunca las filas de resultado; (d) las llamadas las hace main y solo a loopback (host 127.0.0.1/localhost/::1, sin SSRF) y la CSP del renderer no cambia; (e) el SQL generado es entrada no confiable: se abre en una pestaña nueva y solo se ejecuta solo si es de solo lectura (analyzeSql); lo que escribe o es destructivo no se ejecuta solo y respeta ADR 0004 y la confirmación destructiva; (f) modelo por defecto qwen3:14b (Qwen3 emite bloques <think>: hay que desactivar el razonamiento o descartarlos). TAREA: solo estilos, sin tocar lógica. Depende de: «IA local: panel «Preguntar» en el renderer (lenguaje natural → SQL → resultado)» (ca09e7f2-b993-41ff-9c37-cd7f7f8c9f75) y «IA local: sección de ajustes (proveedor, modelo y descarga con progreso)» (b7a72acb-c771-415c-a233-bd6c3f79e745) (la estructura y el marcado ya deben existir). Alcance: dar estilo al panel/diálogo «Preguntar» (estados reposo, generando, listo, error, aviso de SQL que escribe/destructivo) y a la sección de ajustes de IA (interruptor, selector de proveedor y modelo, probar conexión, barra de progreso de descarga con cancelar). Reglas: SOLO tokens de design-tokens (sin colores hardcodeados; respeta la regla de lint existente); los estados (éxito, error, aviso, generando, descargando) se comunican con glifos/iconos y texto ADEMÁS de color; anillo de foco visible y consistente; respeta prefers-reduced-motion (sin spinners ni transiciones animadas cuando esté activo); contraste correcto en tema oscuro y claro y ancho mínimo de ventana; objetivos de clic ≥ 24×24 px (WCAG 2.5.8). Entregable: capturas de ambos temas (y estado reduced motion) de los estados principales. Criterios de aceptación: typecheck, lint (incluida la regla de colores), format y tests en verde; ningún cambio funcional. Notas de los agentes: el botón «IA» de la barra es solo texto (sin glifo, no hay token) para no romper las 2 líneas; a ~1020–1040 px hay una ventana de anchura en que la barra pasa a 3 líneas (ya existía sin el botón, medido a 1020 px); mientras se descarga qwen3:14b sigue visible el aviso «no está en este servidor»; pulir el diálogo AskDialog (jerarquía, SQL en <pre>, chips de riesgo, callouts) y la sección de Ajustes en ambos temas. | estilista | 1 | 🔵 en_progreso |  | 2026-09-20 | 2026-09-26 |

<!-- cat:docs -->
## 📚 Documentación

> README, guías de uso, documentación técnica y de integración.
>
> **1** tarea · 🟡 1 pendiente

| ID | Título | Descripción | Agente | Nº Agentes | Estado | Bugs | Creada | Actualizada |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a1d61072-28d4-47cd-b9f4-2cbbfc93b919 | Guía de desarrollo y README del proyecto | Documentar cómo arrancar el proyecto desde cero: requisitos (Node ≥ 22.12, pnpm 11, Xcode Command Line Tools y red la primera vez por el rebuild de better-sqlite3 para Electron, Docker Desktop para los tests de integración de PostgreSQL), scripts (dev, build, typecheck, lint, format, test, test:integration, dist), estructura del monorepo, ABI dual de better-sqlite3 (tests con el Node de Electron), carpetas de datos (~/Library/Application Support/Strata), decisiones y ADRs, cómo hacer verificaciones reales con CDP y contenedores efímeros. Nota: el README.md original aparece borrado en el working tree del usuario; confirmar con el usuario antes de recrearlo. |  | 1 | 🟡 pendiente |  | 2026-09-20 | 2026-09-20 |

<!-- cat:infra -->
## 🔧 Infraestructura y build

> Build, empaquetado, distribución, CI, dependencias y tooling.
>
> **2** tareas · 🟡 2 pendientes

| ID | Título | Descripción | Agente | Nº Agentes | Estado | Bugs | Creada | Actualizada |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9d1904e1-6a84-4a12-b948-7a429739d64c | Firmar y notarizar la app y ofrecer x64/universal | Requiere cuenta de Apple Developer (Developer ID Application) y credenciales de notarización, y decisiones del usuario: appId definitivo (hoy provisional dev.strata.app), identidad de firma, si se distribuye también para Intel (x64) o como universal (el rebuild de otra arquitectura sobrescribiría el binario único de better-sqlite3 de desarrollo, revisar), icono definitivo. Quitar identity: null y resetAdHocDarwinSignature, firmar con hardenedRuntime y entitlements ya preparados, notarizar y grapar, y añadir los secretos a la CI. Ver docs/packaging.md. Depende de: Configurar CI en GitHub Actions para macOS. |  | 1 | 🟡 pendiente |  | 2026-09-20 | 2026-09-20 |
| 10db1509-e643-4b5a-957d-7c97ef80bfc0 | Ejecutar los tests E2E de Playwright en el CI de macOS | `pnpm test:e2e` (raíz) construye la app y lanza 16 tests E2E de Playwright (apps/desktop/e2e) que abren ventanas reales de Electron, por lo que necesitan sesión gráfica. Añadir un job al workflow .github/workflows/ci.yml (o uno propio) en macos-latest con sesión gráfica que ejecute esos tests, subir test-results y playwright-report como artefacto en caso de fallo y actualizar la nota sobre CI en docs/DEVELOPMENT.md. Depende de: Configurar CI en GitHub Actions para macOS (591a5a3b) y de que exista remoto de git. | implementador | 1 | 🟡 pendiente |  | 2026-09-20 | 2026-09-20 |

<!-- task-manager:end -->
