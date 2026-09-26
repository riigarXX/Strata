# Guía de desarrollo

Strata es un cliente de escritorio de bases de datos, keyboard-first, para **macOS** (ADR 0002), con PostgreSQL 13+ y SQLite 3.35+. Esta guía explica cómo arrancar el proyecto desde cero y las particularidades que conviene conocer. El plan completo está en `PLAN_BBDD_CLI.md` y las decisiones en [`docs/adr/`](adr/).

## Requisitos

| Necesitas | Para qué |
|---|---|
| macOS (Apple Silicon) | Único sistema soportado en el MVP |
| Node ≥ 22.12 (`.nvmrc`) | Toolchain y scripts |
| pnpm 11 (`packageManager` en `package.json`; con `corepack enable` se instala solo) | Monorepo |
| Xcode Command Line Tools (`xcode-select --install`) | El `postinstall` compila `better-sqlite3` para Electron |
| Red la primera vez | Descarga de Electron y de sus cabeceras para el rebuild |
| Docker Desktop (opcional) | Para `pnpm test:integration` (PostgreSQL 13 y 17 efímeros) y para el spec de PostgreSQL de `pnpm test:e2e` (si no está, ese spec se salta) |

## Primeros pasos

```bash
pnpm install     # instala, descarga Electron y recompila better-sqlite3 (ABI de Electron 44)
pnpm dev         # arranca la app con recarga en caliente
```

No hay pasos manuales: `pnpm install` deja todo listo. Si más adelante algo reinstala solo `better-sqlite3` sin pasar por el `postinstall`, quedaría con el ABI del Node del sistema; un `pnpm install` (o `pnpm rebuild`) lo corrige.

## Scripts (desde la raíz)

| Script | Qué hace |
|---|---|
| `pnpm dev` | Arranca Electron con electron-vite (construye antes los tokens de diseño) |
| `pnpm build` | Typecheck y build de todos los paquetes; la app queda en `apps/desktop/out/` |
| `pnpm typecheck` | `tsc` y `vue-tsc` en todos los paquetes |
| `pnpm lint` | ESLint y la comprobación de colores literales (`scripts/check-hardcoded-colors.mjs`) |
| `pnpm format` / `pnpm format:check` | Prettier (escribe / solo comprueba). Al formatear a mano usa `pnpm exec prettier --write <archivos>` |
| `pnpm test` | Tests unitarios y de componentes de todos los paquetes, más los de `scripts/` |
| `pnpm test:integration` | Tests de los adapters contra PostgreSQL 13 y 17 reales (necesita Docker) |
| `pnpm test:e2e` | Construye la app y ejecuta los tests E2E con Playwright sobre el build sin empaquetar (`apps/desktop/out`). SQLite siempre; el spec de PostgreSQL solo si hay Docker o `STRATA_TEST_PG_URL` (si no, se salta). Abre ventanas reales de Electron |
| `pnpm screenshots` | Construye la app y regenera las capturas del README en `docs/screenshots/` (`<nombre>-dark.png` y `<nombre>-light.png`) con Playwright (`apps/desktop/e2e/screenshots/`, config `playwright.screenshots.config.ts`). Crea una base SQLite de librería ficticia en un directorio temporal y usa el Ollama falso; no forma parte de `test:e2e` ni del CI. Abre ventanas reales de Electron |
| `pnpm dist` | Genera el instalador (`.dmg` y `.zip`, arm64, sin firma) en `apps/desktop/release/` |
| `pnpm --filter @strata/desktop run pack` | Solo el `.app`, sin instalador. Ojo: `pnpm pack` es un comando propio de pnpm, no este script |

Antes de dar por buena una tarea se ejecutan siempre `typecheck`, `lint`, `format:check`, `test` y `build` (y `test:integration` si toca adapters o contratos).

## Estructura del monorepo

