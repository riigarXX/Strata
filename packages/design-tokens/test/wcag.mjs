const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i

function channel(value) {
  const scaled = value / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex) {
  const match = typeof hex === 'string' ? HEX.exec(hex) : null
  if (!match) throw new Error(`Expected an opaque #RRGGBB color, got ${JSON.stringify(hex)}`)
  const [r, g, b] = match.slice(1).map((part) => channel(parseInt(part, 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}
