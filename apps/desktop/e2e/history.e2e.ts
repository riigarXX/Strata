import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, readUserDataFile, test, type StrataApp } from './support/strata-app'
import {
  connectFixture,
  editorOf,
  executionStatus,
  expectTargetSize,
  historyDialog,
  MOD,
  palette,
  resizeWindow,
  runSql,
  settingsDialog,
} from './support/ui'

const PEOPLE_SQL = 'select id, name from people order by id'
const PROJECTS_SQL = 'select title from projects'

async function openHistory(app: StrataApp) {
  await app.page.keyboard.press(`${MOD}+Shift+H`)
  const dialog = historyDialog(app.page)
  await expect(dialog).toBeVisible()
  return dialog
}

async function closeHistory(app: StrataApp, dialog = historyDialog(app.page)): Promise<void> {
  await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await expect(dialog).toBeHidden()
}

// El botón de borrar de cada fila también contiene el SQL en su nombre: el de abrir es el que empieza por él.
const entryButton = (entry: Locator, sql: string) =>
  entry.getByRole('button', { name: new RegExp(`^${sql}`) })

const entriesOf = (dialog: ReturnType<typeof historyDialog>) =>
  dialog.getByRole('list', { name: 'Consultas del historial' }).getByRole('listitem')

// Sesenta sentencias que calculan un rato cada una (~1,3 s en total): main cede el turno al bucle de eventos entre sentencias, así que atiende
// el listado del historial mientras la ejecución sigue en curso.
const SLOW_SQL = Array.from(
  { length: 60 },
  () =>
    'with recursive c(x) as (select 1 union all select x+1 from c where x < 250000) select count(*) from c;',
).join('\n')

const pad = (value: number) => String(value).padStart(2, '0')

/** Día local «AAAA-MM-DD» a `offset` días de `base` (lo que devuelve un `<input type="date">`). */
function localDay(base: Date, offset: number): string {
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** Mediodía local de ese día en ISO UTC: cae siempre dentro del día local, sea cual sea la zona horaria. */
function atLocalNoon(base: Date, offset: number): string {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12).toISOString()
}

/** Historial sembrado antes de arrancar: la app lo lee de `history.json` como si lo hubiera guardado ella. */
async function seedHistory(
  userDataDir: string,
  entries: { id: string; sql: string; at: string }[],
): Promise<void> {
  await writeFile(
    path.join(userDataDir, 'history.json'),
    JSON.stringify({
      version: 1,
      entries: entries.map(({ id, sql, at }) => ({
        id,
        sql,
        engine: 'sqlite',
        profileId: 'seeded-profile',
        profileName: 'Sembrada',
        executedAt: at,
        durationMs: 3,
        status: 'ok',
      })),
    }),
    { mode: 0o600 },
  )
}

