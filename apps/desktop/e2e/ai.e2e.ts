import type { Page } from '@playwright/test'
import { FakeOllama, expect, test } from './support/fake-ollama'
import { stubOpenDialog, type StrataApp } from './support/strata-app'

// El asistente de IA sin interfaz: se ejercita `window.db.ai` contra la app real (main, IPC, preload, adapter SQLite)
// y un Ollama falso en el bucle local. Ningún test depende de un modelo.

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string } }

const call = <T = Result>(page: Page, expression: string): Promise<T> =>
  page.evaluate(`(async () => ${expression})()`) as Promise<T>

async function connectFixture(app: StrataApp, file: string, readOnly: boolean): Promise<string> {
  await stubOpenDialog(app, file)
  const picked = await call<{ ok: true; data: { filePath: string } }>(
    app.page,
    'window.db.connections.pickSqliteFile()',
  )
  const created = await call<{ ok: true; data: { id: string } }>(
    app.page,
    `window.db.connections.create({ engine: 'sqlite', name: 'Fixture', readOnly: ${readOnly}, filePath: ${JSON.stringify(picked.data.filePath)} })`,
  )
  const session = await call<{ ok: true; data: { sessionId: string } }>(
    app.page,
    `window.db.connections.connect({ profileId: ${JSON.stringify(created.data.id)} })`,
  )
  return session.data.sessionId
}

const enable = (app: StrataApp, ollama: FakeOllama): Promise<Result> =>
  call(
    app.page,
    `window.db.preferences.update({ ai: { enabled: true, baseUrl: ${JSON.stringify(ollama.url)} } })`,
  )

test('desactivado de fábrica: generar y descargar responden permission_denied sin tocar la red', async ({
  launchApp,
  fixtureDb,
  ollama,
}) => {
  const app = await launchApp()
  const sessionId = await connectFixture(app, fixtureDb, false)

  const generated = await call(
    app.page,
    `window.db.ai.generateSql({ requestId: 'r1', sessionId: ${JSON.stringify(sessionId)}, question: 'How many people?' })`,
  )
  const pulled = await call(
    app.page,
    `window.db.ai.pullModel({ requestId: 'r2', model: 'qwen3:14b' })`,
  )

  expect(generated).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(pulled).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(ollama.requests).toEqual([])
  expect(app.errors).toEqual([])
})

test('genera SQL de lectura con el esquema real y sin un solo valor de las filas', async ({
  launchApp,
  fixtureDb,
  ollama,
}) => {
  const app = await launchApp()
  const sessionId = await connectFixture(app, fixtureDb, false)
  await enable(app, ollama)
  ollama.answer = 'SELECT count(*) FROM people'

  const status = await call<{
    ok: true
    data: { providers: { baseUrl: string; reachable: boolean; version: string | null }[] }
  }>(app.page, 'window.db.ai.status()')
  const models = await call(app.page, 'window.db.ai.listModels({})')
  const generated = await call(
    app.page,
    `window.db.ai.generateSql({ requestId: 'r1', sessionId: ${JSON.stringify(sessionId)}, question: 'How many people are there?' })`,
  )

  expect(status.data.providers.find((p) => p.baseUrl === ollama.url)).toEqual({
    provider: 'ollama',
    baseUrl: ollama.url,
    reachable: true,
    version: '9.9.9',
  })
  expect(models).toEqual({
    ok: true,
    data: [{ name: 'qwen3:14b', sizeBytes: 123, embedding: false }],
  })
  expect(generated).toEqual({
    ok: true,
    data: {
      requestId: 'r1',
      sql: 'SELECT count(*) FROM people',
      risk: 'read',
      statementType: 'query',
      warnings: [],
    },
  })

  const chat = ollama.requestsTo('/api/chat')[0]
  expect(chat?.body).toContain('TABLE people(')
  expect(chat?.body).toContain('TABLE projects(')
  expect(chat?.body).toContain('FK->people.id')
  // La fixture guarda estas filas: ninguna puede haber salido de la app.
  for (const value of ['Ada', 'Grace', 'Linus', 'kernel', 'Analytical Engine']) {
    expect(chat?.body).not.toContain(value)
  }
  expect(app.errors).toEqual([])
})