```text
apps/desktop/
  src/main/       Proceso principal: único dueño de drivers, sesiones, credenciales, historial y preferencias
    services/     connection-manager, credential-store, query-executor, history-store, preferences-store, ai-service
    ipc/          Handlers IPC (patrón secure-handler: remitente + payload revalidado + IpcResult)
    security/     CSP, esquema propio app:// que sirve el renderer, política de navegación y permisos, filtro de peticiones file:, validación de remitente
  src/preload/    API acotada window.db.* con contextBridge (sin ipcRenderer expuesto)
  src/renderer/   Vue 3 + Pinia: features/{workspace, connections, schema-browser, query-editor,
                  execution, results, command-palette, settings, preferences, history, ai}
  src/shared/     Tipos compartidos entre preload y renderer (DbApi, IpcResult)
packages/
  contracts/      Schemas Zod y tipos: perfiles, sesiones, consultas, eventos, canales IPC, preferencias, historial, asistente de IA
  db-core/        Interfaz DatabaseAdapter, registro, adapters SQLite (better-sqlite3) y PostgreSQL (pg),
                  análisis SQL (analyzeSql) y límites de resultados. Sin dependencias de Electron ni de Vue
  commands/       CommandRegistry, atajos, búsqueda difusa y parser de comandos internos (TS puro)
  design-tokens/  Tokens DTCG → tokens.css, tokens.json y tipos, con tests de contraste WCAG
scripts/          Comprobaciones de CI locales (colores literales)
docs/             ADRs, threat model, auditoría de seguridad, empaquetado y esta guía
tasks/            Backlog del proyecto (gestionado con la skill task-manager)
spikes/           Spike desechable del driver SQLite (ya validado; se puede borrar)
```

Flujo de una consulta: renderer → `window.db.query.execute` (preload) → IPC validado en main → `QueryExecutor` → `DatabaseAdapter.execute()` (`AsyncIterable<QueryEvent>`) → eventos por lotes con backpressure de vuelta al renderer → grid virtualizado. Cada capa solo conoce a la de al lado.

## Datos locales

Todo vive en `~/Library/Application Support/Strata/` (el nombre de la app decide esta ruta y la entrada del Keychain: no lo cambies sin migrar):

| Archivo | Contenido |
|---|---|
| `connections.json` | Perfiles públicos (sin secretos) |
| `credentials.json` | Secretos cifrados con `safeStorage` (Keychain) |
| `history.json` | Historial de consultas (texto SQL, nunca resultados); retención 30 días por defecto |
| `preferences.json` | Tema, límites de ejecución, historial y asistente de IA (desactivado de fábrica; solo dirección de bucle local y nombre del modelo, sin secretos) |

Los cuatro tienen modo 0600, escritura atómica y copia `.corrupt` si se dañan.

## Asistente de IA local

Hablar en lenguaje natural con un modelo que corre en tu equipo y obtener la consulta SQL y su resultado ([ADR 0012](adr/0012-ia-local.md)). La superficie es `window.db.ai` (`status`, `listModels`, `generateSql`, `pullModel`, `cancel`, `onPullProgress`) sobre `apps/desktop/src/main/services/ai-service/`. En el renderer, `features/ai/` la envuelve (`useAiApi`) y aporta la sección «IA local» de Ajustes (`Cmd+,` o «Abrir ajustes de IA» en la paleta: activar el asistente, elegir proveedor y dirección de bucle local, «Probar conexión», elegir modelo y descargar `qwen3:14b` con progreso, solo Ollama) y el panel «Preguntar».

**Preguntar** (`Cmd+Shift+A`, «Preguntar a la base…» en la paleta, `\ask`, o el botón «IA» de la barra de ejecución): escribe la pregunta y `Cmd+Enter` la envía; `Esc` cancela la generación en curso y, con nada en marcha, cierra el diálogo y devuelve el foco al editor. La consulta se abre siempre en una **pestaña nueva** asociada a la conexión activa (título «IA: …»); el diálogo muestra el SQL como texto, su riesgo (`Lectura`, `Escritura`, `Destructiva`, `Desconocida`, con glifo y palabra), los avisos y, en un perfil de solo lectura, por qué no se puede ejecutar. Requiere la IA activada en Ajustes y una conexión abierta; si falta algo lo explica sin llamar al modelo.

