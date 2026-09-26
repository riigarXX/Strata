import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { THEMES, buildCss, loadTokens } from '../scripts/lib.mjs'

const px = (value) => {
  const match = /^(\d+)px$/.exec(value)
  assert.ok(match, `expected a px value, got ${JSON.stringify(value)}`)
  return Number(match[1])
}

const paths = (tokens, prefix) =>
  tokens.filter((token) => token.path.startsWith(`${prefix}.`)).map((token) => token.path)

describe('token invariants', async () => {
  const model = await loadTokens()
  const css = buildCss(model)

  it('keeps colors literal only in primitives', () => {
    const [, ...rest] = css.split('\n}\n')
    assert.doesNotMatch(rest.join('\n}\n'), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })

  it('spacing follows a 4px base', () => {
    const spacing = paths(model.primitive, 'spacing')
    assert.ok(spacing.length > 0)
    for (const path of spacing) {
      const value = px(model.resolve('dark', path))
      assert.equal(value % 4, 0, `${path} (${value}px) is not a multiple of 4px`)
      const step = /^spacing\.(\d+)$/.exec(path)
      if (step) assert.equal(value, Number(step[1]) * 4, `${path} must equal ${step[1]} x 4px`)
    }
  })

  it('radius scale is strictly increasing', () => {
    const scale = ['xs', 'sm', 'md', 'lg', 'xl', 'full'].map((name) =>
      px(model.resolve('dark', `radius.${name}`)),
    )
    assert.deepEqual(
      scale,
      [...scale].sort((a, b) => a - b),
    )
    assert.equal(new Set(scale).size, scale.length)
  })

  it('defines shadows per theme, never in the shared layer', () => {
    assert.equal(paths(model.shared, 'shadow').length, 0)
    const dark = paths(model.byTheme.dark, 'shadow')
    assert.deepEqual(dark, paths(model.byTheme.light, 'shadow'))
    for (const path of dark) {
      const [darkLayer] = [model.resolve('dark', path)].flat()
      const [lightLayer] = [model.resolve('light', path)].flat()
      assert.notEqual(darkLayer.color, lightLayer.color, `${path} is identical in both themes`)
    }
  })

  it('has a single glass blur and a single base line-height', () => {
    assert.equal(model.resolve('dark', 'glass.blur'), '16px')
    assert.equal(model.resolve('dark', 'font.lineHeight.base'), '22px')
  })

  it('backs every status color with a distinct glyph and outline', () => {
    const states = ['success', 'warning', 'error']
    for (const kind of ['glyph', 'outline']) {
      const values = states.map((state) => model.resolve('dark', `status.${kind}.${state}`))
      assert.equal(new Set(values).size, states.length, `status.${kind} values must differ`)
    }
    assert.notEqual(
      model.resolve('dark', 'connection.glyph.online'),
      model.resolve('dark', 'connection.glyph.offline'),
    )
  })

  it('gives every toolbar glyph its own symbol, including the AI assistant', () => {
    const glyphs = paths(model.tokensByTheme.dark, 'toolbar.glyph')
    assert.ok(glyphs.includes('toolbar.glyph.ask'), 'toolbar.glyph.ask must exist')
    const values = glyphs.map((path) => model.resolve('dark', path))
    assert.equal(new Set(values).size, glyphs.length, 'toolbar glyphs must differ')
    assert.match(
      model.resolve('dark', 'toolbar.glyph.ask'),
      /\uFE0E$/,
      'text presentation selector',
    )
  })

  describe('reduced motion', () => {
    const durations = model.shared.filter((token) => token.path.startsWith('motion.duration.'))

    it('every motion duration declares a near-zero override', () => {
      assert.ok(durations.length > 0)
      for (const token of durations) {
        const reduced = token.extensions.reducedMotion
        assert.match(reduced ?? '', /^0?\.\d+ms$|^0ms$/, `${token.path} needs reducedMotion`)
        assert.ok(parseFloat(reduced) <= 1, `${token.path} reducedMotion must be <= 1ms`)
      }
    })

    it('emits the override inside prefers-reduced-motion, after the base values', () => {
      const start = css.indexOf('@media (prefers-reduced-motion: reduce)')
      assert.ok(start > css.indexOf(":root,\n[data-theme='light']"))
      const block = css.slice(start)
      for (const token of durations) assert.ok(block.includes(`--${token.segments.join('-')}: `))
      assert.match(block, /--motion-iteration-loop: 1;/)
      assert.doesNotMatch(css.slice(0, start), /prefers-reduced-motion/)
    })

    it('keeps the full durations outside the media query', () => {
      const base = css.slice(0, css.indexOf('@media (prefers-reduced-motion: reduce)'))
      assert.match(base, /--motion-duration-base: 200ms;/)
      assert.match(base, /--motion-iteration-loop: infinite;/)
    })
  })

  it('resolves every token in both themes', () => {
    for (const theme of THEMES) {
      for (const token of model.tokensByTheme[theme]) {
        assert.doesNotThrow(() => model.resolve(theme, token.path), token.path)
      }
    }
  })
})
