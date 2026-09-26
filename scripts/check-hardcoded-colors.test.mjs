import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SCAN_ROOTS,
  findHardcodedColors,
  isExcluded,
  scanProject,
} from './check-hardcoded-colors.mjs'

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-hardcoded-colors.mjs',
)
const RENDERER = DEFAULT_SCAN_ROOTS[0]

const texts = (source, file) => findHardcodedColors(source, file).map((hit) => hit.text)

describe('detects literal colors', () => {
  for (const hex of ['#fff', '#FFFA', '#1a2b3c', '#1a2b3c4d']) {
    test(`hex ${hex} in <style>`, () => {
      const source = `<template><p /></template>\n<style scoped>\n.a {\n  color: ${hex};\n}\n</style>\n`
      const [hit] = findHardcodedColors(source, 'A.vue')
      assert.deepEqual(hit, { line: 4, column: 10, text: hex, kind: 'hex color' })
    })
  }

  test('hex without trailing semicolon and inside shorthands', () => {
    assert.deepEqual(texts('.a { border: 1px solid #abc }', 'a.css'), ['#abc'])
    assert.deepEqual(texts('.a { box-shadow: 0 0 4px #00000080; }', 'a.css'), ['#00000080'])
  })

  test('rgb/rgba/hsl/hsla and the other functional notations', () => {
    const css = [
      'a { color: rgb(0 0 0); }',
      'a { color: rgba(0, 0, 0, .5); }',
      'a { color: hsl(10 20% 30%); }',
      'a { color: hsla(10, 20%, 30%, .5); }',
      'a { color: hwb(10 20% 30%); }',
      'a { color: lab(50% 10 10); }',
      'a { color: lch(50% 10 10); }',
      'a { color: oklab(50% 0.1 0.1); }',
      'a { color: oklch(50% 0.1 10); }',
      'a { color: color(display-p3 1 0 0); }',
    ].join('\n')
    assert.deepEqual(texts(css, 'a.css'), [
      'rgb(',
      'rgba(',
      'hsl(',
      'hsla(',
      'hwb(',
      'lab(',
      'lch(',
      'oklab(',
      'oklch(',
      'color(',
    ])
  })

  test('style="" attribute and :style bindings in the template', () => {
    const source = [
      '<template>',
      '  <div style="color: #fff; background:rgb(1,2,3)"></div>',
      `  <div :style="{ color: '#123456', borderColor: 'hsl(0 0% 0%)' }"></div>`,
      '</template>',
    ].join('\n')
    const hits = findHardcodedColors(source, 'A.vue')
    assert.deepEqual(
      hits.map(({ line, text }) => [line, text]),
      [
        [2, '#fff'],
        [2, 'rgb('],
        [3, '#123456'],
        [3, 'hsl('],
      ],
    )
  })

  test('strings in .ts and in <script> of an SFC', () => {
    assert.deepEqual(texts(`const c = '#ff0000'\nconst d = "#0f08"`, 'a.ts'), ['#ff0000', '#0f08'])
    assert.deepEqual(texts('const c = `rgba(0, 0, 0, 0.5)`', 'a.ts'), ['rgba('])
    assert.deepEqual(texts(`const s = 'color: #fff; padding: 0'`, 'a.ts'), ['#fff'])
    const sfc = `<script setup lang="ts">\nconst fill = '#abcdef'\n</script>\n`
    assert.deepEqual(findHardcodedColors(sfc, 'A.vue'), [
      { line: 2, column: 15, text: '#abcdef', kind: 'hex color' },
    ])
  })

  test('svg and html attributes', () => {
    assert.deepEqual(texts('<svg><path fill="#000" stroke="rgb(0,0,0)"/></svg>', 'i.svg'), [
      '#000',
      'rgb(',
    ])
    assert.deepEqual(texts('<body style="background: #fff"></body>', 'index.html'), ['#fff'])
  })

  test('named colors only as value of CSS color properties', () => {
    assert.deepEqual(
      texts('a { color: red; border: 1px solid White; background: url(x.png) blue; }', 'a.css'),
      ['red', 'White', 'blue'],
    )
    assert.deepEqual(texts(`const s = { backgroundColor: 'black' }`, 'a.ts'), ['black'])
    assert.deepEqual(texts('a { fill: none; content: "red"; font-family: red; }', 'a.css'), [])
    assert.deepEqual(texts('const color: red = 1\nconst red = 2', 'a.ts'), [])
  })

  test('reports line and column after multi-line content', () => {
    const source = '.a {\n  margin: 0;\n\n    color: #fff;\n}\n'
    assert.deepEqual(findHardcodedColors(source, 'a.css'), [
      { line: 4, column: 12, text: '#fff', kind: 'hex color' },
    ])
  })
})

