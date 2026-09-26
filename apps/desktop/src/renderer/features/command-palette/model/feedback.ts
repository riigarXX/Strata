/** Un infinitivo castellano: «Ejecutar», «Cerrar», «Ir», «Formatear». */
const INFINITIVE = /^\p{L}*(?:ar|er|ir)$/iu

/**
 * Por qué un atajo no hizo nada: «No se puede ejecutar: …» si el título es una acción en infinitivo y
 * ««Pestaña siguiente» no está disponible: …» si es un nombre.
 */
export function describeBlocked(title: string, reason: string): string {
  const [first = ''] = title.split(' ')
  if (INFINITIVE.test(first)) {
    return `No se puede ${first.toLowerCase()}${title.slice(first.length)}: ${reason}`
  }
  return `«${title}» no está disponible: ${reason}`
}