- **Solo se ejecuta sola una consulta `read`** (`SELECT`, `WITH` de lectura, `EXPLAIN` sin `ANALYZE`…) sin bloquear, en una sesión sin transacción (abierta o abortada) y sin otra ejecución en curso. Va con `enforceReadOnly: true`: main la limita a consultas planas y, en PostgreSQL, la ejecuta dentro de `BEGIN READ ONLY` con `ROLLBACK` siempre.
- **Todo lo demás** (`write`, `destructive`, `unknown`, bloqueado, transacción del usuario abierta, sesión ocupada) **queda en la pestaña sin ejecutar**; al pulsar «Ejecutar» sigue el flujo normal, con su confirmación destructiva.
- La pregunta no se guarda en ningún sitio (solo da título abreviado a la pestaña); el SQL ejecutado sí entra en el historial como cualquier otro.
- Código: `stores/ask.ts` (estados `idle`, `generating`, `ready`, `error`, `cancelled`, cancelación y descarte de respuestas tardías por `requestId`), `model/ask.ts` (`decideAutoRun`, textos y `describeAskError`), `components/AskDialog.vue` y `testing/fake-ai.ts` (`stubGenerateSql`, un `generateSql` que el test resuelve a mano).

```text
generateSql(pregunta, sesión) → esquema de la sesión (listTables + describeTable, acotado y saneado)
  → prompt de sistema + esquema + pregunta → servidor local (Ollama /api/chat o /v1/chat/completions)
  → saneado (<think>, vallas, prosa) → una sola sentencia → analyzeSql → { sql, risk, statementType, warnings, blocked? }
```

- **El servicio no ejecuta nada**: devuelve la sentencia y su riesgo (`read`, `write`, `destructive`, `unknown`); decide el renderer (véase «Preguntar»). En un perfil de solo lectura, lo que no es `read` sale con `blocked: true`. Si el modelo responde `-- CANNOT_ANSWER`, el error es `cannot_answer`; si responde prosa que no es una sentencia, `validation_failed`. Con la transacción de la sesión abortada (PostgreSQL) el error es `transaction_aborted` y no se lee el esquema ni se llama al modelo; con una transacción activa se pregunta con normalidad.
- **Solo bucle local**: `ai.baseUrl` únicamente admite `http(s)://127.0.0.1|localhost|[::1]:<puerto 1024-65535>[/ruta]`. Nada de red sale del renderer.
- **Solo esquema y pregunta** hacia el modelo, nunca filas ni valores; nada se registra en consola ni logger.
- Desactivado de fábrica (`preferences.ai.enabled = false`): `generateSql` y `pullModel` responden `permission_denied` hasta activarlo.

Piezas de `services/ai-service/`: `endpoint.ts` (validación de la dirección), `http.ts` (cliente `fetch`: tiempos, cancelación, sin redirecciones, topes de tamaño, NDJSON), `ollama-provider.ts` y `openai-provider.ts` (tras la interfaz `AiProvider`), `schema-context.ts` (esquema con presupuesto), `prompt.ts`, `sql-output.ts` (saneado, una sentencia, riesgo) y `ai-service.ts` (orquestación, cancelación y tope de concurrencia). `testing.ts` es el servidor HTTP falso de los tests.

### Probarlo con Ollama

```bash
ollama serve                    # o abre la app de Ollama: escucha en 127.0.0.1:11434
ollama pull qwen3:14b           # ~9 GB; también se puede descargar con window.db.ai.pullModel
pnpm dev                        # con la app abierta, en la consola de DevTools del renderer:
```

```js
// 1. Activar el asistente (desactivado de fábrica) y comprobar qué hay en el equipo
await window.db.preferences.update({ ai: { enabled: true } })
await window.db.ai.status() // Ollama en 11434 y LM Studio en 1234: reachable y versión
await window.db.ai.listModels({}) // modelos del servidor configurado

// 2. Con una conexión abierta (sessionId de window.db.connections.connect)
await window.db.ai.generateSql({ requestId: 'q1', sessionId, question: '¿Cuántos pedidos hizo cada cliente?' })
// → { ok: true, data: { sql, risk: 'read', statementType: 'query', warnings: [] } }

// 3. Descargar un modelo con progreso, y cancelarlo
const off = window.db.ai.onPullProgress((p) => console.log(p.status, p.completed, p.total))
await window.db.ai.pullModel({ requestId: 'pull1', model: 'qwen3:14b' })
await window.db.ai.cancel({ requestId: 'pull1' })
```

