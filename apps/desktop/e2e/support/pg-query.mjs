// Consulta un PostgreSQL desde el proceso de Playwright (pg es JavaScript puro: no necesita el Node de Electron).
// Uso: pg-query.mjs <url> <sql>. Espera hasta 60 s a que el servidor acepte conexiones TCP y escribe las filas como JSON.
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'

const [url, sql] = process.argv.slice(2)
if (!url || !sql) throw new Error('Uso: pg-query.mjs <url> <sql>')

const deadline = Date.now() + 60_000
for (;;) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 })
  client.on('error', () => undefined)
  try {
    await client.connect()
    try {
      const result = await client.query(sql)
      const rows = Array.isArray(result) ? (result.at(-1)?.rows ?? []) : result.rows
      process.stdout.write(JSON.stringify(rows))
    } finally {
      await client.end()
    }
    break
  } catch (error) {
    await client.end().catch(() => undefined)
    // Solo se reintenta mientras el servidor arranca; un error de SQL (que llega ya conectado) no se repite.
    if (
      error?.code !== undefined &&
      !['ECONNREFUSED', 'ECONNRESET', '57P03'].includes(error.code)
    ) {
      throw error
    }
    if (Date.now() > deadline) throw error
    await sleep(500)
  }
}
