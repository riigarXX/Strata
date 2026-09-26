import type { Page } from '@playwright/test'
import { expect, test } from './support/strata-app'
import {
  connectFixture,
  executionStatus,
  historyDialog,
  MOD,
  openMessages,
  runSql,
  submitSql,
  toolbarButton,
  transactionChip,
} from './support/ui'

// better-sqlite3 es síncrono: una sola sentencia pesada bloquearía main y no habría forma de cancelarla (ni de que llegue el clic).
// Por eso la consulta larga son muchas sentencias que calculan un rato cada una (~90 ms): main cede el turno al bucle de eventos entre
// sentencias, atiende la cancelación y la observa antes de la siguiente. Debe durar bastante más que el test para no terminar antes de cancelar.
const STATEMENT_COUNT = 80
const SLOW_SQL = Array.from(
  { length: STATEMENT_COUNT },
  () =>
    'with recursive c(x) as (select 1 union all select x+1 from c where x < 1000000) select count(*) from c;',
).join('\n')

// Cada paso dura bastante más que la gracia de 150 ms del adapter (que aquí no basta para confirmar la cancelación), pero termina mucho antes de la gracia de una sesión con transacción.
// Así el caso no depende de la velocidad de la máquina: en un CI lento los pasos solo duran más, sin llegar nunca al tope.
const TRANSACTION_SLOW_SQL = Array.from(
  { length: STATEMENT_COUNT },
  () =>
    'with recursive c(x) as (select 1 union all select x+1 from c where x < 3000000) select count(*) from c;',
).join('\n')

// Un único paso nativo que no termina en todo el test: no hay manera de interrumpirlo y hay que abandonar el hilo.
const UNINTERRUPTIBLE_SQL =
  'with recursive c(x) as (select 1 union all select x+1 from c where x < 2000000000) select count(*) from c'

// Margen sobre la gracia de cancelación con transacción abierta (5 s) antes de abandonar el hilo.
const ABANDON_TIMEOUT_MS = 25_000

/** Sentencias que llegaron a terminar según el resumen de la ejecución (pestaña «Mensajes»). */
async function statementsDone(page: Page): Promise<number> {
  const summary = page.locator('[data-part="run-summary"]')
  await expect(summary).toContainText('Sentencias ejecutadas:')
  const match = /Sentencias ejecutadas:\s*(\d+)/.exec((await summary.textContent()) ?? '')
  return Number(match?.[1])
}

