# Resultado del spike: driver SQLite en Electron empaquetado (macOS arm64)

- **Fecha:** 2026-09-16
- **Ámbito:** validar si `better-sqlite3` (binario nativo) funciona dentro de una app Electron empaquetada con `electron-builder` en macOS, para cerrar el [ADR 0007](../../docs/adr/0007-drivers-postgresql-sqlite.md).
- **Ubicación del spike:** `spikes/sqlite-driver/` (proyecto Electron mínimo y aislado, desechable, fuera de la estructura `apps/`/`packages/` del monorepo final).

## Entorno de prueba

- macOS, arquitectura `arm64` (Apple Silicon).
- Node.js del sistema: v22.21.0 (usado solo para `npm install`/rebuild; no relevante en runtime — Electron embebe su propio Node).
- Electron: `32.3.3`.
- `better-sqlite3`: `11.10.0`.
- `electron-builder`: `25.1.8`.
- `@electron/rebuild`: usado vía `postinstall` (`electron-rebuild -f -w better-sqlite3`).

## Driver probado y resultado

**`better-sqlite3` — funciona correctamente, tanto en modo dev (`electron .`) como en el `.app` empaquetado con `electron-builder`.** No hizo falta probar `sql.js` como alternativa: no hubo ningún problema irresoluble.

Flujo ejecutado en el proceso main (`spikes/sqlite-driver/main.js`): abre/crea un archivo `.sqlite` en `app.getPath('userData')`, `CREATE TABLE`, dos `INSERT`, un `SELECT`, y una consulta `select sqlite_version()`.

### Ejecución en modo dev (`npx electron .`)

```json
{
  "ok": true,
  "dbPath": ".../Library/Application Support/sqlite-driver-spike/spike.sqlite",
  "sqliteVersion": "3.49.2",
  "rows": [{ "id": 1, "name": "foo" }, { "id": 2, "name": "bar" }],
  "electronVersion": "32.3.3",
  "nodeVersion": "20.18.1",
  "isPackaged": false,
  "arch": "arm64"
}
```

### Ejecución del `.app` empaquetado (`dist/mac-arm64/SqliteSpike.app/Contents/MacOS/SqliteSpike`, binario ejecutado directamente, no `electron .`)

```json
{
  "ok": true,
  "dbPath": ".../Library/Application Support/sqlite-driver-spike/spike.sqlite",
  "sqliteVersion": "3.49.2",
  "rows": [{ "id": 1, "name": "foo" }, { "id": 2, "name": "bar" }],
  "electronVersion": "32.3.3",
  "nodeVersion": "20.18.1",
  "isPackaged": true,
  "arch": "arm64"
}
```

Resultado idéntico en ambos modos. `isPackaged: true` confirma que la ejecución fue sobre el paquete real, no sobre el árbol de desarrollo.

## Versión de SQLite embebida

**`3.49.2`**, confirmada mediante `select sqlite_version()` — cumple el mínimo **3.35+** exigido por el [ADR 0003](../../docs/adr/0003-versiones-minimas-bbdd.md) con margen amplio (incluye `RETURNING`, requerido para introspección y futura edición de filas).

## Configuración exacta que hizo falta

### Rebuild nativo

`package.json` del spike:

```json
{
  "devDependencies": {
    "electron": "^32.0.0",
    "electron-builder": "^25.0.0",
    "@electron/rebuild": "^3.6.0"
  },
  "scripts": {
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  }
}
```

- `postinstall` reconstruye el binario `.node` de `better-sqlite3` contra los headers de Electron (no los de Node del sistema) cada vez que se instala/reinstala.
- `electron-builder` **también** ejecuta su propio paso de rebuild de dependencias nativas al empaquetar (`@electron/rebuild already used by electron-builder`), así que el `postinstall` es redundante con `electron-builder install-app-deps` pero no da error por duplicidad; en el adapter definitivo basta con uno de los dos mecanismos.
- El binario resultante se verificó nativo arm64: `Mach-O 64-bit bundle arm64`.

### `asarUnpack`

```json
{
  "build": {
    "asarUnpack": [
      "**/node_modules/better-sqlite3/**"
    ]
  }
}
```

Sin este `asarUnpack`, el `.node` quedaría dentro de `app.asar` y Node no puede hacer `dlopen` de un binario nativo empaquetado dentro de un archivo asar (limitación conocida de Electron). Con la config anterior, `electron-builder` colocó el binario en:

