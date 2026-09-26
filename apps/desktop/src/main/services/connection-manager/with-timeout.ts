import { managerError } from './errors'

/**
 * Rechaza con un error `timeout` normalizado si `task` no termina a tiempo. Si termina después,
 * `onLateValue` recibe el resultado para que el llamador libere lo que haya abierto (p. ej. una sesión).
 */
export function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string,
  onLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      reject(managerError('timeout', message))
    }, timeoutMs)

    task.then(
      (value) => {
        if (expired) {
          onLateValue?.(value)
          return
        }
        clearTimeout(timer)
        resolve(value)
      },
      (reason: unknown) => {
        if (expired) return
        clearTimeout(timer)
        reject(reason)
      },
    )
  })
}