Para LM Studio: arranca su servidor local (puerto 1234) y guarda `{ ai: { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', model: '<id del modelo>' } }`; LM Studio no descarga modelos desde la API (`pullModel` responde `validation_failed`). Con `custom` sirve cualquier servidor compatible con OpenAI en el bucle local. Los tests automáticos no necesitan ningún modelo: usan un servidor HTTP falso en `127.0.0.1` (`ai-service/testing.ts` en main, `features/ai/testing/fake-ai.ts` en el renderer, y `e2e/support/fake-ollama.ts` en los E2E).

Latencia de referencia (Apple M4, 24 GB, `qwen3:14b` en caliente, medida con el servicio real): 0,7–8,6 s por consulta con esquemas de cinco tablas en SQLite y PostgreSQL 17 (`SELECT` simples ~1,5 s, con varios `JOIN` 5–9 s); la primera petición tras arrancar Ollama, o tras cambiar el tamaño de contexto, incluye cargar ~9 GB en memoria y puede tardar decenas de segundos.

Medido desde el panel «Preguntar» (build de producción, SQLite con cinco tablas relacionadas, `qwen3:14b` en Ollama, de `Cmd+Enter` a SQL listo y consulta lanzada): 0,8–1,9 s con `SELECT` simples y una sentencia destructiva o la respuesta `cannot_answer`; 3,9 s con un `JOIN` y `GROUP BY`; la primera pregunta tras arrancar Ollama tardó 11,8 s (carga del modelo en memoria).

## Tests y el ABI de `better-sqlite3`

`better-sqlite3` es un módulo nativo y hay **un único binario**, compilado para Electron 44 (ABI 149). Por eso los tests de `packages/db-core` se ejecutan con el Node de Electron (`ELECTRON_RUN_AS_NODE=1`) y no con el Node del sistema. Los tests de `apps/desktop` sí usan el Node del sistema porque no cargan el `.node`. Detalles y alternativas descartadas en [ADR 0007](adr/0007-drivers-postgresql-sqlite.md).

## Tests E2E (Playwright + Electron)

`pnpm test:e2e` (raíz) hace `pnpm build` y lanza `playwright test` en `apps/desktop`. Para repetir sin reconstruir: `pnpm --filter @strata/desktop test:e2e` (falla con un aviso si falta `apps/desktop/out/`).

- Los tests viven en `apps/desktop/e2e/*.e2e.ts` y arrancan la app con `_electron.launch` sobre `out/`. No hace falta `playwright install`: Electron no usa los navegadores de Playwright.
- Cada test usa un `--user-data-dir` temporal propio: nunca tocan `~/Library/Application Support/Strata`. La BD SQLite fixture se crea al vuelo con el Node de Electron (mismo ABI que `better-sqlite3`), y el selector nativo de archivos se sustituye desde main con `electronApp.evaluate`. La app arranca con `--use-mock-keychain`: aun así, los tests de PostgreSQL crean el perfil **sin contraseña** cuando el servidor lo permite.
- Se ejecutan en serie (comparten pantalla y foco) y abren ventanas reales: no uses el equipo durante la ejecución local. Localizan por rol y nombre accesible y esperan por condición, sin `sleep`.
- Los E2E de la IA usan un Ollama falso (`e2e/support/fake-ollama.ts`, fixture `ollama`: un servidor propio por test en un puerto libre de `127.0.0.1` que registra cada petición y se conduce desde el test) y los helpers de `e2e/support/ai.ts`. Ningún test usa un modelo real ni toca el Ollama del equipo.
- La sonda de superficie del preload, CSP, origen `app://strata` y `file://` es la misma que usa el smoke del paquete (`apps/desktop/scripts/smoke-packaged.mjs`): un cambio en la política se prueba en las dos.
- No sustituyen al smoke del paquete: los E2E ejercitan el build sin empaquetar; el smoke, el `.app` final y sus fuses.

### Qué cubre cada spec

