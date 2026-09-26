import v8 from 'node:v8'
import vm from 'node:vm'

v8.setFlagsFromString('--expose-gc')
const collectGarbage = vm.runInNewContext('gc') as () => void

// Memory that is still reachable right now (JS heap plus Buffers/ArrayBuffers).
// Tests use it to show that what a query streams through does not stay alive, whatever the size of the cells.
// Two collections around a tick let the finalizers of native buffers run, so successive readings are comparable.
export async function liveBytes(): Promise<number> {
  collectGarbage()
  await new Promise((resolve) => setImmediate(resolve))
  collectGarbage()
  const { heapUsed, external } = process.memoryUsage()
  return heapUsed + external
}
