// Se ejecuta con el Node de Electron (ELECTRON_RUN_AS_NODE=1), igual que create-fixture-db.mjs: lee el archivo por una conexión
// independiente de la de la app, que es la forma de comprobar qué ha llegado realmente al disco (o qué ve otra sesión).
import Database from 'better-sqlite3'

const [target, sql] = process.argv.slice(2)
if (!target || !sql) throw new Error('Uso: query-fixture-db.mjs <ruta-del-archivo> <sql>')

const db = new Database(target, { readonly: true })
try {
  process.stdout.write(JSON.stringify(db.prepare(sql).all()))
} finally {
  db.close()
}
