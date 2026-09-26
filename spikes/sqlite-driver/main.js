const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function runSqliteFlow() {
  // require dentro de la función: si better-sqlite3 falla al cargar el .node
  // (rebuild/ASAR roto), queremos capturar el error en vez de tumbar el proceso main.
  const Database = require('better-sqlite3');

  const dbPath = path.join(app.getPath('userData'), 'spike.sqlite');
  // Empezamos desde limpio en cada arranque para que el spike sea repetible.
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);

  const db = new Database(dbPath);

  const sqliteVersionRow = db.prepare('select sqlite_version() as version').get();

  db.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);

  const insert = db.prepare('INSERT INTO items (name) VALUES (?)');
  insert.run('foo');
  insert.run('bar');

  const rows = db.prepare('SELECT id, name FROM items ORDER BY id').all();

  db.close();

  return {
    ok: true,
    dbPath,
    sqliteVersion: sqliteVersionRow.version,
    rows,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    isPackaged: app.isPackaged,
    arch: os.arch(),
  };
}

ipcMain.handle('sqlite:run', () => {
  try {
    const result = runSqliteFlow();
    console.log('[sqlite-spike] result:', JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    const result = { ok: false, error: err && err.stack ? err.stack : String(err) };
    console.error('[sqlite-spike] error:', result.error);
    return result;
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 700,
    height: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Para poder validar el spike sin interacción manual (dev y paquete .app vía CLI).
  if (process.env.SPIKE_HEADLESS) {
    setTimeout(() => app.quit(), 3000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
