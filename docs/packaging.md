# Empaquetado y distribución (macOS arm64)

Estado: primer empaquetado funcional, **sin firmar ni notarizar** (Fase 6 del plan; no hay cuentas de Apple todavía). Decisiones de fondo en [ADR 0002](adr/0002-sistemas-operativos-objetivo.md) y [ADR 0007](adr/0007-drivers-postgresql-sqlite.md).

## Cómo construir

Desde la raíz, en un Mac Apple Silicon con `pnpm install` ya ejecutado (necesita Xcode Command Line Tools y red la primera vez para bajar Electron):

```sh
pnpm dist                                 # build + dmg + zip en apps/desktop/release/
pnpm build && pnpm --filter @strata/desktop run pack   # solo el .app, sin instalador (rápido)
```

Usa `pnpm run pack` (o `--filter … run pack`): `pnpm pack` a secas es un comando propio de pnpm que crea un tarball y no ejecuta el script.

Artefactos en `apps/desktop/release/` (ignorado por git):

- `Strata-<versión>-arm64.dmg` y `Strata-<versión>-arm64.zip` (~128 MB cada uno; el `.app` ocupa ~291 MB, casi todo Electron Framework).
- `mac-arm64/Strata.app`: el paquete sin comprimir; sirve para probarlo directamente.

La versión sale de `apps/desktop/package.json`. La configuración vive en `apps/desktop/electron-builder.yml`; los recursos, en `apps/desktop/build/`.

## Qué entra en el paquete

- `package.json#dependencies` de `apps/desktop` contiene **solo** lo que main carga sin bundlear: `better-sqlite3`, `pg`, `pg-cursor`. Todo lo demás (Vue, Pinia, CodeMirror, `@strata/*`…) va en `devDependencies` porque Vite ya lo incluye en `out/`; si se añadiera a `dependencies`, electron-builder lo copiaría también al asar.
- `files` limita el asar a `out/**` y a los módulos de runtime, sin mapas de fuentes, sin las fuentes de SQLite ni el árbol de compilación de `better-sqlite3`, ni `prebuild-install` y su árbol (solo sirve al instalar). Resultado: `app.asar` de ~2,6 MB y `app.asar.unpacked` de ~2 MB.
- `better-sqlite3` va en `asarUnpack`: un `.node` no se puede cargar con `dlopen` desde dentro de un asar. Se comprobó que el módulo se mapea desde `Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`.
- `better-sqlite3` se carga en un `worker_thread` ([ADR 0013](adr/0013-sqlite-en-worker-thread.md)). electron-vite compila `worker.ts` de `@strata/db-core` como chunk propio (`out/main/worker-*.js`, import con `?modulePath`), que queda dentro del asar y resuelve `better-sqlite3` en `app.asar.unpacked` sin configuración extra (comprobado abriendo una base real desde el worker del paquete). No hay que añadir nada a `files` ni a `asarUnpack`.
- Si se actualiza `better-sqlite3`, revisa la lista de exclusiones de `prebuild-install` en `electron-builder.yml` (los patrones que no coinciden con nada son inofensivos; una exclusión de más se detecta al arrancar el paquete).

## Rebuild nativo

`npmRebuild: true`: electron-builder recompila `better-sqlite3` contra Electron 44 (ABI 149) para arm64. El `postinstall` de `apps/desktop` ya deja ese mismo binario en `node_modules`, así que el rebuild del empaquetado es idempotente (no toca el `.node` si ya coincide) y no rompe `pnpm test` ni `pnpm test:integration`, que cargan el módulo con el Node de Electron. Para soportar x64 o universal habrá que revisar este punto: el rebuild de otra arquitectura sobrescribiría el binario único de desarrollo.

## Fuses de Electron

Se aplican con `electronFuses` de electron-builder (usa `@electron/fuses` y los cambia justo antes de firmar, después de calcular el hash del asar). Se leen con `pnpm --filter @strata/desktop exec electron-fuses read --app release/mac-arm64/Strata.app`.

