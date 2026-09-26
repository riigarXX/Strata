import { join } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, protocol, safeStorage, session } from 'electron'
import sqliteWorkerPath from '@strata/db-core/sqlite/worker?modulePath'
import { createAppServices } from './app-services'
import { publishAiProgress } from './ipc/ai-events'
import { publishHistoryChanges } from './ipc/history-events'
import { registerIpcHandlers } from './ipc/register-handlers'
import { installApplicationMenu } from './menu'
import { logger } from './logging/logger'
import { installProcessErrorLogging } from './logging/process-errors'
import { createAppOrigin, resolveDevServerUrl } from './security/app-origin'
import { installAppPolicy } from './security/app-policy'
import { installAppProtocol, registerAppScheme } from './security/app-protocol'
import { buildCsp } from './security/csp'
import { hardenSession } from './security/session-policy'
import { closeSessionsOnQuit } from './services/connection-manager'
import { bindNativeThemeSource } from './services/preferences-store'
import { createMainWindow } from './windows/main-window'

// El nombre decide la ruta de `userData` y la entrada del Keychain de `safeStorage`: debe fijarse antes de tocar cualquiera de los dos.
app.setName('Strata')

// En un build empaquetado se ignora la variable de entorno: el dev server solo existe en desarrollo.
const devServerUrl = resolveDevServerUrl({
  isPackaged: app.isPackaged,
  rendererUrl: process.env['ELECTRON_RENDERER_URL'],
})
const rendererRoot = join(__dirname, '../renderer')
const appOrigin = createAppOrigin({ devServerUrl })

// Antes de crear ningún `webContents` o sesión: la política global no debe dejar nada fuera.
installProcessErrorLogging(process, logger)
installAppPolicy(app, { appOrigin, devServerUrl })
// Debe ir antes de `app.whenReady()`: Electron no admite registrar esquemas privilegiados después.
registerAppScheme(protocol)

let mainWindow: BrowserWindow | null = null

function openMainWindow(): void {
  const window = createMainWindow({ devServerUrl })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  mainWindow = window
}

app.whenReady().then(async () => {
  hardenSession(session.defaultSession, { devServerUrl })
  // En desarrollo el renderer lo sirve el dev server; el esquema propio solo se atiende con el build compilado.
  if (!devServerUrl) {
    installAppProtocol(session.defaultSession.protocol, { rendererRoot, csp: buildCsp() })
  }
  installApplicationMenu({
    appName: app.name,
    isMac: process.platform === 'darwin',
    isDev: !app.isPackaged,
  })

  const {
    connectionManager,
    queryExecutor,
    preferencesStore,
    historyStore,
    aiService,
    sqliteFilePicker,
  } = createAppServices({
    userDataPath: app.getPath('userData'),
    safeStorage,
    sqliteWorkerPath,
    showOpenDialog: (options) =>
      mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options),
  })
  closeSessionsOnQuit(app, connectionManager)
  registerIpcHandlers({
    getMainWindow: () => mainWindow,
    appOrigin,
    connectionManager,
    sqliteFilePicker,
    queryExecutor,
    preferencesStore,
    historyStore,
    aiService,
  })
  // Solo la ventana principal recibe los cambios del historial (alta, borrado, vaciado y purga).
  publishHistoryChanges({ historyStore, getMainWindow: () => mainWindow, appOrigin })
  // Y solo ella el avance de las descargas de modelos; al salir se cancelan las que sigan en curso.
  publishAiProgress({ aiService, getMainWindow: () => mainWindow, appOrigin })
  app.on('will-quit', () => aiService.dispose())
  // Purga por retención al arrancar y cada día; no espera: una purga lenta o fallida no retrasa la ventana.
  void historyStore.start()
  app.on('will-quit', () => historyStore.stop())
  // Antes de crear la ventana: su fondo y `prefers-color-scheme` ya deben salir con el tema elegido.
  await bindNativeThemeSource(preferencesStore, nativeTheme)
  openMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
