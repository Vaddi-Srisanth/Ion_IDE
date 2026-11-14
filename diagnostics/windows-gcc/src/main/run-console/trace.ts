// Main-process diagnostic hook. No renderer API, environment switch, logging,
// timers or retained events are created during ordinary use.
export interface RunTraceEvent {
  id: string
  ms: number
  stage: string
  event: string
  value?: number | string | boolean | null
}

export type RunTrace = (stage: string, event: string, value?: RunTraceEvent['value']) => void
const sinkKey = Symbol.for('ion.main.run-trace.v1')
const limit = 2048

export function createRunTrace(id: string): RunTrace | undefined {
  const sink = (globalThis as typeof globalThis & { [sinkKey]?: (event: RunTraceEvent) => void })[sinkKey]
  if (typeof sink !== 'function') return undefined
  const started = performance.now()
  let count = 0
  return (stage, event, value) => {
    if (count > limit) return
    const overflow = count++ === limit
    try {
      sink({ id, ms: performance.now() - started, stage: overflow ? 'trace' : stage,
        event: overflow ? 'limit' : event, value: overflow ? limit : value })
    } catch { /* Diagnostics cannot change the run outcome. */ }
  }
}