| Fuse                                            | Valor | Motivo                                                                          |
| ----------------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| `RunAsNode`                                     | off   | El binario no puede usarse como intérprete de Node (`ELECTRON_RUN_AS_NODE`).    |
| `EnableNodeOptionsEnvironmentVariable`          | off   | `NODE_OPTIONS` no puede inyectar código en main.                                |
| `EnableNodeCliInspectArguments`                 | off   | `--inspect` y `SIGUSR1` no abren el depurador de main.                          |
| `EnableEmbeddedAsarIntegrityValidation`         | on    | El hash del asar se valida al arrancar (`ElectronAsarIntegrity` en Info.plist). |
| `OnlyLoadAppFromAsar`                           | on    | No se puede sustituir el asar por un directorio `app/`.                         |
| `EnableCookieEncryption`                        | on    | Cookies cifradas con la clave del Keychain.                                     |
| `GrantFileProtocolExtraPrivileges`              | off   | El renderer se sirve por `app://`, no por `file://`. Ver abajo.                 |
| `resetAdHocDarwinSignature` (opción de la lib.) | true  | Ver «Firma».                                                                    |

`GrantFileProtocolExtraPrivileges` está en `off`. Antes tenía que estar en `on` (valor por defecto) porque la app cargaba el renderer por `file://` y Vite emite `<script type="module" crossorigin>`, que Chromium no admite bajo `file://` sin esos privilegios: con el fuse en `off` el renderer no montaba. Desde el [ADR 0011](adr/0011-protocolo-app.md) el renderer se sirve por el esquema propio `app://strata` (`src/main/security/app-protocol.ts`, solo `out/renderer`), de modo que ninguna página `file://` necesita privilegios extra. El resto de fuses no cambia. El smoke del paquete lee los fuses del binario y falla si este vuelve a estar en `on` o si otro se aparta de la tabla.

Comprobado sobre el paquete real: con esos fuses, `--inspect=<puerto>` no abre ningún puerto y `ELECTRON_RUN_AS_NODE=1 … -e "…"` arranca la aplicación en lugar de ejecutar el script.

## Depuración remota (`--remote-debugging-port`)

**No es un fuse y sigue funcionando en el paquete**: `Strata.app/Contents/MacOS/Strata --remote-debugging-port=<puerto>` abre el protocolo CDP de Chromium sobre el renderer (no sobre main, cuyo inspector sí está bloqueado). Es útil para la verificación y para futuros E2E (Playwright/CDP sobre el binario empaquetado).

Riesgo aceptado del modelo de amenazas del escritorio: un atacante con ejecución local como el mismo usuario podría lanzar la app con ese flag y controlar el renderer, es decir, invocar `window.db.*` con las sesiones y perfiles de ese usuario. Ese atacante ya puede leer los mismos archivos y abrir sus propias conexiones, y main sigue validando cada llamada IPC (ADR 0008), por lo que no se añade mitigación en el MVP. Cerrarlo exigiría un cambio en `src/main` para rechazar el switch en producción, con un coste desproporcionado para el MVP.

Para probar el paquete con CDP sin tocar los datos del usuario: `--remote-debugging-port=<puerto> --user-data-dir=<directorio temporal>` (y `--use-mock-keychain` si se quiere evitar el diálogo del Keychain).

## Firma y notarización (pendiente)

`electron-builder.yml` fija `identity: null`, `hardenedRuntime: true` y los entitlements de `build/entitlements.mac.plist`:

- `com.apple.security.cs.allow-jit`: V8 necesita memoria ejecutable. Comprobado con copias firmadas ad-hoc con Hardened Runtime: sin él la app muere con `SIGTRAP`; con él arranca. No hace falta `allow-unsigned-executable-memory`.
- `com.apple.security.network.client`: red saliente (PostgreSQL). Solo tiene efecto con App Sandbox; se deja preparado.

Sin identidad de firma, modificar el binario con los fuses invalida su firma ad-hoc, y en arm64 un binario con firma inválida no arranca; por eso `resetAdHocDarwinSignature: true` la rehace. El resultado es un `.app` con firma **ad-hoc** (`codesign -dv` → `Signature=adhoc`, `TeamIdentifier=not set`) que `codesign --verify --deep --strict` da por válida y que `spctl` rechaza.

