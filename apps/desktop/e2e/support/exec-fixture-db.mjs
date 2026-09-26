// Se ejecuta con el Node de Electron (ELECTRON_RUN_AS_NODE=1), igual que create-fixture-db.mjs: ejecuta SQL de preparación
// (varias sentencias) sobre la base fixture antes de arrancar la app, para los tests que necesitan datos propios.
import Database from 'better-sqlite3'

const [target, sql] = process.argv.slice(2)
if (!target || !sql) throw new Error('Uso: exec-fixture-db.mjs <ruta-del-archivo> <sql>')

const db = new Database(target)
try {
  db.exec(sql)
} finally {
  db.close()
}
