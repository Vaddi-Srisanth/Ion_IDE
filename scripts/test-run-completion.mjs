import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { installBenchmarkRun } from './run-completion.mjs'

function fixture() {
  let now = 0, callback, ipc, unsubscribed = false, disconnected = false, sequence = 0
  const timers = new Map(), output = { phase: 'idle', status: '', textContent: '', rows: [] }
  output.getAttribute = (name) => output[name.replace('data-', '')]
  output.querySelectorAll = () => output.rows.map((textContent) => ({ textContent }))
  const context = { window: {}, performance: { now: () => now }, Promise,
    document: { body: {}, querySelector: () => output },
    MutationObserver: class { constructor(fn) { callback = fn } observe() {} disconnect() { disconnected = true } },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id },
    clearTimeout(id) { timers.delete(id) },
  }
  context.window.ion = { runConsole: { onUpdate(fn) { ipc = fn; return () => { unsubscribed = true } } } }
  vm.runInNewContext(`(${installBenchmarkRun.toString()})({preparing:150,compiling:190,running:350,expectedMarker:'ION-DESKTOP-RUN-OK'})`, context)
  return { context, timers, get disconnected() { return disconnected }, get unsubscribed() { return unsubscribed },
    ipc(id, update) { ipc({ id, update }) },
    change(phase, status = '', text = '', rows = [text]) { Object.assign(output,
      { phase, status, textContent: text, rows }); callback() },
    complete(status, text) {
      if (status === 'success') ipc({ id: 'run-1', update: { kind: 'data', stream: 'terminal', text } })
      ipc({ id: 'run-1', update: { kind: 'complete' } }); Object.assign(output,
        { phase: 'finished', status, textContent: text, rows: [text] }); callback()
    },
    advance(ms) {
      now += ms
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn() }
    },
  }
}

test('compile near its limit followed by program startup is not an overall-deadline timeout', async () => {
  const f = fixture()
  f.change('preparing'); f.advance(140)
  f.change('compiling'); f.advance(185)
  f.change('running'); f.advance(200)
  f.complete('success', 'ION-DESKTOP-RUN-OK')
  const result = await f.context.window.ionBenchmarkRunCompletion
  assert.equal(result.status, 'success')
  assert.equal(result.elapsedMs, 525)
  assert.equal(f.timers.size, 0)
  assert.equal(f.disconnected, true)
  assert.equal(f.unsubscribed, true)
})

test('IPC correlation survives coalesced DOM phases and ignores other run IDs', async () => {
  const f = fixture()
  f.ipc('run-1', { kind: 'phase', phase: 'preparing' }); f.advance(140)
  f.ipc('run-1', { kind: 'phase', phase: 'compiling' }); f.advance(180)
  f.ipc('other-run', { kind: 'phase', phase: 'running' })
  f.ipc('run-1', { kind: 'phase', phase: 'running' }); f.advance(100)
  f.ipc('run-1', { kind: 'data', stream: 'terminal', text: 'ION-DESKTOP-RUN-OK' })
  f.ipc('run-1', { kind: 'complete' })
  f.change('finished', 'success', 'ION-DESKTOP-RUN-OK')
  assert.equal((await f.context.window.ionBenchmarkRunCompletion).status, 'success')
  assert.equal(f.unsubscribed, true)
})

test('compile error settles immediately instead of becoming a success-only timeout', async () => {
  const f = fixture()
  f.change('compiling'); f.advance(1); f.complete('compile-error', 'expected semicolon')
  const result = await f.context.window.ionBenchmarkRunCompletion
  assert.equal(result.status, 'compile-error')
  assert.equal(result.elapsedMs, 1)
  assert.equal(f.timers.size, 0)
})

test('repeated output mutations do not reset a stalled stage watchdog', async () => {
  const f = fixture()
  f.change('compiling'); f.advance(100); f.change('compiling'); f.advance(90)
  const result = await f.context.window.ionBenchmarkRunCompletion
  assert.equal(result.failure, 'Run watchdog expired')
  assert.equal(result.phase, 'compiling')
})

test('cleanup disposes observer and timer even when clicking Run fails', async () => {
  const f = fixture(), promise = f.context.window.ionBenchmarkRunCompletion
  f.context.window.ionBenchmarkRunCleanup()
  assert.equal((await promise).failure, 'Run observation cancelled')
  assert.equal(f.timers.size, 0)
  assert.equal(f.disconnected, true)
  assert.equal(f.context.window.ionBenchmarkRunCompletion, undefined)
})

test('an old rendered result cannot finish the new run before correlated IPC completion', async () => {
  const f = fixture()
  f.ipc('run-1', { kind: 'phase', phase: 'preparing' })
  f.change('finished', 'success', 'old result')
  assert.equal(f.disconnected, false)
  f.ipc('other-run', { kind: 'complete' })
  f.change('finished', 'success', 'old result')
  assert.equal(f.disconnected, false)
  f.complete('compile-error', 'new result')
  assert.equal((await f.context.window.ionBenchmarkRunCompletion).status, 'compile-error')
})

test('finished status waits for real terminal paint after correlated output, ignoring style text', async () => {
  const f = fixture()
  f.ipc('run-1', { kind: 'phase', phase: 'preparing' })
  f.ipc('run-1', { kind: 'phase', phase: 'running' })
  f.ipc('run-1', { kind: 'data', stream: 'terminal', text: 'ION-DESKTOP-' })
  f.ipc('run-1', { kind: 'data', stream: 'terminal', text: 'RUN-OK\r\n' })
  f.ipc('run-1', { kind: 'complete' })
  f.change('finished', 'success', '<style>ION-DESKTOP-RUN-OK</style>', [])
  assert.equal(f.disconnected, false)
  f.advance(20)
  f.change('finished', 'success', '<style>irrelevant</style>', ['ION-DESKTOP-RUN-OK'])
  const result = await f.context.window.ionBenchmarkRunCompletion
  assert.equal(result.status, 'success')
  assert.equal(result.text, 'ION-DESKTOP-RUN-OK')
  assert.equal(result.elapsedMs, 20)
})

test('success without correlated expected output fails promptly instead of waiting for paint', async () => {
  const f = fixture()
  f.ipc('run-1', { kind: 'phase', phase: 'preparing' })
  f.ipc('other-run', { kind: 'data', stream: 'terminal', text: 'ION-DESKTOP-RUN-OK' })
  f.ipc('run-1', { kind: 'complete' })
  f.change('finished', 'success', 'ION-DESKTOP-RUN-OK')
  const result = await f.context.window.ionBenchmarkRunCompletion
  assert.equal(result.failure, 'Program completed without the expected terminal output')
  assert.equal(result.elapsedMs, 0)
  assert.equal(f.timers.size, 0)
})