| Spec | Cubre |
|---|---|
| `launch`, `connection-and-query`, `keyboard`, `settings`, `history`, `editor-csp`, `security` | Arranque (incluido el tamaño mínimo de ventana, 720×560), perfil SQLite y consulta básica, flujo solo con teclado, ajustes, historial (y que la barra de ejecución, con el botón «IA» incluido, sigue en dos líneas y con objetivos de 24 px de 720 a 1280 px), CSP del editor y superficie de seguridad |
| `transactions.e2e.ts` (SQLite) | Iniciar, escribir y confirmar (persiste en disco) o revertir (no persiste), verificado desde otra conexión al archivo; en SQLite un error dentro de la transacción **no** la aborta (el adaptador no tiene estado «abortada»); `BEGIN`/`COMMIT` escritos a mano; comandos de la paleta; el chip de la barra de ejecución y la barra de estado (`role=status`) |
| `destructive.e2e.ts` (SQLite) | Diálogo de confirmación (ADR 0004) para `DELETE`/`UPDATE` sin `WHERE` y `DROP`: cancelar (botón o Escape) no ejecuta, confirmar sí; varias sentencias con «Ejecutar todo» (solo se listan las destructivas; la selección inocua no pide confirmación pero «Ejecutar todo» sí); resumen de más de diez; dentro de una transacción; desactivar la confirmación en Ajustes |
| `read-only.e2e.ts` (SQLite) | Perfil de solo lectura: indicador «Solo lectura», los `SELECT`/CTE/`EXPLAIN` funcionan, las escrituras (DML, DDL, CTE que escribe, `PRAGMA` de escritura) se rechazan en main con un mensaje claro y sin tocar la base, un documento con una sola escritura se rechaza entero, sin diálogo de confirmación, y las transacciones se pueden iniciar y cerrar |
| `cancel.e2e.ts` (SQLite) | Cancelar con el botón, con Escape y desde la paleta: estado «cancelada», mensaje, la ejecución se detiene de verdad, entrada «Cancelada» en el historial, la transacción abierta sigue activa si la consulta es interrumpible, y se revierte con aviso si es un único paso ininterrumpible |
| `ai.e2e.ts` (SQLite) | Superficie `window.db.ai` sin interfaz, contra la app real y un Ollama falso en `127.0.0.1` (ningún test usa un modelo): desactivado de fábrica (`permission_denied` sin tocar la red), `status`/`listModels`/`generateSql` con el esquema real y ninguna fila en el prompt, clasificación de riesgo y `blocked` en solo lectura, direcciones que no son de bucle local rechazadas por IPC y preferencias, y descarga con `onPullProgress` y `cancel` idempotente |
| `ask.e2e.ts` (SQLite) | Panel «Preguntar» de punta a punta contra la app real y el Ollama falso: una pregunta de lectura abre pestaña nueva, se ejecuta sola y muestra el grid (y al modelo solo le llegan el esquema y la pregunta); escritura (`UPDATE … WHERE`, `INSERT`), destructiva (`DROP`, `DELETE`/`UPDATE` sin `WHERE`) y desconocida (`BEGIN`) se abren **sin ejecutarse** y la base queda idéntica (leída por otra conexión); lanzar a mano la destructiva pasa por la confirmación de siempre; en un perfil de solo lectura la lectura corre y lo demás sale bloqueado (y main rechaza la escritura si se lanza a mano); `cannot_answer` se explica y no abre pestañas; `Esc` cancela la generación (y main aborta la petición), conserva el texto y el siguiente `Esc` cierra; con la IA desactivada solo ofrece «Abrir ajustes de IA»; el botón «IA» de la barra abre el diálogo y `Esc` devuelve el foco al editor |
| `ask-errors.e2e.ts` (SQLite) | Errores del panel con el Ollama falso: servidor caído (conexión rechazada), modelo no instalado (404) y tiempo agotado (504; el tope real de main son 120 s y no se espera) con mensajes propios de la interfaz que nunca repiten lo que dice el servidor, «Cancelar generación» con la petición abortada en el servidor, dos sentencias rechazadas sin tocar la base, respuesta sin sentencia y respuesta que es prosa sin SQL (ambas «no devolvió una consulta SQL válida», distintas de `cannot_answer`, sin abrir pestaña) y saneado de `<think>…</think>`, vallas de código y prosa alrededor, con sus avisos |
| `ai-download.e2e.ts` (SQLite) | Descarga desde Ajustes ▸ IA local con un `/api/pull` que el test emite línea a línea: activar la IA y apuntar al servidor desde la interfaz, barra `role=progressbar` indeterminada y luego con valores crecientes sobre varias capas (que no retrocede), terminada (modelo instalado y en el selector), cancelada (el servidor ve cerrarse la conexión) y con errores (línea `error`, conexión cortada, respuesta sin `success`), con reintento |
| `ai-loopback.e2e.ts` (SQLite) | La frontera de la IA: en una sesión completa (Ajustes, descarga y dos preguntas) todas las peticiones que recibe el servidor falso llegaron a `127.0.0.1`, a las cuatro rutas esperadas y sin credenciales ni cookies; ningún valor «canario» de las filas ni de los valores por defecto aparece en ningún cuerpo (aunque el grid los muestre); una dirección que no es de bucle local se rechaza desde Ajustes sin guardarla ni conectar, y una escrita a mano en `preferences.json` se repone con copia `.corrupt` |
| `postgres.e2e.ts` | Perfil creado por la UI sin contraseña, conexión, árbol de esquema, `SELECT`, transacciones verificadas desde otra conexión, **transacción abortada real** (chip «Transacción abortada» y aviso; solo pasan `ROLLBACK`/`ROLLBACK TO SAVEPOINT`/`COMMIT`, cualquier otra sentencia se rechaza sin llegar al servidor, ADR 0004; Revertir o `ROLLBACK` a mano la recuperan), cancelación real (`pg_sleep`) comprobada en `pg_stat_activity`, solo lectura, `TRUNCATE`/`DELETE` con confirmación y desconexión |
| `ask-postgres.e2e.ts` | Panel «Preguntar» contra PostgreSQL (se salta igual que `postgres.e2e.ts`, véase abajo): un `SELECT` del modelo se autoejecuta dentro de una transacción de solo lectura (`current_setting('transaction_read_only')` devuelve `on`, y `off` a mano después); una función `VOLATILE` que inserta y que el analizador da por lectura, devuelta como `SELECT mi_funcion()`, falla con el error de transacción de solo lectura sin escribir nada (comprobado desde otra conexión, con un control que sí escribe sin la marca); con una transacción abierta por el usuario el esquema llega al modelo y la consulta se abre pero no se ejecuta sola; con la transacción **abortada** el panel muestra «Hay una transacción abortada en esta conexión: pulsa «Revertir»…», el modelo no recibe ninguna petición y tras «Revertir» se puede preguntar con normalidad |