test.describe('cancelación de consultas', () => {
  test('el botón Cancelar detiene la ejecución: estado «cancelada» y la conexión sigue usable', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await expect(toolbarButton(page, 'Cancelar')).toHaveAttribute('aria-disabled', 'true')
    await submitSql(page, 'Consulta 1', SLOW_SQL)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'running')
    await expect(executionStatus(page)).toContainText('Ejecutando')

    // Mientras corre solo se puede cancelar: todo lo demás explica por qué no.
    await expect(toolbarButton(page, 'Cancelar')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(toolbarButton(page, 'Ejecutar')).toHaveAttribute('aria-disabled', 'true')
    await expect(toolbarButton(page, 'Iniciar transacción')).toHaveAttribute(
      'aria-disabled',
      'true',
    )

    await toolbarButton(page, 'Cancelar').click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'cancelled')
    await expect(executionStatus(page)).toContainText('La última ejecución se canceló')
    await expect(toolbarButton(page, 'Cancelar')).toHaveAttribute('aria-disabled', 'true')
    await expect(toolbarButton(page, 'Ejecutar')).not.toHaveAttribute('aria-disabled', 'true')

    const log = await openMessages(page)
    await expect(log).toContainText(/Ejecución cancelada en la sentencia n\.º \d+\./)
    // Se detuvo de verdad: no llegaron a correr todas las sentencias.
    expect(await statementsDone(page)).toBeLessThan(STATEMENT_COUNT)

    await page.getByRole('tab', { name: 'Resultados', exact: true }).click()
    await runSql(page, 'Consulta 1', 'select 1 as uno')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(page.getByRole('grid', { name: 'Resultados de la consulta' })).toBeVisible()
    expect(app.errors).toEqual([])
  })

  test('Escape, el atajo de «Cancelar ejecución», también cancela', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await submitSql(page, 'Consulta 1', SLOW_SQL)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'running')
    await expect(toolbarButton(page, 'Cancelar')).toHaveAttribute('aria-keyshortcuts', 'Escape')

    await page.keyboard.press('Escape')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'cancelled')
    await openMessages(page)
    expect(await statementsDone(page)).toBeLessThan(STATEMENT_COUNT)
    expect(app.errors).toEqual([])
  })

  test('la paleta de comandos habilita «Cancelar ejecución» solo mientras hay una en curso', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    const palette = page.getByRole('dialog', { name: /^Paleta de comandos$/ })
    const option = palette.getByRole('option', { name: /^Cancelar ejecución/ })

    await page.keyboard.press(`${MOD}+K`)
    await palette.getByRole('combobox').fill('Cancelar ejecución')
    await expect(option).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    await submitSql(page, 'Consulta 1', SLOW_SQL)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'running')
    await page.keyboard.press(`${MOD}+K`)
    await palette.getByRole('combobox').fill('Cancelar ejecución')
    await expect(option).toBeVisible()
    await expect(option).not.toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'cancelled')
    expect(app.errors).toEqual([])
  })

  test('la ejecución cancelada queda en el historial con estado «Cancelada»', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await submitSql(page, 'Consulta 1', SLOW_SQL)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'running')
    await toolbarButton(page, 'Cancelar').click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'cancelled')

    await page.keyboard.press(`${MOD}+Shift+H`)
    const dialog = historyDialog(page)
    await expect(dialog).toBeVisible()
    const entries = dialog
      .getByRole('list', { name: 'Consultas del historial' })
      .getByRole('listitem')
    await expect(entries).toHaveCount(1)
    await expect(entries.first()).toContainText('Cancelada')
    await expect(entries.first()).toContainText('with recursive c(x)')
    await expect(entries.first().locator('[data-status="cancelled"]').first()).toBeVisible()
    expect(app.errors).toEqual([])
  })

  test('cancelar una consulta interrumpible dentro de una transacción no la cierra: sigue activa y se puede revertir', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')

    await submitSql(page, 'Consulta 1', TRANSACTION_SLOW_SQL)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'running')
    await toolbarButton(page, 'Cancelar').click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'cancelled')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    const log = await openMessages(page)
    await expect(log).not.toContainText('no se pudo interrumpir')

    await toolbarButton(page, 'Revertir').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(app.errors).toEqual([])
  })

  test('cancelar una sentencia de un solo paso ininterrumpible revierte la transacción y lo avisa', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')

    await submitSql(page, 'Consulta 1', UNINTERRUPTIBLE_SQL)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'running')
    await toolbarButton(page, 'Cancelar').click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'cancelled', {
      timeout: ABANDON_TIMEOUT_MS,
    })
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    const log = await openMessages(page)
    await expect(log).toContainText(
      'La sentencia no se pudo interrumpir: se ha revertido la transacción.',
    )

    await runSql(page, 'Consulta 1', 'select 1 as uno')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(app.errors).toEqual([])
  })

  test('sin ejecución en curso, «Cancelar» no hace nada y explica por qué', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    // El botón no disponible usa aria-disabled: sigue recibiendo el clic y lo responde en el indicador.
    await toolbarButton(page, 'Cancelar').click({ force: true })
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'blocked')
    await expect(executionStatus(page)).toHaveText(
      'No se puede cancelar: No hay ninguna ejecución en curso.',
    )
    expect(app.errors).toEqual([])
  })
})
