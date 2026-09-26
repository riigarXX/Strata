# ADR 0011: El renderer se sirve por un protocolo propio (`app://`)

- **Estado:** Aceptado
- **Fecha:** 2026-09-20

## Contexto

El renderer se cargaba con `loadFile` (`file://`). Vite emite `<script type="module" crossorigin>`, que Chromium no admite bajo `file://` sin los privilegios extra de la fuse `GrantFileProtocolExtraPrivileges`, así que esa fuse tenía que estar activada (comprobado en el primer empaquetado, `docs/packaging.md`). Las consecuencias eran dos: las páginas `file://` conservaban privilegios que la app no necesita y, en una página `file://`, la palabra clave `'self'` de la CSP casa con cualquier `file:` (hallazgo 1 de `docs/security-audit.md`), lo que obligó a un filtro de peticiones que cancelaba los `file:` ajenos al directorio del renderer.

## Decisión

- **Esquema privilegiado `app://strata`.** `protocol.registerSchemesAsPrivileged` (antes de `app.whenReady()`) con solo `standard`, `secure` y `supportFetchAPI`:
  - `standard`: da origen propio (`app://strata`) y resolución de rutas relativas.
  - `secure`: contexto seguro, como `https://`.
  - `supportFetchAPI`: la CSP `connect-src 'self'` solo permite leer `app://strata/*`, el mismo contenido que ya cargan `<script>` y `<link>`; lo necesitan la comprobación de la cabecera CSP de la propia página (E2E y smoke) y cualquier `fetch` futuro al propio origen.
  - Sin `bypassCSP` (la CSP se aplica siempre), sin `corsEnabled` (todo es del mismo origen), sin `allowServiceWorkers`, `stream` ni `codeCache`.
- **`protocol.handle` sobre `session.defaultSession`** (`security/app-protocol.ts`) sirve únicamente el directorio compilado `out/renderer`:
  - Solo `GET` y `HEAD` (otro método responde 405).
  - Resolución de rutas segura: host fijo, sin credenciales ni puerto; se decodifica cada segmento y se rechazan los vacíos, los que empiezan por punto (`.`, `..`, archivos ocultos), los que contienen `/`, `\` o NUL (también codificados) y las codificaciones inválidas. Después se resuelve con `realpath` y se exige que el archivo real quede dentro del `realpath` de `out/renderer` (los symlinks que escapan devuelven 404) y que sea un archivo (sin listado de directorios).
  - Lista cerrada de tipos MIME (`html`, `js`, `mjs`, `css`, `json`, `svg`, `woff2`, `woff`, `png`, `ico`): lo que no esté en ella (p. ej. `.map`) responde 404 aunque exista.
  - Solo la ruta raíz `/` cae en `index.html`; cualquier otra ruta inexistente es 404, sin fallback de SPA.
  - Cada respuesta lleva la CSP como cabecera real (`buildCsp()`), `X-Content-Type-Options: nosniff` y `Cross-Origin-Resource-Policy: same-origin`, y ninguna cabecera `Access-Control-*`. Los errores no llevan cuerpo ni detalle de la ruta.
- **Origen y guards.** `createAppOrigin` acepta en producción solo `app://strata/` y `app://strata/index.html` (host exacto, sin credenciales ni puerto); en desarrollo sigue siendo únicamente el origen loopback del dev server. Navegación (`will-navigate`, `will-frame-navigate`, `will-redirect`), validación del remitente IPC y `history-events` comparan contra ese mismo `AppOrigin`, sin cambios de código.
- **Filtro de peticiones simplificado** (`security/request-filter.ts`): cancela **cualquier** petición `file:` y, del esquema propio, solo acepta el host `strata`. Se conserva como defensa en profundidad aunque ya no haya páginas `file://`.
- **Fuse `GrantFileProtocolExtraPrivileges` desactivada** en `electron-builder.yml`; el resto de fuses no cambia. El smoke del paquete lo comprueba leyendo el binario.
- **`electron-vite`**: no se toca `base`. electron-vite fuerza `./` en producción, que resuelve bien bajo `app://strata/` (el documento siempre está en la raíz), y en desarrollo manda el dev server, que no usa el protocolo (el handler solo se instala sin `ELECTRON_RENDERER_URL`), de modo que el HMR no cambia.

## Alternativas descartadas

- **Mantener `file://` con la fuse activada** (estado anterior): conserva privilegios extra para páginas que no los necesitan y depende de un filtro que compense el alcance de `'self'`.
- **Desactivar la fuse y quitar `crossorigin` del HTML** (plugin de Vite): la app dejaría de cargar por `file://` con un parche sobre la salida de Vite, frágil ante cada actualización, y las páginas seguirían siendo `file://` (origen opaco, `'self'` amplio).
- **`net.fetch(pathToFileURL(...))` dentro de `protocol.handle`:** reintroduce el esquema `file:` en la ruta de servicio y delega en Chromium la deducción de MIME y cabeceras. Se lee el archivo con `fs` tras validar la ruta, de modo que MIME y cabeceras son deterministas y comprobables sin Electron.
- **Servidor HTTP local (`http://127.0.0.1:<puerto>`)**: abre un puerto accesible a otros procesos y a otros orígenes del navegador del usuario, y añade gestión de puerto y ciclo de vida.
- **`bypassCSP`, `corsEnabled` o `stream`** en el esquema: no aportan nada a este caso y debilitan la política.

## Consecuencias

- El origen del renderer cambia de `file://` a `app://strata`: el almacenamiento web (`localStorage`, IndexedDB) es otro. La app no lo usa (las preferencias y el historial viven en main), así que no hay migración.
- `registerSchemesAsPrivileged` debe ejecutarse antes de `app.whenReady()`; cualquier registro posterior de esquemas propios debe hacerse en esa misma llamada (Electron solo la admite una vez).
- El servicio de archivos del renderer pasa a ser superficie de seguridad propia, cubierta por `security/app-protocol.spec.ts` (rutas con `..`, `%2e%2e`, `%2f`, symlinks, métodos, MIME, cabeceras) y por los E2E y el smoke.
- Si el renderer añade un tipo de recurso nuevo (p. ej. `.webp`), hay que añadirlo a la lista de MIME.
- Un renderer comprometido puede pedir cualquier archivo público de `out/renderer` con `fetch`, pero ya podía cargarlo con `<script>`/`<link>`; no obtiene nada de fuera del directorio.

## Referencias

- [ADR 0006](0006-electron-vite.md), [ADR 0008](0008-contrato-ipc.md).
- `docs/security-audit.md` (hallazgo 1 y política de navegación), `docs/threat-model.md`, `docs/packaging.md` (fuses).
