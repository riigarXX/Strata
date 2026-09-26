#!/usr/bin/env node
// Falla si el renderer contiene colores literales. Todo color debe venir de
// @strata/design-tokens (var(--token)); hex/rgba solo viven en sus primitivos.
//
// Uso:
//   node scripts/check-hardcoded-colors.mjs [--root <dir>] [<ruta-relativa>...]
//   --root  raíz del proyecto (por defecto, la del repo).
//   <ruta>  directorios/archivos a escanear, relativos a --root
//           (por defecto: DEFAULT_SCAN_ROOTS).
// Salida: 0 sin hallazgos, 1 con colores literales, 2 error de uso/entorno.
//
// Criterio de falsos positivos (cubierto en check-hardcoded-colors.test.mjs):
// - Los comentarios (CSS/JS/HTML) se ignoran; las posiciones se conservan.
// - Hex (#rgb, #rgba, #rrggbb, #rrggbbaa): solo cuenta como color si es un
//   valor CSS (fuera de selectores y de url(#id)), un string completo
//   ('#fff') o va tras una declaración (`color: #fff`). Quedan fuera
//   `#123` como selector/ancla/texto, `&#123;`, y strings de href/id/to/for/
//   name/hash/aria-*/data-*/querySelector/closest/matches/getElementById.
// - Funcional: rgb/rgba/hsl/hsla/hwb/lab/lch/oklab/oklch y color(<espacio>...).
//   Se permite la sintaxis de color relativo derivado (`oklch(from var(--x) ...)`)
//   y las llamadas vacías (`rgb()` en texto).
// - Colores con nombre: solo lista acotada (NAMED_COLORS) y solo como valor de
//   propiedades de color CSS (color, background, border, outline, fill,
//   stroke, box-shadow...). `inherit`, `currentColor`, `transparent` y `none`
//   nunca se marcan. En <script>/.ts se exige valor entrecomillado.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_SCAN_ROOTS = ['apps/desktop/src/renderer']

// Exclusiones explícitas. Los roots por defecto ya no incluyen estas rutas,
// pero se aplican igualmente por si se amplían los roots o se pasa un directorio.
export const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  'out',
  'dist',
  'dist-electron',
  'release',
])
export const EXCLUDED_PATH_PREFIXES = ['packages/design-tokens/', 'docs/', 'spikes/', 'tasks/']
export const EXCLUDED_FILE_PATTERN = /\.(?:spec|test)\.[^/]+$/

const CSS_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less'])
const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])
const MARKUP_EXTENSIONS = new Set(['.vue', '.html', '.svg'])

const NAMED_COLORS = new Set(
  (
    'black white red green blue yellow orange purple pink gray grey silver gold brown cyan ' +
    'magenta navy teal lime maroon olive aqua fuchsia indigo violet crimson coral salmon tomato'
  ).split(' '),
)