describe('accepts legitimate code', () => {
  test('tokens and non-literal color keywords', () => {
    const css = [
      'a { color: var(--color-text-primary); }',
      'a { color: inherit; background: transparent; border-color: currentColor; }',
      'a { fill: none; outline: 1px solid var(--color-focus-ring); }',
      'a { background: color-mix(in srgb, var(--color-a) 20%, var(--color-b)); }',
      'a { color: oklch(from var(--color-accent) l c h / 50%); }',
      'a { box-shadow: 0 0 0 1px var(--color-border, var(--color-fallback)); }',
    ].join('\n')
    assert.deepEqual(texts(css, 'a.css'), [])
    assert.deepEqual(
      texts(
        `<template><div style="color: var(--color-x)" :style="{ color: 'currentColor' }" /></template>`,
        'A.vue',
      ),
      [],
    )
  })

  test('#123-like values that are not colors', () => {
    assert.deepEqual(texts('#123 { margin: 0 }\n.list #abc, #fade .x { margin: 0 }', 'a.css'), [])
    assert.deepEqual(texts('a { fill: url(#abc); mask: url("#def123") }', 'a.css'), [])
    assert.deepEqual(texts('a[href="#top"] { margin: 0 }', 'a.css'), [])
    assert.deepEqual(texts('.a { color: #12345; }', 'a.css'), [])
    assert.deepEqual(texts('.a { color: #ggg; }', 'a.css'), [])
  })

  test('anchors, ids and ordinary text in templates and code', () => {
    const template = [
      '<template>',
      '  <a href="#abc">Issue #123</a>',
      '  <a :href="`#fade`" xlink:href="#face" />',
      '  <label for="#bad" id="#bed" aria-labelledby="#dad" data-target="#cab" />',
      '  <RouterLink to="#fed" />',
      '  <p>&#123; &#x1F600; &#1234;</p>',
      '</template>',
    ].join('\n')
    assert.deepEqual(texts(template, 'A.vue'), [])
    assert.deepEqual(
      texts(
        [
          `document.querySelector('#abc')`,
          `el.closest("#fade")`,
          `location.hash = '#bad'`,
          `const url = 'https://x.dev/page#abc'`,
          'const n = `item #123`',
          `const fn = getRgb(1) + setColor(2)`,
          `const s = 'use rgb() here'`,
        ].join('\n'),
        'a.ts',
      ),
      [],
    )
  })

  test('comments are ignored in CSS, JS and HTML', () => {
    assert.deepEqual(
      texts('/* color: #fff; rgb(1,2,3) */\na { color: var(--x); /* #000 */ }', 'a.css'),
      [],
    )
    assert.deepEqual(
      texts(`// const c = '#fff'\n/* rgba(0,0,0,1)\n#000 */\nconst x = 1 // hsl(0 0% 0%)`, 'a.ts'),
      [],
    )
    const sfc = [
      '<template>',
      '  <!-- <div style="color: #fff"></div> -->',
      '  <p>ok</p>',
      '</template>',
      '<style>',
      '/* .a { color: red; } */',
      '</style>',
    ].join('\n')
    assert.deepEqual(texts(sfc, 'A.vue'), [])
  })

  test('comment markers inside strings do not hide colors or shift positions', () => {
    const source = `const url = 'http://x.dev'; const c = '#fff' // ok`
    assert.deepEqual(findHardcodedColors(source, 'a.ts'), [
      { line: 1, column: 40, text: '#fff', kind: 'hex color' },
    ])
    assert.deepEqual(texts(`a { content: "/*"; color: #fff; }`, 'a.css'), ['#fff'])
  })
})

