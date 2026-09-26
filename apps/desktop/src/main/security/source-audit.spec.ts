// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '../..')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|vue)$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [path] : []
  })
}

// Los comentarios pueden nombrar `ipcRenderer` o `console` para explicar por qué no se usan.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

function filesMatching(directory: string, pattern: RegExp): string[] {
  return sourceFiles(join(SRC, directory))
    .filter((file) => pattern.test(withoutComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(SRC, file))
}

// Auditoría estática de la superficie: cada una de estas reglas es un invariante de seguridad y solo tiene
// las excepciones listadas aquí. Añadir una excepción exige justificarla en `docs/security-audit.md`.
describe('auditoría estática del código fuente', () => {
  it('main y preload no escriben en consola: todo pasa por el logger con redacción', () => {
    const offenders = [
      ...filesMatching('main', /\bconsole\b/),
      ...filesMatching('preload', /\bconsole\b/),
    ]
    expect(offenders.sort()).toEqual(['main/logging/logger.ts'])
  })

  it('el renderer no escribe en consola', () => {
    expect(filesMatching('renderer', /\bconsole\b/)).toEqual([])
  })

  it('ningún código abre URL externas con el sistema (shell.openExternal, openPath…)', () => {
    expect(filesMatching('main', /\bshell\s*\./)).toEqual([])
    expect(filesMatching('main', /\bopenExternal\b/)).toEqual([])
  })

  it('solo el cliente HTTP del asistente de IA abre conexiones de red desde main, y el asistente no escribe en el registro', () => {
    const networking =
      /from\s+['"]node:(?:http|https|http2|net|tls|dgram)['"]|\bnet\s*\.\s*(?:fetch|request)\b|\bfetch\s*\(|\btypeof\s+fetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/
    // `testing.ts` es el servidor HTTP falso de los tests: ningún código de producción lo importa.
    expect(filesMatching('main', networking).sort()).toEqual([
      'main/services/ai-service/ai-service.ts',
      'main/services/ai-service/http.ts',
      'main/services/ai-service/testing.ts',
    ])
    expect(filesMatching('main', /from\s+['"][^'"]*ai-service\/testing['"]/)).toEqual([])
    expect(filesMatching('main/services/ai-service', /logging\/logger|\blogger\b/)).toEqual([])
    expect(filesMatching('preload', networking)).toEqual([])
  })

  it('los handlers IPC solo se registran con `ipcMain.handle` en register-handlers', () => {
    expect(filesMatching('main', /\bipcMain\b/)).toEqual(['main/ipc/register-handlers.ts'])
    expect(filesMatching('main', /\bipcMain\s*\.\s*(on|once|addListener|handleOnce)\b/)).toEqual([])
  })

  it('`ipcRenderer` solo aparece en el preload, y solo en su entrada', () => {
    expect(filesMatching('preload', /\bipcRenderer\b/)).toEqual(['preload/index.ts'])
    expect(filesMatching('main', /\bipcRenderer\b/)).toEqual([])
    expect(filesMatching('renderer', /\bipcRenderer\b/)).toEqual([])
  })

  it('el renderer no importa electron, módulos de Node ni los drivers', () => {
    expect(
      filesMatching(
        'renderer',
        /from\s+['"](electron|node:[^'"]+|pg|pg-cursor|better-sqlite3)['"]/,
      ),
    ).toEqual([])
    expect(filesMatching('renderer', /\brequire\s*\(/)).toEqual([])
  })

  it('el renderer no abre ventanas, iframes ni webviews', () => {
    expect(
      filesMatching('renderer', /\bwindow\.open\s*\(|<iframe\b|<webview\b|<embed\b|<object\b/),
    ).toEqual([])
  })

  it('nada evalúa código dinámico ni desactiva la seguridad web', () => {
    for (const directory of ['main', 'preload', 'renderer']) {
      expect(filesMatching(directory, /\beval\s*\(|\bnew\s+Function\s*\(/)).toEqual([])
    }
    expect(
      filesMatching(
        'main',
        /webSecurity\s*:\s*false|nodeIntegration\s*:\s*true|sandbox\s*:\s*false|contextIsolation\s*:\s*false|allowRunningInsecureContent\s*:\s*true|webviewTag\s*:\s*true|enableRemoteModule/,
      ),
    ).toEqual([])
  })

  it('el renderer no se carga por file:// y el esquema propio no relaja la CSP ni abre CORS', () => {
    expect(filesMatching('main', /\bloadFile\b/)).toEqual([])
    expect(filesMatching('main', /\bbypassCSP\b|\bcorsEnabled\b|\ballowServiceWorkers\b/)).toEqual(
      [],
    )
  })

  it('el preload expone una sola clave con contextBridge y nunca `ipcRenderer`', () => {
    const source = readFileSync(join(SRC, 'preload/index.ts'), 'utf8')
    expect(source.match(/exposeInMainWorld\(/g)).toHaveLength(1)
    expect(source).toMatch(/exposeInMainWorld\(\s*'db'/)
    expect(source).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/s)
  })
})