test.describe('historial de consultas', () => {
  test('la consulta ejecutada aparece con sus metadatos, con Mod+Shift+H y con \\history', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    await runSql(page, 'Consulta 1', PEOPLE_SQL)

    const dialog = await openHistory(app)
    const entries = entriesOf(dialog)
    await expect(entries).toHaveCount(1)
    await expect(entries.first()).toContainText(PEOPLE_SQL)
    await expect(entries.first()).toContainText('Correcta')
    await expect(entries.first()).toContainText('SQLite')
    await expect(entries.first()).toContainText('Fixture')
    await expect(entries.first()).toContainText('3 filas')

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await page.keyboard.press(`${MOD}+K`)
    await palette(page).getByRole('combobox').fill('\\history')
    await page.keyboard.press('Enter')
    await expect(historyDialog(page)).toBeVisible()
    await expect(entriesOf(historyDialog(page))).toHaveCount(1)

    expect(app.errors).toEqual([])
  })

  test('busca en las consultas y muestra el vacío cuando nada coincide', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    await runSql(page, 'Consulta 1', PEOPLE_SQL)
    await runSql(page, 'Consulta 1', PROJECTS_SQL)

    const dialog = await openHistory(app)
    await expect(entriesOf(dialog)).toHaveCount(2)

    const search = dialog.getByRole('searchbox', { name: 'Buscar en las consultas' })
    await search.fill('PROJECTS')
    await expect(entriesOf(dialog)).toHaveCount(1)
    await expect(entriesOf(dialog).first()).toContainText(PROJECTS_SQL)

    await search.fill('no-existe-en-ninguna-consulta')
    await expect(dialog.getByText('Ninguna consulta coincide con la búsqueda')).toBeVisible()

    await dialog.getByRole('button', { name: 'Quitar filtros' }).click()
    await expect(entriesOf(dialog)).toHaveCount(2)
    expect(app.errors).toEqual([])
  })

  test('reabre una consulta en una pestaña nueva sin ejecutarla', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    await runSql(page, 'Consulta 1', PEOPLE_SQL)

    const dialog = await openHistory(app)
    await entryButton(entriesOf(dialog).first(), PEOPLE_SQL).click()
    await expect(dialog).toBeHidden()

    await expect(page.getByRole('tab', { name: 'Consulta 2', selected: true })).toBeVisible()
    await expect(editorOf(page, 'Consulta 2')).toContainText(PEOPLE_SQL)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')
    await expect(page.getByRole('grid', { name: 'Resultados de la consulta' })).toBeHidden()
    expect(app.errors).toEqual([])
  })

  test('borra una entrada y vacía el historial con confirmación', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    await runSql(page, 'Consulta 1', PEOPLE_SQL)
    await runSql(page, 'Consulta 1', PROJECTS_SQL)

    const dialog = await openHistory(app)
    await expect(entriesOf(dialog)).toHaveCount(2)

    await dialog.getByRole('button', { name: `Borrar del historial: ${PEOPLE_SQL}` }).click()
    await expect(entriesOf(dialog)).toHaveCount(1)
    await expect(entriesOf(dialog).first()).toContainText(PROJECTS_SQL)

    await dialog.getByRole('button', { name: 'Vaciar historial…' }).click()
    const confirm = page.getByRole('dialog', { name: 'Vaciar historial' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Cancelar' }).click()
    await expect(confirm).toBeHidden()
    await expect(entriesOf(dialog)).toHaveCount(1)

    await dialog.getByRole('button', { name: 'Vaciar historial…' }).click()
    await confirm.getByRole('button', { name: 'Vaciar historial' }).click()
    await expect(confirm).toBeHidden()
    await expect(dialog.getByText('Todavía no hay consultas en el historial')).toBeVisible()
    await expect(dialog.getByRole('list', { name: 'Consultas del historial' })).toBeHidden()
    expect(app.errors).toEqual([])
  })

  test('persiste tras reiniciar con el mismo userData y no guarda resultados', async ({
    launchApp,
    fixtureDb,
    userDataDir,
  }) => {
    const first = await launchApp()
    await connectFixture(first, fixtureDb)
    await runSql(first.page, 'Consulta 1', PEOPLE_SQL)
    await expect(first.page.getByRole('grid', { name: 'Resultados de la consulta' })).toContainText(
      'Grace',
    )
    expect(first.errors).toEqual([])
    await first.close()

    const historyFile = await readFile(path.join(userDataDir, 'history.json'), 'utf8')
    expect(historyFile).toContain(PEOPLE_SQL)
    for (const cellValue of ['Ada', 'Grace', 'Linus']) expect(historyFile).not.toContain(cellValue)

    const second = await launchApp({ userDataDir })
    const dialog = await openHistory(second)
    await expect(entriesOf(dialog)).toHaveCount(1)
    await expect(entriesOf(dialog).first()).toContainText(PEOPLE_SQL)
    expect(second.errors).toEqual([])
  })

  test('con «Guardar en el historial» desmarcado la consulta no se registra', async ({
    launchApp,
    fixtureDb,
    userDataDir,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    const optOut = page.getByRole('checkbox', { name: 'Guardar en el historial' })
    await expect(optOut).toBeChecked()
    await optOut.uncheck()
    await runSql(page, 'Consulta 1', PEOPLE_SQL)
    await expect(page.getByRole('grid', { name: 'Resultados de la consulta' })).toBeVisible()

    const dialog = await openHistory(app)
    await expect(dialog.getByText('Todavía no hay consultas en el historial')).toBeVisible()
    await closeHistory(app, dialog)

    // Con la casilla marcada de nuevo sí se registra: la ausencia anterior no era un historial roto.
    await optOut.check()
    await runSql(page, 'Consulta 1', PROJECTS_SQL)
    const again = await openHistory(app)
    await expect(entriesOf(again)).toHaveCount(1)
    await expect(entriesOf(again).first()).toContainText(PROJECTS_SQL)

    const stored = (await readUserDataFile(userDataDir, 'history.json')) as {
      entries?: { sql: string }[]
    } | null
    expect(JSON.stringify(stored)).not.toContain(PEOPLE_SQL)
    expect(app.errors).toEqual([])
  })

  test('una consulta que termina con el diálogo abierto aparece sin cerrarlo ni recargar', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await editorOf(page, 'Consulta 1').fill(SLOW_SQL)
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'running')

    const dialog = await openHistory(app)
    await expect(dialog.getByText('Todavía no hay consultas en el historial')).toBeVisible()
    // La lista se cargó vacía con la consulta aún en curso: lo que aparezca después llega por el evento.
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'running')

    await expect(entriesOf(dialog)).toHaveCount(1)
    await expect(entriesOf(dialog).first()).toContainText('Correcta')
    await expect(entriesOf(dialog).first()).toContainText('hace un momento')
    await expect(dialog.getByRole('status').filter({ hasText: 'Consulta nueva' })).toHaveText(
      'Consulta nueva añadida al historial',
    )
    await expect(dialog).toBeVisible()
    expect(app.errors).toEqual([])
  })

  test('cambiar la retención en Ajustes purga y la lista abierta se actualiza sola', async ({
    launchApp,
    fixtureDb,
    userDataDir,
  }) => {
    const today = new Date()
    await seedHistory(userDataDir, [
      { id: 'e-today', sql: 'select 1 as hoy', at: atLocalNoon(today, 0) },
      { id: 'e-old', sql: 'select 2 as antigua', at: atLocalNoon(today, -20) },
    ])
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    const settings = settingsDialog(page)

    // Con el historial desactivado su diálogo ofrece abrir Ajustes encima sin cerrarse: la única forma de cambiar
    // la retención con la lista abierta. Desactivarlo no detiene la purga.
    await page.keyboard.press(`${MOD}+,`)
    await settings.getByRole('checkbox', { name: 'Guardar el historial de consultas' }).uncheck()
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()

    const dialog = await openHistory(app)
    await expect(entriesOf(dialog)).toHaveCount(2)
    await dialog.getByRole('button', { name: 'Abrir ajustes' }).click()
    await expect(settings).toBeVisible()
    const retention = settings.getByLabel('Conservar el historial durante')

    // Ampliar la retención no purga nada: main no emite `purged` y la lista se queda como está.
    await retention.selectOption({ label: '90 días' })
    await expect(retention).toHaveValue('90')
    await expect(dialog.locator('[data-entry-id]')).toHaveCount(2)

    // Con 7 días, la entrada de hace 20 caduca: llega el evento `purged` y se recarga la lista abierta.
    await retention.selectOption({ label: '7 días' })
    await expect(retention).toHaveValue('7')
    await expect(dialog.locator('[data-entry-id]')).toHaveCount(1)
    await expect(dialog.locator('[data-entry-id]')).toContainText('select 1 as hoy')

    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
    await expect(dialog).toBeVisible()
    await expect(entriesOf(dialog)).toHaveCount(1)
    expect(app.errors).toEqual([])
  })

  test('filtra por fecha (hora local), valida el rango y «Quitar filtros» lo limpia', async ({
    launchApp,
    fixtureDb,
    userDataDir,
  }) => {
    const today = new Date()
    await seedHistory(userDataDir, [
      { id: 'e-today', sql: 'select 1 as hoy', at: atLocalNoon(today, 0) },
      { id: 'e-yesterday', sql: 'select 2 as ayer', at: atLocalNoon(today, -1) },
      { id: 'e-week', sql: 'select 3 as semana', at: atLocalNoon(today, -5) },
    ])
    const app = await launchApp()
    await connectFixture(app, fixtureDb)
    const dialog = await openHistory(app)
    await expect(entriesOf(dialog)).toHaveCount(3)

    const from = dialog.getByLabel('Desde (hora local)')
    const to = dialog.getByLabel('Hasta (hora local)')

    await from.fill(localDay(today, -1))
    await expect(entriesOf(dialog)).toHaveCount(2)
    await to.fill(localDay(today, -1))
    await expect(entriesOf(dialog)).toHaveCount(1)
    await expect(entriesOf(dialog).first()).toContainText('select 2 as ayer')

    // Rango invertido: no se pide, se explica y la lista se conserva.
    await from.fill(localDay(today, 0))
    await expect(to).toHaveAttribute('aria-invalid', 'true')
    await expect(
      dialog.getByText('La fecha «Desde» no puede ser posterior a «Hasta».').first(),
    ).toBeVisible()
    await expect(entriesOf(dialog)).toHaveCount(1)

    await from.fill('2099-01-01')
    await to.fill('2099-12-31')
    await expect(dialog.getByText('Ninguna consulta coincide con la búsqueda')).toBeVisible()

    await dialog.getByRole('button', { name: 'Quitar filtros' }).click()
    await expect(entriesOf(dialog)).toHaveCount(3)
    await expect(from).toHaveValue('')
    await expect(to).toHaveValue('')
    expect(app.errors).toEqual([])
  })

  test('quita del historial la consulta recién ejecutada, con botón y con la paleta, sin dejar rastro en disco', async ({
    launchApp,
    fixtureDb,
    userDataDir,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    const exclude = page.getByRole('button', { name: 'Quitar del historial' })
    await expect(exclude).toBeHidden()

    await runSql(page, 'Consulta 1', PEOPLE_SQL)
    await expect(exclude).toBeVisible()
    await exclude.click()
    await expect(exclude).toBeHidden()
    await expect(page.locator('[data-part="history-excluded"]')).toHaveText('Quitada del historial')
    await expect(page.locator('[data-part="palette-announcer"]')).toHaveText(
      'Consulta quitada del historial',
    )
    await expect(editorOf(page, 'Consulta 1')).toBeFocused()

    // Por teclado: la paleta ofrece el mismo comando mientras la última ejecución tenga entrada.
    await runSql(page, 'Consulta 1', PROJECTS_SQL)
    await page.keyboard.press(`${MOD}+K`)
    await palette(page).getByRole('combobox').fill('Quitar del historial')
    await page.keyboard.press('Enter')
    await expect(palette(page)).toBeHidden()
    await expect(exclude).toBeHidden()

    const dialog = await openHistory(app)
    await expect(dialog.getByText('Todavía no hay consultas en el historial')).toBeVisible()
    await closeHistory(app, dialog)

    const stored = JSON.stringify(await readUserDataFile(userDataDir, 'history.json'))
    expect(stored).not.toContain(PEOPLE_SQL)
    expect(stored).not.toContain(PROJECTS_SQL)

    // La siguiente ejecución vuelve a guardarse y a poder quitarse.
    await runSql(page, 'Consulta 1', PEOPLE_SQL)
    await expect(exclude).toBeVisible()
    expect(app.errors).toEqual([])
  })

  test('la acción de quitar no rompe la barra: sigue en dos líneas de 720 a 1280 px', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page, electronApp } = app
    await connectFixture(app, fixtureDb)
    const toolbar = page.locator('[data-region="execution-toolbar"]')
    const exclude = page.getByRole('button', { name: 'Quitar del historial' })

    const actions = [
      'Ejecutar',
      'Ejecutar todo',
      'Cancelar',
      'Iniciar transacción',
      'Confirmar',
      'Revertir',
    ]

    // 720 px es el ancho mínimo de la ventana (MIN_WINDOW_WIDTH): por debajo no se puede encoger.
    for (const width of [720, 760, 900, 1280]) {
      await electronApp.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(size, 720)
      }, width)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
      await expect(exclude).toBeHidden()
      const bar = (await toolbar.boundingBox())!
      const before = bar.height

      // Dos líneas caben en menos de 90 px; con tres la barra pasa de 105 px.
      expect(before, `alto de la barra a ${width} px`).toBeLessThan(90)
      for (const name of actions) {
        const box = (await toolbar.getByRole('button', { name, exact: true }).boundingBox())!
        expect(box.y, `«${name}» a ${width} px en la primera línea`).toBeLessThan(bar.y + 48)
        expect(box.x + box.width, `«${name}» a ${width} px dentro de la barra`).toBeLessThanOrEqual(
          bar.x + bar.width,
        )
      }

      await runSql(page, 'Consulta 1', PEOPLE_SQL)
      await expect(exclude).toBeVisible()
      const after = (await toolbar.boundingBox())!.height

      expect(after, `alto de la barra a ${width} px`).toBeLessThanOrEqual(before + 1)

      // El estado se lee entero (sin elipsis) aunque en anchos reducidos se omita «Última ejecución»; el texto
      // completo sigue en el nombre accesible y en el tooltip.
      const status = executionStatus(page)
      await expect(status).toContainText('Última ejecución completada')
      await expect(status).toHaveAttribute('title', /^Última ejecución completada/)
      expect(
        await status.evaluate((element) => element.scrollWidth - element.clientWidth),
        `texto de estado recortado a ${width} px`,
      ).toBeLessThanOrEqual(0)

      // Objetivos de clic de la segunda línea: 24 px de alto como mínimo, sin haber agrandado la barra.
      for (const name of actions) {
        await expectTargetSize(
          toolbar.getByRole('button', { name, exact: true }),
          `«${name}» a ${width} px`,
        )
      }
      await expectTargetSize(
        toolbar.locator('[data-part="save-to-history"]'),
        `«Guardar en el historial» a ${width} px`,
      )
      await expectTargetSize(exclude, `«Quitar del historial» a ${width} px`)
      const ask = toolbar.getByRole('button', { name: 'Preguntar a la base con IA', exact: true })
      const askBox = (await ask.boundingBox())!
      expect(askBox.y, `«Preguntar» a ${width} px en la primera línea`).toBeLessThan(bar.y + 48)
      expect(
        askBox.x + askBox.width,
        `«Preguntar» a ${width} px dentro de la barra`,
      ).toBeLessThanOrEqual(bar.x + bar.width)
      await expectTargetSize(ask, `«Preguntar» a ${width} px`)
      await expectTargetSize(
        toolbar.getByRole('button', { name: 'Ajustes de ejecución' }),
        `«Ajustes» a ${width} px`,
      )
      await expectTargetSize(
        toolbar.getByRole('button', { name: 'Historial', exact: true }),
        `«Historial» a ${width} px`,
      )
      await expectTargetSize(page.locator('.tab__close').first(), `cierre de pestaña a ${width} px`)
      await expect(
        toolbar.getByRole('checkbox', { name: 'Guardar en el historial' }),
        `nombre accesible de la casilla a ${width} px`,
      ).toBeVisible()
      const statusBar = (await page
        .getByRole('contentinfo', { name: 'Barra de estado' })
        .boundingBox())!
      expect(statusBar.height, `barra de estado en una línea a ${width} px`).toBeLessThan(34)

      await exclude.click()
      await expect(exclude).toBeHidden()
    }
    expect(app.errors).toEqual([])
  })

  test('con una transacción activa la barra sigue en dos líneas a 720 y 760 px', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page, electronApp } = app
    await connectFixture(app, fixtureDb)
    const toolbar = page.locator('[data-region="execution-toolbar"]')
    const exclude = page.getByRole('button', { name: 'Quitar del historial' })
    const chip = toolbar.locator('[data-part="transaction-state"]')

    await toolbar.getByRole('button', { name: 'Iniciar transacción' }).click()
    await expect(chip).toHaveAttribute('data-state', 'active')

    for (const width of [720, 760]) {
      await electronApp.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(size, 720)
      }, width)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
      expect((await toolbar.boundingBox())!.height, `alto sin consulta a ${width} px`).toBeLessThan(
        90,
      )

      await runSql(page, 'Consulta 1', PEOPLE_SQL)
      await expect(exclude).toBeVisible()
      expect((await toolbar.boundingBox())!.height, `alto con consulta a ${width} px`).toBeLessThan(
        90,
      )
      await exclude.click()
      await expect(exclude).toBeHidden()
    }
    expect(app.errors).toEqual([])
  })

  test('con el historial desactivado el aviso queda junto a la casilla, sin tercera línea, de 720 a 1280 px', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    const toolbar = page.locator('[data-region="execution-toolbar"]')

    await page.keyboard.press(`${MOD}+,`)
    const settings = settingsDialog(page)
    await settings.getByRole('checkbox', { name: 'Guardar el historial de consultas' }).uncheck()
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()

    const optOut = toolbar.getByRole('checkbox', { name: 'Guardar en el historial' })
    const reason = toolbar.locator('.exec-toolbar__reason')

    for (const width of [720, 760, 900, 1280]) {
      await resizeWindow(app, width)
      await runSql(page, 'Consulta 1', PEOPLE_SQL)
      await expect(reason).toBeVisible()

      const bar = (await toolbar.boundingBox())!
      expect(bar.height, `alto de la barra a ${width} px`).toBeLessThan(90)
      const checkbox = (await optOut.boundingBox())!
      const note = (await reason.boundingBox())!
      expect(
        Math.abs(note.y - checkbox.y),
        `aviso en la línea de la casilla a ${width} px`,
      ).toBeLessThan(12)
      expect(note.x + note.width, `aviso dentro de la barra a ${width} px`).toBeLessThanOrEqual(
        bar.x + bar.width,
      )
      // La descripción lleva delante el glifo de aviso generado por CSS.
      await expect(optOut).toHaveAccessibleDescription(
        /El historial está desactivado en los ajustes\.$/,
      )
      await expect(reason).toHaveAttribute('title', 'El historial está desactivado en los ajustes.')
      await expectTargetSize(
        toolbar.locator('[data-part="save-to-history"]'),
        `«Guardar en el historial» a ${width} px`,
      )
      expect(
        await executionStatus(page).evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
        `texto de estado recortado a ${width} px`,
      ).toBeLessThanOrEqual(0)
    }
    expect(app.errors).toEqual([])
  })
})
