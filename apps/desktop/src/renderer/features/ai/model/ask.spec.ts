import { AI_SQL_RISKS, AI_WARNINGS, type AiWarning, type NormalizedError } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import {
  BLOCKED_MESSAGE,
  decideAutoRun,
  describeAskError,
  describeAutoRun,
  describeReady,
  PREREQUISITE_MESSAGES,
  RISK_PRESENTATION,
  tabTitleFor,
  visibleWarnings,
  WARNING_MESSAGES,
  type AutoRunInput,
} from './ask'

const READ: AutoRunInput = {
  result: { risk: 'read', statementType: 'query' },
  transaction: 'none',
  sessionBusy: false,
}

const withResult = (result: Partial<AutoRunInput['result']>): AutoRunInput => ({
  ...READ,
  result: { ...READ.result, ...result },
})

describe('decideAutoRun', () => {
  it('runs a plain read on a free session with no transaction', () => {
    expect(decideAutoRun(READ)).toEqual({ run: true })
  })

  it.each(['write', 'destructive', 'unknown'] as const)('never runs a %s statement', (risk) => {
    expect(decideAutoRun(withResult({ risk }))).toEqual({ run: false, reason: 'risk' })
  })

  it.each(['dml', 'ddl', 'transaction', 'session', 'other'] as const)(
    'does not run a read that is a %s statement',
    (statementType) => {
      expect(decideAutoRun(withResult({ statementType }))).toEqual({ run: false, reason: 'risk' })
    },
  )

  it('lets blocked win over everything else, even for a read', () => {
    expect(decideAutoRun(withResult({ blocked: true }))).toEqual({ run: false, reason: 'blocked' })
    expect(decideAutoRun(withResult({ risk: 'write', blocked: true }))).toEqual({
      run: false,
      reason: 'blocked',
    })
  })

  it('does not run inside an open or aborted transaction', () => {
    expect(decideAutoRun({ ...READ, transaction: 'active' })).toEqual({
      run: false,
      reason: 'transaction',
    })
    expect(decideAutoRun({ ...READ, transaction: 'aborted' })).toEqual({
      run: false,
      reason: 'transaction',
    })
  })

  it('does not run while another tab is executing in the session', () => {
    expect(decideAutoRun({ ...READ, sessionBusy: true })).toEqual({ run: false, reason: 'busy' })
  })

  it('treats blocked === false like absent and only accepts an explicit read query', () => {
    expect(decideAutoRun(withResult({ blocked: false }))).toEqual({ run: true })
  })

  it('fails closed for every risk and statement type except read + query', () => {
    const runs = AI_SQL_RISKS.flatMap((risk) =>
      (['query', 'dml', 'ddl', 'transaction', 'session', 'other'] as const).map(
        (statementType) => ({ risk, statementType }),
      ),
    ).filter(({ risk, statementType }) => decideAutoRun(withResult({ risk, statementType })).run)
    expect(runs).toEqual([{ risk: 'read', statementType: 'query' }])
  })
})

describe('risk presentation', () => {
  it('gives every risk a glyph and a word, never only a colour', () => {
    for (const risk of AI_SQL_RISKS) {
      expect(RISK_PRESENTATION[risk].glyph, risk).not.toBe('')
      expect(RISK_PRESENTATION[risk].label, risk).not.toBe('')
    }
    expect(new Set(AI_SQL_RISKS.map((risk) => RISK_PRESENTATION[risk].glyph)).size).toBe(4)
  })
})

describe('warnings', () => {
  it('shows every warning except the read-only one, which has its own message', () => {
    expect(visibleWarnings([])).toEqual([])
    expect(visibleWarnings(['read_only_blocked'])).toEqual([])
    expect(visibleWarnings(['schema_truncated', 'reasoning_removed'])).toEqual([
      WARNING_MESSAGES.schema_truncated,
      WARNING_MESSAGES.reasoning_removed,
    ])
  })

  it('has a message for every warning code but the read-only one', () => {
    const shown = AI_WARNINGS.filter((code) => code !== 'read_only_blocked')
    for (const code of shown) {
      expect(visibleWarnings([code satisfies AiWarning]), code).toHaveLength(1)
    }
  })

  it('explains why a blocked statement cannot run', () => {
    expect(BLOCKED_MESSAGE).toContain('solo lectura')
  })
})