```
SqliteSpike.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

fuera del asar, y `require('better-sqlite3')` lo resolvió correctamente en runtime empaquetado sin ninguna configuración adicional (Electron reescribe automáticamente las rutas hacia `app.asar.unpacked` para módulos nativos).

### `electron-builder` (mínimo usado)

```json
{
  "build": {
    "appId": "com.strata.spike.sqlite",
    "productName": "SqliteSpike",
    "directories": { "output": "dist" },
    "files": ["main.js", "preload.js", "index.html", "package.json"],
    "asarUnpack": ["**/node_modules/better-sqlite3/**"],
    "mac": {
      "target": [{ "target": "dir", "arch": ["arm64"] }],
      "identity": null
    }
  }
}
```

- Se usó target `dir` (genera el `.app` directamente en `dist/mac-arm64/` sin crear DMG) para simplificar el spike; `identity: null` desactiva la firma de código, válida para este spike desechable (fuera de alcance: firma/notarización se decide en Fase 6 del plan).
- No hicieron falta cambios de configuración más allá de lo anterior: no fue necesario tocar `extraResources`, `afterPack`, ni hooks custom.

## Caveats observados

- La firma de código y notarización de Apple no se probaron (fuera del alcance de este spike, corresponde a Fase 6). Un `.app` sin firmar ejecutado vía doble clic tras descarga de internet activaría Gatekeeper; ejecutado localmente (como aquí, vía terminal, sin atributo de cuarentena) no hay bloqueo.
- Solo se probó arquitectura `arm64` (target principal según ADR 0002). No se validó `x64`/Rosetta ni build universal; si en el futuro se decide soportar Intel, habrá que repetir el rebuild/empaquetado para esa arquitectura (candidato natural: `electron-builder --mac --x64` con su propio paso de `@electron/rebuild`).
- El `postinstall` de `electron-rebuild` y el rebuild interno de `electron-builder` son redundantes; en el adapter definitivo de `db-core` conviene decidir uno solo (probablemente dejar que `electron-builder` gestione el rebuild vía `electron-builder install-app-deps` en CI, y usar `electron-rebuild` manual solo en desarrollo local tras cambiar de versión de Electron).
- No se probó el flujo con la app corriendo bajo `sandbox: true` del `BrowserWindow` de forma exhaustiva más allá del smoke test — la lectura/escritura SQLite ocurre en el proceso **main**, no en el renderer sandboxed, que es justamente el diseño que exige el plan (`db-core`/drivers viven en main). Esto no es un caveat del driver sino confirmación de que la arquitectura prevista es compatible.

## Recomendación para el ADR 0007

**Fijar `better-sqlite3` como driver de SQLite para el adapter definitivo de `db-core`.**

Razones:

- Funciona sin problemas dentro del `.app` empaquetado en macOS arm64, con una configuración de `asarUnpack` simple y bien documentada (una sola entrada de glob).
- SQLite embebida (3.49.2) supera ampliamente el mínimo del ADR 0003 (3.35+).
- API síncrona, que simplifica el adapter (`db-core`) frente a la API basada en callbacks/promesas de otros drivers, y es coherente con el patrón "todo el trabajo de I/O de BBDD vive en el proceso main" del plan.
- No se necesitó evaluar `sql.js` como alternativa de respaldo: no hubo ningún fallo irresoluble que lo justificara. `sql.js` queda descartado por ahora (peor rendimiento, sin `RETURNING`/streaming nativo) salvo que aparezca un problema no cubierto por este spike (p. ej. al soportar Windows/Linux más adelante, fuera del alcance actual).
- `node:sqlite` no se probó en profundidad porque, aunque el Node del sistema usado para `npm install` es v22.21.0, lo relevante es el Node que **embebe Electron en runtime**: Electron 32 embebe Node **20.18.1** (confirmado por `process.versions.node` en los logs de arriba), y `node:sqlite` se introdujo en Node 22.5 como módulo experimental — por tanto no está disponible en absoluto en el proceso main de esta versión de Electron. Adoptar `node:sqlite` obligaría a esperar a una versión de Electron que embeba Node 22.5+ y aun así seguiría siendo experimental. `better-sqlite3` evita esa dependencia de la versión interna de Electron.