test('clasifica lo que no es lectura y en un perfil de solo lectura lo marca como bloqueado', async ({
  launchApp,
  fixtureDb,
  ollama,
}) => {
  const app = await launchApp()
  const sessionId = await connectFixture(app, fixtureDb, true)
  await enable(app, ollama)
  const generate = (requestId: string) =>
    call<{ ok: true; data: Record<string, unknown> }>(
      app.page,
      `window.db.ai.generateSql({ requestId: ${JSON.stringify(requestId)}, sessionId: ${JSON.stringify(sessionId)}, question: 'Remove people' })`,
    )

  ollama.answer = '```sql\nDELETE FROM people\n```'
  const destructive = await generate('r1')
  ollama.answer = "<think>quizá</think>UPDATE people SET name = 'x' WHERE id = 1"
  const write = await generate('r2')
  ollama.answer = 'SELECT 1; DROP TABLE people'
  const multiple = await generate('r3')

  expect(destructive.data).toMatchObject({
    sql: 'DELETE FROM people',
    risk: 'destructive',
    blocked: true,
  })
  expect(destructive.data['warnings']).toEqual(['formatting_removed', 'read_only_blocked'])
  expect(write.data).toMatchObject({ risk: 'write', blocked: true })
  expect(write.data['warnings']).toEqual(['reasoning_removed', 'read_only_blocked'])
  expect(multiple).toMatchObject({ ok: false, error: { code: 'validation_failed' } })
  expect(app.errors).toEqual([])
})

test('una dirección que no es de bucle local se rechaza en IPC y en preferencias, sin tocar la red', async ({
  launchApp,
  ollama,
}) => {
  const app = await launchApp()
  await enable(app, ollama)
  ollama.clearRequests()

  for (const baseUrl of [
    'http://evil.example.com:11434',
    'http://127.0.0.1@evil.example.com:11434',
    'http://localhost.evil.com:11434',
    'http://0.0.0.0:11434',
    'http://[::ffff:127.0.0.1]:11434',
    'http://127.0.0.1',
  ]) {
    const listed = await call(
      app.page,
      `window.db.ai.listModels({ baseUrl: ${JSON.stringify(baseUrl)} })`,
    )
    const saved = await call(
      app.page,
      `window.db.preferences.update({ ai: { baseUrl: ${JSON.stringify(baseUrl)} } })`,
    )
    expect(listed, baseUrl).toMatchObject({ ok: false, error: { code: 'validation_failed' } })
    expect(saved, baseUrl).toMatchObject({ ok: false, error: { code: 'validation_failed' } })
  }
  expect(ollama.requests).toEqual([])
  expect(app.errors).toEqual([])
})

test('descarga un modelo con avance por onPullProgress y cancel es idempotente', async ({
  launchApp,
  ollama,
}) => {
  const app = await launchApp()
  await enable(app, ollama)
  await app.page.evaluate(`(() => {
    window.__progress = []
    window.__off = window.db.ai.onPullProgress((p) => window.__progress.push(p))
  })()`)

  const pulled = await call(
    app.page,
    `window.db.ai.pullModel({ requestId: 'pull1', model: 'qwen3:14b' })`,
  )
  const progress = await app.page.evaluate('window.__progress')
  await app.page.evaluate('window.__off()')
  const cancelled = await call(app.page, `window.db.ai.cancel({ requestId: 'pull1' })`)

  expect(pulled).toEqual({ ok: true, data: { requestId: 'pull1', model: 'qwen3:14b' } })
  expect((progress as { status: string }[]).map((p) => p.status)).toEqual([
    'pulling manifest',
    'pulling abc',
    'success',
  ])
  expect(progress).toContainEqual({
    requestId: 'pull1',
    model: 'qwen3:14b',
    status: 'pulling abc',
    completed: 10,
    total: 10,
  })
  expect(cancelled).toEqual({ ok: true, data: { requestId: 'pull1', outcome: 'not_running' } })
  expect(app.errors).toEqual([])
})
