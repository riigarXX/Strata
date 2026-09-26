import type { Page } from '@playwright/test'

// La sonda es la misma que usa `pnpm smoke:packaged` sobre el .app: una sola definición de qué es «seguro».
// Se importa de forma dinámica porque el script es ESM con `await` de nivel superior y Playwright compila los tests a CJS.
const loadSmoke = () => import('../../scripts/smoke-packaged.mjs')

export interface ProbeCheck {
  name: string
  ok: boolean
  detail: string
}

export async function expectedDbSections(): Promise<string[]> {
  return [...(await loadSmoke()).EXPECTED_DB_SECTIONS]
}

/**
 * Recarga la ventana con el contador de violaciones de CSP instalado antes de que cargue el documento y ejecuta
 * la sonda del smoke. Va por CDP con `allowUnsafeEvalBlockedByCSP: false`: por defecto CDP se salta el bloqueo de
 * `eval` por CSP y la comprobación de `new Function` daría un falso verde.
 */
export async function runSecurityProbe(page: Page): Promise<ProbeCheck[]> {
  const smoke = await loadSmoke()

  await page.addInitScript({ content: smoke.CSP_LISTENER_SOURCE })
  await page.reload()
  await page.getByRole('contentinfo', { name: 'Barra de estado' }).waitFor()

  const cdp = await page.context().newCDPSession(page)
  try {
    const evaluate = async (expression: string): Promise<unknown> =>
      smoke.unwrapEvaluation(
        await cdp.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: false,
          timeout: 20_000,
        }),
      )

    // Antes de la sonda: sus propias pruebas (new Function, fetch) generan violaciones a propósito.
    const cspViolations = await evaluate('window.__cspv ?? null')
    const probe = await evaluate(smoke.buildProbeExpression())
    return smoke.evaluateProbe(probe, cspViolations)
  } finally {
    await cdp.detach()
  }
}