### E2E de PostgreSQL: cuándo se ejecuta

El servidor lo decide `apps/desktop/e2e/support/postgres.ts`, por este orden:

1. `STRATA_E2E_SKIP_PG=1`: los specs de PostgreSQL (`postgres.e2e.ts` y `ask-postgres.e2e.ts`) se saltan siempre.
2. `STRATA_TEST_PG_URL=postgres://usuario[:password]@host:puerto/base`: usa ese servidor (crea y borra un esquema propio `strata_e2e_*`, no toca nada más). Si la URL lleva password, el test la escribe en el formulario y la guarda con el `CredentialStore` (con `--use-mock-keychain`, sin diálogo de Keychain).
3. Si Docker responde: levanta un contenedor efímero `postgres:17` (`strata-test-e2e-*`, etiqueta `strata-test=e2e-postgres`) con `POSTGRES_HOST_AUTH_METHOD=trust` en un puerto libre de loopback y lo elimina en `afterAll` (cada spec de PostgreSQL levanta el suyo). Los que quedaran de una ejecución abortada (más de 30 min) se retiran en la siguiente.
4. Si no hay ni URL ni Docker, se saltan con un aviso en stderr (`[e2e] PostgreSQL omitido: …`) y no falla.

```bash
pnpm test:e2e                                   # con Docker: corre PostgreSQL; sin Docker: se salta
STRATA_E2E_SKIP_PG=1 pnpm test:e2e              # forzar el salto (solo SQLite)
STRATA_TEST_PG_URL=postgres://postgres@localhost:5432/postgres pnpm test:e2e   # contra un servidor existente
pnpm --filter @strata/desktop test:e2e e2e/postgres.e2e.ts                     # solo ese spec, sin reconstruir
```