describe('isExcluded', () => {
  test('excludes the documented paths and test files', () => {
    for (const excluded of [
      'packages/design-tokens/src/primitives.ts',
      'docs/a.css',
      'spikes/x/a.ts',
      'tasks/a.ts',
      `${RENDERER}/node_modules/x/a.ts`,
      `${RENDERER}/out/a.ts`,
      'apps/desktop/dist/a.ts',
      `${RENDERER}/app/App.spec.ts`,
      `${RENDERER}/app/a.test.ts`,
      `${RENDERER}/app/a.test.mjs`,
    ]) {
      assert.equal(isExcluded(excluded), true, excluded)
    }
  })

  test('keeps renderer sources, including folders named like excluded roots', () => {
    for (const included of [
      `${RENDERER}/app/App.vue`,
      `${RENDERER}/features/tasks/List.vue`,
      `${RENDERER}/features/docs/Panel.vue`,
      `${RENDERER}/spec-utils.ts`,
    ]) {
      assert.equal(isExcluded(included), false, included)
    }
  })
})

describe('scanProject and CLI', () => {
  const created = []
  after(() => Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true }))))

  async function fixture(files) {
    const root = await mkdtemp(path.join(tmpdir(), 'strata-colors-'))
    created.push(root)
    for (const [file, content] of Object.entries(files)) {
      const absolute = path.join(root, file)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, content)
    }
    return root
  }

  const run = (root, args = []) =>
    spawnSync(process.execPath, [scriptPath, '--root', root, ...args], { encoding: 'utf8' })

  test('ignores excluded paths and test files, flags the rest', async () => {
    const root = await fixture({
      [`${RENDERER}/app/Clean.vue`]: '<style>a { color: var(--color-text); }</style>',
      [`${RENDERER}/app/Bad.vue`]:
        '<template><p /></template>\n<style>\na { color: #fff }\n</style>',
      [`${RENDERER}/notes.md`]: 'color: #fff',
      [`${RENDERER}/app/Bad.spec.ts`]: `const c = '#fff'`,
      [`${RENDERER}/node_modules/dep/index.ts`]: `const c = '#fff'`,
      [`${RENDERER}/out/bundle.js`]: `const c = '#fff'`,
      'packages/design-tokens/src/primitives.ts': `export const white = '#ffffff'`,
      'docs/example.css': 'a { color: #fff }',
      'spikes/s/index.ts': `const c = '#fff'`,
      'tasks/x.ts': `const c = '#fff'`,
    })
    const { violations, filesScanned } = await scanProject({ root, scanRoots: ['.'] })
    assert.equal(filesScanned, 2)
    assert.deepEqual(violations, [
      { file: `${RENDERER}/app/Bad.vue`, line: 3, column: 12, text: '#fff', kind: 'hex color' },
    ])
  })

  test('exit 1 with file:line:column message when a literal color exists', async () => {
    const root = await fixture({
      [`${RENDERER}/app/App.vue`]: '<style>\n.a {\n  color: #ff0000;\n}\n</style>\n',
      [`${RENDERER}/styles/base.css`]: 'a { background: rgba(0, 0, 0, .5); }',
    })
    const result = run(root)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp(`${RENDERER}/app/App\\.vue:3:10 {2}hex color "#ff0000"`))
    assert.match(
      result.stderr,
      new RegExp(`${RENDERER}/styles/base\\.css:1:17 {2}functional color "rgba\\("`),
    )
    assert.match(result.stderr, /2 hardcoded color\(s\) found/)
    assert.match(result.stderr, /design-tokens/)
  })

  test('exit 0 when the renderer only uses tokens', async () => {
    const root = await fixture({
      [`${RENDERER}/app/App.vue`]:
        '<template><p style="color: var(--color-text)" /></template>\n<style>\na { color: inherit; background: transparent; }\n</style>',
      [`${RENDERER}/app/main.ts`]: `import { createApp } from 'vue'`,
    })
    const result = run(root)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /OK \(2 files scanned\)/)
    assert.equal(result.stderr, '')
  })

  test('explicit paths replace the default scan roots', async () => {
    const root = await fixture({
      [`${RENDERER}/app/App.vue`]: '<template><p /></template>',
      'apps/desktop/src/main/window.ts': `const backgroundColor = '#101010'`,
    })
    assert.equal(run(root).status, 0)
    const result = run(root, ['apps/desktop/src/main'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /apps\/desktop\/src\/main\/window\.ts:1:26 {2}hex color "#101010"/)
  })

  test('exit 2 when the scan path does not exist or the option is unknown', async () => {
    const root = await fixture({ 'README.txt': 'x' })
    const missing = run(root)
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /scan path not found: apps\/desktop\/src\/renderer/)
    const unknown = run(root, ['--nope'])
    assert.equal(unknown.status, 2)
    assert.match(unknown.stderr, /unknown option: --nope/)
  })
})
