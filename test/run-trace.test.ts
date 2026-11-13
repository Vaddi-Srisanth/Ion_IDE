import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRunTrace, type RunTraceEvent } from '../src/main/run-console/trace'
import { InteractiveRunner } from '../src/main/run-console/engine'

const key = Symbol.for('ion.main.run-trace.v1')
const host = globalThis as typeof globalThis & { [key]?: (event: RunTraceEvent) => void }

test('run tracing is absent by default, bounded, monotonic and isolated from sink failures', () => {
  assert.equal(createRunTrace('inactive'), undefined)
  const events: RunTraceEvent[] = []
  host[key] = (event) => { events.push(event); if (events.length === 1) throw new Error('diagnostic only') }
  try {
    const trace = createRunTrace('correlation-1')!
    for (let index = 0; index < 3000; index++) trace('fixture', 'step', index)
    assert.equal(events.length, 2049)
    assert.equal(events.at(-1)?.event, 'limit')
    assert.ok(events.every((event, index) => event.id === 'correlation-1' && (!index || event.ms >= events[index - 1].ms)))
  } finally { delete host[key] }
})

test('a pending source validation is identified separately from compiler execution and can cancel safely', async () => {
  const events: RunTraceEvent[] = [], controller = new AbortController()
  host[key] = (event) => events.push(event)
  try {
    let settle!: (value: boolean) => void
    const current = new Promise<boolean>((resolve) => { settle = resolve })
    const runner = new InteractiveRunner('/never-executed')
    const job = runner.run({ language: 'c', cwd: '/', label: 'fixture', toolchain: 'fixture',
      compile: { executable: '/never-executed', args: [] }, run: { executable: '/never-executed', args: [] } },
    () => {}, controller.signal, () => current, createRunTrace('pending-source'))
    assert.equal(events.at(-1)?.stage, 'source-check-before-compile')
    assert.equal(events.at(-1)?.event, 'start')
    controller.abort(); settle(false)
    assert.equal((await job).status, 'cancelled')
    assert.equal(events.some((event) => event.stage === 'compile'), false)
    assert.equal(events.at(-1)?.event, 'cleanup')
  } finally { delete host[key] }
})