SQLite corre en un `worker_thread` (un hilo por sesión), así que una sentencia pesada de un solo paso no bloquea el proceso main y la cancelación y el `timeoutMs` responden de inmediato: el hilo atascado se abandona y se abre otro con la misma sesión. Con una transacción abierta el adapter espera hasta 5 s a que el worker confirme la cancelación (150 ms sin transacción), así que cancelar una consulta interrumpible, incluso lenta paso a paso, nunca cierra la transacción (ADR 0004). Límite conocido: si un único paso nativo no vuelve en ese plazo, el hilo se abandona (sigue gastando CPU hasta terminar), la transacción se pierde como un rollback y se avisa en Mensajes («The statement could not be interrupted: the transaction was rolled back»). Los tests de db-core cubren este caso con una CTE recursiva de un solo paso; la decisión está en [ADR 0013](adr/0013-sqlite-en-worker-thread.md). En PostgreSQL la cancelación se prueba con `pg_sleep` cancelado en el servidor.

## Verificar de verdad, no solo con tests

Los tests unitarios no bastan para el aislamiento, la CSP ni el empaquetado. La práctica habitual del proyecto es arrancar la app y comprobarla por CDP:

- Ejecuta el **build de producción** (`pnpm build`, luego `electron .` desde `apps/desktop`) con `--remote-debugging-port=<puerto libre>` y `--user-data-dir=<carpeta temporal>`, y evalúa expresiones con `Runtime.evaluate` usando `allowUnsafeEvalBlockedByCSP: false` (por defecto CDP se salta el bloqueo de `eval` por CSP y engaña la prueba).
- Para simular teclas (atajos, paleta) usa `Input.dispatchKeyEvent`; para capturas, `Page.captureScreenshot` y `Emulation.setEmulatedMedia` para probar el tema claro y el oscuro.
- Para PostgreSQL usa un contenedor efímero con `POSTGRES_HOST_AUTH_METHOD=trust` y **sin password**: guardar una password con el `CredentialStore` real dispara un diálogo de Keychain de macOS que bloquea la ejecución.
- `node_modules/.bin/electron` es un shim: si solo matas el shim puede quedar vivo el proceso real. Termina por la carpeta de datos (`pkill -KILL -f <user-data-dir>`).
- El selector nativo de archivos de SQLite se sustituye desde el inspector de main durante la verificación.
- Los contenedores efímeros se nombran `strata-verify-*` (verificaciones) y `strata-test-*` (tests de integración) y hay que eliminarlos al terminar.

## CI (GitHub Actions)

Los workflows viven en `.github/workflows/`. Ningún workflow necesita secretos ni variables.

| Workflow | Cuándo corre | Qué hace |
|---|---|---|
| `ci.yml`, job `verify` (macOS Apple Silicon, `macos-latest`) | Cada pull request, push a `main` y a mano | `pnpm install --frozen-lockfile` (el `postinstall` recompila `better-sqlite3`; las Xcode CLT ya vienen en el runner), `lint` (incluye colores), `format:check`, `typecheck`, `test` y `build` |
| `ci.yml`, job `integration` (Linux, matriz `13` y `17`) | Igual | `pnpm test:integration` contra un *service container* `postgres:<versión>`. Los runners macOS no traen Docker, por eso va en Linux |
| `ci.yml`, job `e2e` (macOS Apple Silicon) | Igual | `pnpm test:e2e`: construye la app y ejecuta los E2E de Playwright con ventanas reales de Electron (el runner tiene sesión gráfica). Si falla, sube `test-results/` y `playwright-report/` de `apps/desktop` como artefacto `playwright-results` (7 días) |
| `package.yml` (macOS Apple Silicon) | Pull request o push a `main` que cambie `apps/desktop/**`, `packages/db-core/**`, `pnpm-lock.yaml` o el propio workflow; y a mano (`workflow_dispatch`) | `pnpm build`, `pnpm --filter @strata/desktop run pack` y `apps/desktop/scripts/smoke-packaged.mjs` |

Notas:

- pnpm sale de `packageManager` (`pnpm/setup`, con caché del store) y Node de `.nvmrc` (`actions/setup-node`). También se cachea el binario de Electron (`~/Library/Caches/electron` en macOS, `~/.cache/electron` en Linux) y las cabeceras que usa `electron-rebuild` (`~/.electron-gyp`), con la versión de Electron como clave.
- `apps/desktop/electron-builder.yml` está dentro de `apps/desktop/**`, así que un cambio en él dispara `package.yml`. Los demás paquetes (`contracts`, `commands`, `design-tokens`) no lo disparan por sí solos, aunque acaban dentro del bundle: si un cambio ahí puede afectar al paquete, lánzalo a mano.
- Sobre PostgreSQL: la suite usa `STRATA_TEST_PG_URL` (`postgres://postgres:strata-ci@localhost:5432/postgres` en el job) y entonces prueba **un** servidor externo en lugar de levantar sus propios contenedores. Por eso hay un job por versión y no una variable por versión. Ese servidor no acepta TLS, así que los 2 tests de TLS se saltan en CI y solo corren en local con Docker (`pnpm test:integration` sin variable).
- El smoke solo funciona en macOS y necesita sesión gráfica: el runner la tiene, un contenedor no.
- El job `e2e` corre sobre el build sin empaquetar. En macOS no hay Docker, así que el spec de PostgreSQL se salta salvo que se le dé un servidor con `STRATA_TEST_PG_URL` (ya lo cubre el job `integration`). El reporter es `list`, por lo que `playwright-report/` solo existirá si se configura otro; los artefactos con trazas viven en `test-results/`.

### Reproducir el CI en local

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build   # job verify
```

Integración (un PostgreSQL efímero por versión; sin `STRATA_TEST_PG_URL` la suite levanta las dos ella sola con Docker):

```bash
docker run -d --rm --name strata-verify-pg17 -e POSTGRES_PASSWORD=strata-ci -p 127.0.0.1:5432:5432 postgres:17
STRATA_TEST_PG_URL=postgres://postgres:strata-ci@localhost:5432/postgres pnpm test:integration
docker rm -f strata-verify-pg17
```

Smoke del paquete (mismos pasos que `package.yml`):

```bash
pnpm build && pnpm --filter @strata/desktop run pack
node apps/desktop/scripts/smoke-packaged.mjs                                # 15 comprobaciones (fuses incluidos); código 0 si pasan
node apps/desktop/scripts/smoke-packaged.mjs --simulate-failure=extra-db-section   # debe fallar (código 1): prueba el propio smoke
node apps/desktop/scripts/smoke-packaged.mjs --simulate-failure=file-protocol-fuse-on   # idem para la comprobación de fuses
```

Para validar los YAML: `actionlint` (`brew install actionlint`) y `pnpm format:check` (Prettier revisa `.github/`).

## Reglas que no se rompen

- El renderer no importa Node ni drivers, y nunca recibe una password por IPC (invariantes completos en [`threat-model.md`](threat-model.md)).
- Todo payload IPC se revalida en main con los schemas de `@strata/contracts`; los canales salen solo de `IPC_CHANNELS`.
- Ningún color literal en el renderer: todo sale de `@strata/design-tokens` (lo comprueba `pnpm lint`).
- Ningún resultado de consulta se persiste en disco.
- Un perfil de solo lectura no puede escribir aunque el renderer falle: lo bloquea main con `analyzeSql`.

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `ERR_PNPM_IGNORED_BUILDS` al instalar | pnpm 11 exige declarar qué paquetes pueden ejecutar scripts de build: revisa `allowBuilds` en `pnpm-workspace.yaml` |
| Un test de `db-core` falla al cargar `better-sqlite3` | Binario con el ABI del Node del sistema: `pnpm install` o `pnpm rebuild` |
| `Cannot find module 'electron/package.json'` en electron-vite | Reinstalación concurrente que dejó `node_modules` a medias: repite `pnpm install` |
| `test:integration` se salta con un aviso | Docker no está en marcha (arráncalo) o define `STRATA_TEST_PG_URL` para usar un PostgreSQL existente |
| macOS rechaza un `.dmg` o `.zip` descargado | No está firmado ni notarizado y la descarga queda en cuarentena (el `.app` compilado en tu propio Mac abre normal): clic derecho → Abrir, o `xattr -dr com.apple.quarantine /Applications/Strata.app` (`docs/packaging.md`) |

## Más documentación

- [`docs/adr/`](adr/): decisiones de alcance, SO, versiones, política SQL, historial, electron-vite, drivers, IPC, almacenamiento, streaming, protocolo `app://` y asistente de IA local.
- [`docs/threat-model.md`](threat-model.md) y [`docs/security-audit.md`](security-audit.md): modelo de amenazas y auditoría.
- [`docs/packaging.md`](packaging.md): empaquetado, fuses, firma pendiente.
- La sección «CI (GitHub Actions)» de esta guía: workflows, smoke del paquete y cómo reproducirlos.