describe('describeAutoRun', () => {
  const TITLE = 'IA: pedidos'

  it('says a read query was run in the tab', () => {
    expect(describeAutoRun({ run: true }, 'read', TITLE)).toContain(`«${TITLE}»`)
    expect(describeAutoRun({ run: true }, 'read', TITLE)).toContain('se ha ejecutado')
  })

  it.each([
    ['write', 'modifica datos'],
    ['destructive', 'destructiva'],
    ['unknown', 'clasificar'],
  ] as const)('says a %s statement was not run and why', (risk, fragment) => {
    const message = describeAutoRun({ run: false, reason: 'risk' }, risk, TITLE)
    expect(message).toContain('No se ha ejecutado')
    expect(message).toContain(fragment)
  })

  it('does not claim a read that is not a plain query was safe', () => {
    expect(describeAutoRun({ run: false, reason: 'risk' }, 'read', TITLE)).toContain(
      'No se ha ejecutado',
    )
  })

  it('explains the transaction, busy and blocked cases', () => {
    expect(describeAutoRun({ run: false, reason: 'transaction' }, 'read', TITLE)).toContain(
      'transacción',
    )
    expect(describeAutoRun({ run: false, reason: 'busy' }, 'read', TITLE)).toContain('en curso')
    expect(describeAutoRun({ run: false, reason: 'blocked' }, 'write', TITLE)).toContain(
      'no se puede ejecutar',
    )
  })
})

describe('describeReady', () => {
  it('leads with the risk in words and follows with what happened', () => {
    const message = describeReady('destructive', { run: false, reason: 'risk' }, 'IA: borrar')
    expect(message.startsWith('Consulta lista, riesgo: destructiva.')).toBe(true)
    expect(message).toContain('No se ha ejecutado')
  })
})

describe('tabTitleFor', () => {
  it('prefixes the question and keeps a short one whole', () => {
    expect(tabTitleFor('¿cuántos pedidos hay?')).toBe('IA: ¿cuántos pedidos hay?')
  })

  it('collapses whitespace and line breaks', () => {
    expect(tabTitleFor('  los   5\nproductos \t más caros ')).toBe('IA: los 5 productos más caros')
  })

  it('shortens a long question with an ellipsis and never exceeds the limit', () => {
    const title = tabTitleFor('¿cuántos pedidos hizo cada cliente durante el último trimestre?')
    expect(title.startsWith('IA: ¿cuántos pedidos hizo')).toBe(true)
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual('IA: '.length + 28)
  })

  it('keeps a question of exactly the limit whole', () => {
    const question = 'a'.repeat(28)
    expect(tabTitleFor(question)).toBe(`IA: ${question}`)
  })
})

describe('prerequisites', () => {
  it('has a title and detail for each one', () => {
    for (const key of ['disabled', 'no-tab', 'no-session'] as const) {
      expect(PREREQUISITE_MESSAGES[key].title, key).not.toBe('')
      expect(PREREQUISITE_MESSAGES[key].detail, key).not.toBe('')
    }
  })
})

describe('describeAskError', () => {
  const error = (code: NormalizedError['code'], message = 'x'): NormalizedError => ({
    code,
    message,
    retryable: false,
  })

  it.each([
    ['permission_denied', 'desactivada', true],
    ['connection_failed', 'servidor de modelos', true],
    ['not_found', 'no está instalado', true],
    ['timeout', 'tardó demasiado', false],
    ['cancelled', 'cancelada', false],
    ['busy', 'otra pregunta', false],
    ['no_session', 'conexión', false],
    ['cannot_answer', 'reformula', false],
    ['transaction_aborted', 'transacción abortada', false],
  ] as const)(
    'explains %s and says whether the fix is in the settings',
    (code, fragment, settings) => {
      const presentation = describeAskError(error(code))
      expect(presentation.message).toContain(fragment)
      expect(presentation.settings).toBe(settings)
    },
  )

  it('tells the user how to leave an aborted transaction, in the interface words and not the server ones', () => {
    const presentation = describeAskError(
      error('transaction_aborted', 'current transaction is aborted, commands ignored'),
    )
    expect(presentation.message).toBe(
      'Hay una transacción abortada en esta conexión: pulsa «Revertir» o escribe ROLLBACK antes de preguntar.',
    )
    expect(presentation.message).not.toContain('commands ignored')
  })

  it('tells apart several statements from any other invalid output', () => {
    expect(
      describeAskError(error('validation_failed', 'The model returned more than one statement'))
        .message,
    ).toContain('varias sentencias')
    expect(
      describeAskError(error('validation_failed', 'The model did not return a SQL statement'))
        .message,
    ).toContain('no devolvió una consulta SQL válida')
  })

  it('never shows what the server or main wrote', () => {
    const secret = 'SECRETO: /Users/x/db.sqlite'
    for (const code of [
      'connection_failed',
      'timeout',
      'internal_error',
      'validation_failed',
      'transaction_aborted',
    ] as const) {
      expect(describeAskError(error(code, secret)).message).not.toContain('SECRETO')
    }
  })

  it('falls back to a generic message for unexpected codes', () => {
    expect(describeAskError(error('internal_error')).message).toContain('inesperado')
  })
})
