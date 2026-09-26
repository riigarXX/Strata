import type { NormalizedError } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { describeError, endSentence } from './presentation'

const error = (message: string, retryable: boolean): NormalizedError => ({
  code: 'internal_error',
  message,
  retryable,
})

describe('endSentence', () => {
  it('adds a full stop when the text has no closing punctuation', () => {
    expect(endSentence('No se pudo leer history.json')).toBe('No se pudo leer history.json.')
  })

  it.each(['Ya termina así.', '¿Seguro?', '¡Cuidado!', 'Continúa…'])(
    'does not duplicate the punctuation of %j',
    (text) => {
      expect(endSentence(text)).toBe(text)
    },
  )

  it('ignores surrounding whitespace and leaves empty text empty', () => {
    expect(endSentence('  Sin punto \n')).toBe('Sin punto.')
    expect(endSentence('   ')).toBe('')
  })
})

describe('describeError', () => {
  it('separates the retry hint with a full stop when the message has none', () => {
    expect(describeError(error('No se pudo leer history.json', true))).toBe(
      'No se pudo leer history.json. Puedes reintentarlo.',
    )
  })

  it('does not double the full stop when the message already ends with one', () => {
    expect(describeError(error('No se pudo leer history.json.', true))).toBe(
      'No se pudo leer history.json. Puedes reintentarlo.',
    )
  })

  it('keeps the message as it is when the error is not retryable', () => {
    expect(describeError(error('The preferences are not valid', false))).toBe(
      'The preferences are not valid',
    )
  })
})
