#!/usr/bin/env node
// Genera el icono PROVISIONAL de la app (una «S» geométrica sobre el fondo de marca) a partir de los
// primitivos de @strata/design-tokens: `build/icon.svg` (fuente) y `build/icon.icns` (lo que consume
// electron-builder). Sustituir por el icono definitivo cuando exista diseño de marca.
//
// Solo macOS (usa `sips` e `iconutil`, herramientas del sistema; sin dependencias nuevas).
// Uso: pnpm --filter @strata/desktop icon
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const buildDir = dirname(fileURLToPath(import.meta.url))
const tokensPath = join(buildDir, '../../../packages/design-tokens/tokens/primitives.json')
const { color } = JSON.parse(readFileSync(tokensPath, 'utf8'))
const background = color.slate['900'].$value
const foreground = color.green['500'].$value

// Rejilla de iconos de macOS: cuerpo de 824 px con margen de 100 px sobre un lienzo de 1024 px.
const CANVAS = 1024
const BODY = 824
const MARGIN = (CANVAS - BODY) / 2
const BODY_RADIUS = 185

// La «S» son dos semicircunferencias tangentes trazadas con extremos redondeados.
const RADIUS = 110
const STROKE = 96
const CENTER_X = CANVAS / 2
const UPPER_CENTER_Y = CANVAS / 2 - RADIUS
const LOWER_CENTER_Y = CANVAS / 2 + RADIUS
const TERMINAL_OFFSET = RADIUS * Math.SQRT1_2
const round = (value) => Math.round(value * 10) / 10

const startX = round(CENTER_X + TERMINAL_OFFSET)
const startY = round(UPPER_CENTER_Y - TERMINAL_OFFSET)
const endX = round(CENTER_X - TERMINAL_OFFSET)
const endY = round(LOWER_CENTER_Y + TERMINAL_OFFSET)
const path =
  `M ${startX} ${startY} ` +
  `A ${RADIUS} ${RADIUS} 0 1 0 ${CENTER_X} ${CANVAS / 2} ` +
  `A ${RADIUS} ${RADIUS} 0 1 1 ${endX} ${endY}`

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <rect x="${MARGIN}" y="${MARGIN}" width="${BODY}" height="${BODY}" rx="${BODY_RADIUS}" fill="${background}"/>
  <path d="${path}" fill="none" stroke="${foreground}" stroke-width="${STROKE}" stroke-linecap="round"/>
</svg>
`

// Tamaños base del .iconset de Apple; cada uno tiene su variante @2x.
const ICONSET_SIZES = [16, 32, 128, 256, 512]

const workDir = mkdtempSync(join(tmpdir(), 'strata-icon-'))
try {
  const svgPath = join(buildDir, 'icon.svg')
  writeFileSync(svgPath, svg)

  const iconset = join(workDir, 'icon.iconset')
  mkdirSync(iconset)
  const master = join(workDir, 'master.png')
  execFileSync('sips', ['-s', 'format', 'png', svgPath, '--out', master], { stdio: 'ignore' })

  for (const size of ICONSET_SIZES) {
    for (const scale of [1, 2]) {
      const pixels = size * scale
      const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`
      execFileSync(
        'sips',
        ['-z', String(pixels), String(pixels), master, '--out', join(iconset, name)],
        {
          stdio: 'ignore',
        },
      )
    }
  }

  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
