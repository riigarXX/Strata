/** Anuncio del número de resultados del filtro; `null` sin filtro activo. */
export function describeMatches(matches: number | null, pending: number, query: string): string {
  if (matches === null) return ''
  const searching = pending > 0 ? ' Aún se están cargando más esquemas.' : ''
  if (matches === 0)
    return pending > 0 ? `Buscando «${query.trim()}»…` : `Sin resultados para «${query.trim()}».`
  return `${matches} ${matches === 1 ? 'resultado' : 'resultados'}.${searching}`
}