**Abrir una app sin firmar en macOS (Gatekeeper):** el `.app` compilado y ejecutado en el propio Mac no está en cuarentena y abre normalmente. Un `.dmg` o `.zip` descargado de internet sí lo está: al abrirlo, macOS lo bloquea («no se puede abrir porque el desarrollador no puede ser verificado» / «está dañado»). Vías: clic derecho → Abrir (o Ajustes del Sistema → Privacidad y seguridad → «Abrir igualmente»), o `xattr -dr com.apple.quarantine /Applications/Strata.app`.

Para firmar y notarizar cuando existan las cuentas (los pasos también están comentados en `electron-builder.yml`):

1. Sustituir `identity: null` por el certificado «Developer ID Application» (o quitar la línea y exportar `CSC_LINK`/`CSC_KEY_PASSWORD` en CI).
2. Añadir `notarize: true` y las variables `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (o `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
3. Quitar `resetAdHocDarwinSignature`: electron-builder firma justo después de los fuses.
4. Poner `dmg.sign: true`.
5. Repetir la verificación del paquete: con Hardened Runtime y un Team ID real, los `.node` firmados por electron-builder con la misma identidad superan la validación de bibliotecas.

## Decisiones pendientes para el propietario

- **`appId`**: `dev.strata.app` es **provisional**. Cambiarlo tras distribuir reinicia los permisos de macOS y la entrada del Keychain de `safeStorage`; conviene fijarlo antes de la primera distribución.
- **Firma y notarización**: requieren cuenta de Apple Developer.
- **x64 / universal**: no se hace. Habría que añadir `x64` a los `arch` de `mac.target` (o `universal`), revisar el rebuild nativo (véase arriba), verificar `better-sqlite3` bajo Rosetta y CI con runners de ambas arquitecturas.

## Icono provisional

`apps/desktop/build/icon.icns` (y su fuente, `icon.svg`) es un icono **provisional**: una «S» geométrica con los colores de `@strata/design-tokens` (`slate.900` y `green.500`). Se regenera con `pnpm --filter @strata/desktop icon` (`build/make-icon.mjs`: SVG por código → `sips` → `iconutil`; solo macOS, sin dependencias). Sustituirlo cuando exista diseño de marca.

## Verificación del paquete

Cada empaquetado relevante debe abrirse de verdad, no solo compilar. Procedimiento seguido en el primer empaquetado (arranque con `--remote-debugging-port` y `--user-data-dir` temporal; PostgreSQL 17 en un contenedor efímero con `POSTGRES_HOST_AUTH_METHOD=trust`, sin contraseña para no invocar el Keychain):

1. Existen el `.dmg` y el `.zip`, y el `app.asar` de ambos coincide con el de `mac-arm64/`.
2. La CSP de producción está activa bajo `app://strata` (`eval`/`new Function` bloqueados, script inline no se ejecuta, `fetch` externo bloqueado; el evento `securitypolicyviolation` reporta la política exacta de `buildCsp()`).
3. El preload expone solo `window.db` (sin `require`, `process`, `ipcRenderer`).
4. PostgreSQL: crear perfil, probar, conectar, consultar, listar tablas, desconectar. SQLite: igual sobre un fixture temporal.
5. `lsof -p <pid>` muestra el `.node` cargado desde `app.asar.unpacked`.
6. Cierre limpio (`Browser.close` → código 0, sin procesos residuales).

Con los fuses aplicados no hay inspector de main. Para comprobar `app.isPackaged` y sustituir el diálogo nativo de `pickSqliteFile`, se usó una **copia** del `.app` con solo `EnableNodeCliInspectArguments` reactivado (`@electron/fuses`, mismo asar y mismos binarios): `app.isPackaged === true`, Electron 44.4.3, Node 24.21.0, ABI 149.

### Smoke automatizado

Buena parte de esta verificación (fuses, superficie de `window.db`, CSP como cabecera de `app://`, `file://` y rutas con `..` bloqueados, permisos, montaje del renderer) está automatizada en `apps/desktop/scripts/smoke-packaged.mjs`, que lanza el `.app` de `release/mac-arm64/` por CDP. Lo ejecuta `.github/workflows/package.yml`; detalles y cómo correrlo en local en la sección «CI» de [`DEVELOPMENT.md`](DEVELOPMENT.md). No sustituye a los puntos 4 a 6 (bases de datos reales, `.node` cargado desde `app.asar.unpacked`, cierre limpio), que siguen siendo manuales.
