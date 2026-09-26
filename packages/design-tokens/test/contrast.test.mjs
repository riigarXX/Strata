import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { THEMES, loadTokens } from '../scripts/lib.mjs'
import { contrastRatio } from './wcag.mjs'

const TEXT = 4.5
const UI = 3
const VISIBLE = 1.25

const PLAIN_SURFACES = ['surface.canvas', 'surface.card', 'surface.elevated']
const TINTED_SURFACES = ['surface.muted', 'surface.secondary']
const ALL_SURFACES = [...PLAIN_SURFACES, ...TINTED_SURFACES]
const GRID_BODIES = ['grid.gutter-bg', 'grid.row-alt-bg', 'grid.row-hover-bg', 'grid.selection-bg']
const EDITOR_HIGHLIGHTS = [
  'editor.active-line-bg',
  'editor.selection-bg',
  'editor.selection-bg-inactive',
  'editor.bracket-match-bg',
  'editor.bracket-mismatch-bg',
]
const SYNTAX = ['keyword', 'string', 'number', 'comment', 'operator']

function pairs() {
  const list = []
  const add = (fg, backgrounds, min) => {
    for (const bg of [backgrounds].flat()) list.push({ fg, bg, min })
  }

  add('text.primary', ALL_SURFACES, TEXT)
  add('text.muted', [...PLAIN_SURFACES, 'surface.muted'], TEXT)
  add('text.on-elevated', 'surface.elevated', TEXT)
  add('text.on-secondary', 'surface.secondary', TEXT)
  add('text.on-action-primary', ['action.primary', 'action.primary-hover'], TEXT)
  add('text.on-error', 'status.error', TEXT)

  for (const fg of ['status.success', 'status.warning', 'status.error', 'action.primary']) {
    add(fg, PLAIN_SURFACES, TEXT)
    add(fg, TINTED_SURFACES, UI)
  }
  add('accent.secondary', PLAIN_SURFACES, TEXT)
  add('accent.secondary', TINTED_SURFACES, UI)
  add('action.primary-hover', PLAIN_SURFACES, UI)
  add('focus.ring', ALL_SURFACES, UI)

  add('button.primary.fg', ['button.primary.bg', 'button.primary.bg-hover'], TEXT)
  add('button.destructive.fg', ['button.destructive.bg', 'button.destructive.bg-hover'], TEXT)
  add('button.secondary.fg', ['button.secondary.bg', 'button.secondary.bg-hover'], TEXT)
  add('button.secondary.border', ['button.secondary.bg', 'dialog.bg', 'surface.canvas'], UI)
  add('input.fg', 'input.bg', TEXT)
  add('input.border', ['input.bg', 'surface.card', 'dialog.bg'], UI)
  add('input.border-focus', ['input.bg', 'surface.card'], UI)
  add('tab.fg', 'tab.bg-active', TEXT)
  add('tab.fg-active', 'tab.bg-active', TEXT)
  add('tab.indicator', 'tab.bg-active', UI)
  add('editor.fg', 'editor.bg', TEXT)
  add('text.primary', ['dialog.bg', 'sidebar.bg', 'grid.header-bg', 'grid.row-hover-bg'], TEXT)

  add('text.primary', 'surface.subtle', TEXT)
  add('text.muted', 'surface.subtle', TEXT)
  add('grid.header-fg', 'grid.header-bg', TEXT)
  add('text.primary', GRID_BODIES, TEXT)
  add('text.muted', GRID_BODIES, TEXT)
  add('status.warning', GRID_BODIES, UI)
  add('focus.ring', GRID_BODIES, UI)
  add('text.muted', 'grid.gutter-bg', TEXT)

  add('editor.fg', EDITOR_HIGHLIGHTS, TEXT)
  add('text.muted', 'editor.active-line-bg', TEXT)
  add('focus.ring', ['editor.bg', 'editor.active-line-bg', 'editor.selection-bg'], UI)
  for (const name of SYNTAX) {
    add(
      `editor.syntax.${name}`,
      ['editor.bg', 'editor.active-line-bg', 'editor.selection-bg'],
      TEXT,
    )
  }

  for (const fg of [
    'query.running',
    'transaction.active',
    'connection.online',
    'connection.connecting',
  ]) {
    add(fg, PLAIN_SURFACES, TEXT)
  }
  add('connection.offline', [...PLAIN_SURFACES, 'surface.muted'], TEXT)
  return list
}

describe('WCAG contrast', async () => {
  const model = await loadTokens()

  it('computes ratios against known reference values', () => {
    assert.equal(contrastRatio('#000000', '#FFFFFF').toFixed(2), '21.00')
    assert.equal(contrastRatio('#FFFFFF', '#16A34A').toFixed(2), '3.30')
  })

  for (const theme of THEMES) {
    describe(`theme ${theme}`, () => {
      for (const { fg, bg, min } of pairs()) {
        it(`${fg} on ${bg} >= ${min}:1`, () => {
          const ratio = contrastRatio(model.resolve(theme, fg), model.resolve(theme, bg))
          assert.ok(
            ratio >= min,
            `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the required ${min}:1`,
          )
        })
      }

      for (const highlight of ['editor.selection-bg', 'editor.bracket-match-bg']) {
        it(`${highlight} stands out from editor.bg (>= ${VISIBLE}:1)`, () => {
          const ratio = contrastRatio(
            model.resolve(theme, highlight),
            model.resolve(theme, 'editor.bg'),
          )
          assert.ok(
            ratio >= VISIBLE,
            `${theme}: ${highlight} is only ${ratio.toFixed(2)}:1 from editor.bg`,
          )
        })
      }

      it('gives every syntax color its own value', () => {
        const values = SYNTAX.map((name) => model.resolve(theme, `editor.syntax.${name}`))
        assert.equal(new Set(values).size, SYNTAX.length)
      })
    })
  }
})
