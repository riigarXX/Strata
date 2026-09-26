import { shallowRef } from 'vue'

export interface SchemaTarget {
  schema: string
  /** Si se indica, se expande la tabla para mostrar sus columnas, claves e índices. */
  table?: string
}

/** Lo que el explorador de esquema ofrece al resto de la aplicación (comandos `\schemas`, `\tables`, `\describe`). */
export interface SchemaPort {
  /**
   * Quita el filtro, expande el nodo indicado con lo que ya hay en la caché (cargando sus hijos si hace
   * falta) y lleva el foco a él. Sin destino, el foco va al árbol. `false` si no hay nada a lo que ir.
   */
  reveal(target: SchemaTarget | null): Promise<boolean>
}

const current = shallowRef<SchemaPort | null>(null)

export function registerSchemaPort(port: SchemaPort): () => void {
  current.value = port
  return () => {
    if (current.value === port) current.value = null
  }
}

export function currentSchemaPort(): SchemaPort | null {
  return current.value
}
