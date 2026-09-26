/** Reloj y temporizador inyectables: los tests avanzan el tiempo a mano en vez de esperar. */
export interface Clock {
  now(): number
  /** Ejecuta `task` cada `intervalMs` sin mantener vivo el proceso; devuelve la función que lo cancela. */
  every(intervalMs: number, task: () => void): () => void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  every(intervalMs, task) {
    const timer = setInterval(task, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  },
}
