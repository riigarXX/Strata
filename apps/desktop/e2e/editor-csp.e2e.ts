import { expect, test } from './support/strata-app'
import { connectFixture, editorOf, executionStatus, MOD, runSql } from './support/ui'

// Hallazgo 10 de docs/security-audit.md: teclear (o un `fill`) sobre texto resaltado hacía que Chromium
// intentara aplicar un `style=""` en línea con el estilo del token, y la CSP lo rechazaba con un
// `console.error`. El editor resuelve ese reemplazo él mismo (`typeOverSelection`); este test fija que
// la política sigue estricta y que reescribir el editor no genera violaciones.
test('reescribir el editor tras ejecutar no provoca violaciones de la CSP', async ({
  launchApp,
  fixtureDb,
}) => {
  const app = await launchApp()
  const { page } = app
  await connectFixture(app, fixtureDb)

  await page.evaluate(() => {
    const seen: string[] = []
    Object.assign(window, { __cspViolations: seen })
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`)
    })
  })

  await runSql(page, 'Consulta 1', 'select id, name from people order by id')
  await runSql(page, 'Consulta 1', 'select title from projects')
  await editorOf(page, 'Consulta 1').fill('select 1 -- sin ejecutar')
  await expect(editorOf(page, 'Consulta 1')).toContainText('select 1 -- sin ejecutar')
  await runSql(page, 'Consulta 1', 'select count(*) from people')

  // Seleccionar todo y teclear encima, como haría un usuario, tampoco debe generar violaciones.
  await editorOf(page, 'Consulta 1').click()
  await page.keyboard.press(`${MOD}+A`)
  await page.keyboard.type('select 2')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')

  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations),
    )
    .toEqual([])
  expect(app.errors).toEqual([])
})

test('la CSP de producción no admite estilos en línea', async ({ launchApp }) => {
  const app = await launchApp()
  const policy = await app.page.evaluate(async () => {
    const response = await fetch(window.location.href)
    return response.headers.get('content-security-policy')
  })
  expect(policy).toContain("style-src 'self'")
  expect(policy).not.toContain('unsafe-inline')
})