const HEX_RE = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi
const FUNCTIONAL_RE = /(?<![\w$.-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?!\s*(?:from\b|\)))/gi
const COLOR_FN_RE =
  /(?<![\w$.-])color\((?=\s*(?:srgb-linear|srgb|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz(?:-d50|-d65)?)\b)/gi
const COLOR_PROP =
  '(?:color|background(?:-?color)?|border(?:-?(?:top|right|bottom|left))?(?:-?color)?|outline(?:-?color)?|fill|stroke|caret-?color|accent-?color|text-?decoration-?color|box-?shadow|text-?shadow)'
const NAMED_DECL_RE = new RegExp(
  `(?<![\\w-])${COLOR_PROP}(["']?)\\s*:\\s*(["']?)([^;{}"'\`\\n]*)`,
  'gi',
)
const OPAQUE_FN_RE = /(?:var|url|calc|env)\((?:[^()]|\([^()]*\))*\)/gi

const HEX_ANCHOR_KEY_RE =
  /(?<![\w-])(?:[:@]?(?:xlink:)?(?:href|to|id|for|name|target|hash|anchor|selector)|aria-[\w-]+|data-[\w-]+|querySelector(?:All)?|closest|matches|getElementById)\s*[:=(]\s*["'`]*\s*$/i
const URL_REF_RE = /url\(\s*["']?$/i
const CSS_DECLARATION_TAIL_RE = /[a-z-]+["']?\s*:\s*(?:[^;'"`{}<>]*[\s,(])?$/i

const blank = (text) => text.replace(/[^\r\n]/g, ' ')

function blankComments(text, mode) {
  if (mode === 'html') return text.replace(/<!--[\s\S]*?(?:-->|$)/g, blank)

  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '"' || c === "'" || (c === '`' && mode === 'js')) {
      let j = i + 1
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) {
        j += text[j] === '\\' ? 2 : 1
      }
      const end = text[j] === c ? j + 1 : Math.min(j, text.length)
      out += text.slice(i, end)
      i = end
    } else if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? text.length : close + 2
      out += blank(text.slice(i, end))
      i = end
    } else if (mode === 'js' && c === '/' && next === '/') {
      const newline = text.indexOf('\n', i)
      const end = newline === -1 ? text.length : newline
      out += blank(text.slice(i, end))
      i = end
    } else {
      out += c
      i += 1
    }
  }
  return out
}

function splitSegments(text, extension) {
  if (CSS_EXTENSIONS.has(extension)) return [{ mode: 'css', start: 0, end: text.length }]
  if (JS_EXTENSIONS.has(extension)) return [{ mode: 'js', start: 0, end: text.length }]

  const segments = []
  let cursor = 0
  for (const block of text.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const body = block[2]
    const closeLength = block[0].length - block[0].lastIndexOf('</')
    const start = block.index + block[0].length - closeLength - body.length
    if (start > cursor) segments.push({ mode: 'html', start: cursor, end: start })
    segments.push({
      mode: block[1].toLowerCase() === 'script' ? 'js' : 'css',
      start,
      end: start + body.length,
    })
    cursor = start + body.length
  }
  if (cursor < text.length) segments.push({ mode: 'html', start: cursor, end: text.length })
  return segments
}

function isHexColor(code, index, length, mode) {
  const before = code[index - 1]
  if (before !== undefined && /[\w&/.-]/.test(before)) return false

  const prefix = code.slice(Math.max(0, index - 200), index)
  if (URL_REF_RE.test(prefix)) return false

  if (mode === 'css') {
    const delimiter = /[;{}]/.exec(code.slice(index + length))
    return delimiter?.[0] !== '{'
  }

  if (HEX_ANCHOR_KEY_RE.test(prefix)) return false
  const quote = prefix.at(-1)
  if (quote && /["'`]/.test(quote) && code[index + length] === quote) return true
  return CSS_DECLARATION_TAIL_RE.test(prefix)
}

function* namedColorHits(code, mode) {
  for (const match of code.matchAll(NAMED_DECL_RE)) {
    if (mode === 'js' && !match[2]) continue
    const valueStart = match.index + match[0].length - match[3].length
    const value = match[3].replace(OPAQUE_FN_RE, blank)
    for (const word of value.matchAll(/(?<![\w-])[a-z]+(?![\w(-])/gi)) {
      if (NAMED_COLORS.has(word[0].toLowerCase())) {
        yield { index: valueStart + word.index, text: word[0], kind: 'named color' }
      }
    }
  }
}

function* segmentHits(code, mode) {
  for (const match of code.matchAll(HEX_RE)) {
    if (isHexColor(code, match.index, match[0].length, mode)) {
      yield { index: match.index, text: match[0], kind: 'hex color' }
    }
  }
  for (const match of code.matchAll(FUNCTIONAL_RE)) {
    yield { index: match.index, text: match[0].trimEnd(), kind: 'functional color' }
  }
  for (const match of code.matchAll(COLOR_FN_RE)) {
    yield { index: match.index, text: match[0].trimEnd(), kind: 'functional color' }
  }
  yield* namedColorHits(code, mode)
}

function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function positionOf(starts, index) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= index) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: index - starts[low] + 1 }
}

export function findHardcodedColors(source, filePath) {
  const extension = path.extname(filePath).toLowerCase()
  const starts = lineStarts(source)
  const hits = []
  for (const { mode, start, end } of splitSegments(source, extension)) {
    const code = blankComments(source.slice(start, end), mode)
    for (const hit of segmentHits(code, mode)) {
      hits.push({ ...hit, index: start + hit.index })
    }
  }
  return hits
    .sort((a, b) => a.index - b.index)
    .map(({ index, text, kind }) => ({ ...positionOf(starts, index), text, kind }))
}

export function isExcluded(relativePath) {
  const normalized = relativePath.split(path.sep).join('/')
  return (
    EXCLUDED_FILE_PATTERN.test(normalized) ||
    EXCLUDED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    normalized.split('/').some((segment) => EXCLUDED_DIR_NAMES.has(segment))
  )
}

const SCANNED_EXTENSIONS = new Set([...CSS_EXTENSIONS, ...JS_EXTENSIONS, ...MARKUP_EXTENSIONS])

async function* walk(root, relativePath) {
  if (isExcluded(relativePath)) return
  const absolute = path.join(root, relativePath)
  const info = await stat(absolute)
  if (info.isDirectory()) {
    const entries = (await readdir(absolute)).sort()
    for (const entry of entries) yield* walk(root, path.join(relativePath, entry))
  } else if (SCANNED_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    yield relativePath
  }
}

export async function scanProject({ root, scanRoots = DEFAULT_SCAN_ROOTS }) {
  const violations = []
  let filesScanned = 0
  for (const scanRoot of scanRoots) {
    const relativeRoot = path.normalize(scanRoot)
    // Un root ausente sería un falso "todo limpio" tras mover el renderer.
    await stat(path.join(root, relativeRoot)).catch(() => {
      throw new Error(`scan path not found: ${scanRoot}`)
    })
    for await (const file of walk(root, relativeRoot)) {
      filesScanned += 1
      const source = await readFile(path.join(root, file), 'utf8')
      for (const hit of findHardcodedColors(source, file)) {
        violations.push({ file: file.split(path.sep).join('/'), ...hit })
      }
    }
  }
  return { violations, filesScanned }
}

export function formatViolation({ file, line, column, kind, text }) {
  return `${file}:${line}:${column}  ${kind} "${text}": use a semantic token, e.g. var(--color-...), from @strata/design-tokens`
}

function parseArgs(argv, defaultRoot) {
  let root = defaultRoot
  const scanRoots = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      root = argv[i + 1]
      i += 1
      if (!root) throw new Error('--root requires a directory')
    } else if (argv[i].startsWith('--')) {
      throw new Error(`unknown option: ${argv[i]}`)
    } else {
      scanRoots.push(argv[i])
    }
  }
  return { root: path.resolve(root), scanRoots: scanRoots.length ? scanRoots : DEFAULT_SCAN_ROOTS }
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const { violations, filesScanned } = await scanProject(parseArgs(argv, repoRoot))
    if (violations.length === 0) {
      stdout.write(`check-hardcoded-colors: OK (${filesScanned} files scanned)\n`)
      return 0
    }
    stderr.write(`${violations.map(formatViolation).join('\n')}\n`)
    stderr.write(
      `check-hardcoded-colors: ${violations.length} hardcoded color(s) found. Colors must come from packages/design-tokens.\n`,
    )
    return 1
  } catch (error) {
    stderr.write(`check-hardcoded-colors: ${error.message}\n`)
    return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
