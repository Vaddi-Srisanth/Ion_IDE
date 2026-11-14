import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execute, defaultRunLimits } from '../src/main/runner'
import { InteractiveRunner } from '../src/main/run-console/engine'
import { createRunTrace, type RunTraceEvent } from '../src/main/run-console/trace'
import { configureWindowsProcessHelper, windowsEnvironment, windowsToolPaths } from '../src/main/windows-process'

// Real Node children exercise stream draining and ownership. This is not an
// Electron benchmark and Node exit callback timing is not an OS exit timestamp.
test('compiler trace reports real child IO, exit delivery, drain and cancellation without changing results', { timeout: 20_000 }, async (t) => {
  if (process.platform === 'win32') {
    const helper = process.env.ION_WINDOWS_PROCESS_TEST_HELPER
    assert.ok(helper, 'The native Windows fixture helper must be built, not mocked.')
    configureWindowsProcessHelper(helper)
  }
  const scratch = await mkdtemp(join(tmpdir(), 'ion-child-trace-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const key = Symbol.for('ion.main.run-trace.v1')
  const host = globalThis as typeof globalThis & { [key]?: (event: RunTraceEvent) => void }
  const previous = Object.getOwnPropertyDescriptor(host, key)
  let events: RunTraceEvent[] = []
  let activeId = ''
  Object.defineProperty(host, key, { configurable: true, value: (event: RunTraceEvent) => {
    // A failed spawn can deliver close after its promise settles. Never let a
    // prior request's late callback contaminate the next request's ordering.
    if (event.id === activeId) events.push(event)
  } })
  t.after(() => { if (previous) Object.defineProperty(host, key, previous); else delete host[key] })
  const environment = process.platform === 'win32' ? windowsEnvironment(windowsToolPaths()) : process.env
  const initialLimits = { ...defaultRunLimits }
  let next = 0
  function job(source: string, controller = new AbortController(), trace = true, output?: (text: string) => void, executable = process.execPath) {
    events = []
    activeId = 'real-child-' + next++
    const request = trace ? createRunTrace(activeId) : undefined
    return execute(executable, ['-e', source], {
      cwd: scratch, input: '', signal: controller.signal, timeoutMs: 3000,
      budget: { remaining: 8192 }, environment, splitOutput: true, onOutput: output, trace: request,
    })
  }
  function position(stage: string, event: string) {
    const index = events.findIndex((entry) => entry.stage === stage && entry.event === event)
    assert.ok(index >= 0, 'Missing ' + stage + '/' + event + ': ' + JSON.stringify(events))
    return index
  }
  function completed() {
    assert.ok(position('compiler-command', 'constructed') < position('compiler-process', 'spawn-request'))
    assert.ok(position('compiler-process', 'spawn-request') < position('compiler-process', 'spawned'))
    assert.ok(position('compiler-process', 'spawned') < position('compiler-process', 'exit'))
    assert.ok(position('compiler-process', 'exit') < position('compiler-process', 'exit-callback'))
    assert.ok(position('compiler-process', 'exit') < position('compiler-process', 'close'))
    assert.ok(position('compiler-process', 'close') < position('compiler-process', 'result-finalized'))
    assert.ok(events.every((entry, index) => !index || entry.ms >= events[index - 1].ms))
    assert.equal(events.filter((entry) => entry.event === 'result-finalized').length, 1)
  }
  await t.test('separate stdout/stderr first and last callback-entry clocks survive full draining', async () => {
    const source = 'process.stdout.write("OUT-a");process.stderr.write("ERR-a");setTimeout(()=>{process.stdout.write("OUT-b");process.stderr.write("ERR-b")},30)'
    const result = await job(source)
    assert.equal(result.state, 'exited'); assert.equal(result.exitCode, 0); assert.equal(result.outputComplete, true)
    assert.equal(result.stdout, 'OUT-aOUT-b'); assert.equal(result.stderr, 'ERR-aERR-b')
    completed()
    for (const stream of ['stdout', 'stderr']) {
      const first = events[position('compiler-' + stream, 'first-callback')]
      const last = events[position('compiler-' + stream, 'last-callback')]
      assert.equal(typeof first.value, 'number'); assert.equal(typeof last.value, 'number')
      assert.ok((last.value as number) >= (first.value as number))
      assert.ok(position('compiler-' + stream, 'first-callback') < position('compiler-' + stream, 'end'))
      assert.equal(events.filter((entry) => entry.stage === 'compiler-' + stream && entry.event === 'last-callback').length, 1)
    }
    assert.equal(events.some((entry) => /OUT-|ERR-|ion-child-trace/.test(JSON.stringify(entry))), false)
    const traced = { state: result.state, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, outputComplete: result.outputComplete }
    const plain = await job(source, undefined, false)
    assert.deepEqual({ state: plain.state, exitCode: plain.exitCode, stdout: plain.stdout, stderr: plain.stderr, outputComplete: plain.outputComplete }, traced)
    assert.deepEqual(events, [])
  })
  await t.test('silent successful child records stream ends without inventing output callbacks', async () => {
    const result = await job('')
    assert.equal(result.state, 'exited'); assert.equal(result.output, '')
    completed()
    position('compiler-stdout', 'end'); position('compiler-stderr', 'end')
    assert.equal(events.some((entry) => entry.event === 'first-callback' || entry.event === 'last-callback'), false)
  })
  await t.test('spawn error finalizes once without manufacturing exit or successful draining', async () => {
    const result = await job('', undefined, true, undefined, join(scratch, 'missing-command'))
    // On Windows the helper itself launches, then reports missing payload; on
    // POSIX Node emits the spawn error directly. Both must settle honestly.
    assert.notEqual(result.state === 'exited' && result.exitCode === 0, true)
    position('compiler-process', 'result-finalized')
    assert.equal(events.filter((entry) => entry.event === 'result-finalized').length, 1)
    if (process.platform !== 'win32') {
      position('compiler-process', 'error-callback')
      assert.equal(events.some((entry) => entry.event === 'spawned'), false)
    }
  })
  await t.test('Stop kills and drains a real waiting child after output and preserves output', async () => {
    const controller = new AbortController()
    const result = await job('process.stdout.write("READY");setInterval(()=>{},1000)', controller, true,
      (text) => { if (text.includes('READY')) controller.abort() })
    assert.equal(result.state, 'cancelled'); assert.equal(result.output, 'READY')
    position('compiler-process', 'stop'); position('compiler-process', 'cleanup')
    completed()
    const pid = events.find((entry) => entry.event === 'spawned')?.value
    assert.equal(typeof pid, 'number')
    assert.throws(() => process.kill(pid as number, 0), { code: 'ESRCH' })
  })
  await t.test('engine publish callback boundaries include compile failure and cannot launch the program', async () => {
    events = []
    activeId = 'engine-failed-compile'
    const runner = new InteractiveRunner('/never-used')
    const updates: string[] = []
    const result = await runner.run({ language: 'c', cwd: scratch, label: 'fixture', toolchain: 'fixture',
      compile: { executable: process.execPath, args: ['-e', 'process.stderr.write("BAD");process.exitCode=2'] },
      run: { executable: '/never-used', args: [] } }, (event) => { updates.push(event.kind) },
    new AbortController().signal, undefined, createRunTrace('engine-failed-compile'))
    assert.equal(result.status, 'compile-error'); assert.equal(result.exitCode, 2); assert.match(result.compileOutput, /BAD/)
    assert.equal(events.some((entry) => entry.stage === 'program' && entry.event === 'launch-requested'), false)
    const starts = events.filter((entry) => entry.stage === 'publish-run-console' && entry.event === 'dispatch-start')
    const ends = events.filter((entry) => entry.stage === 'publish-run-console' && entry.event === 'dispatch-end')
    assert.equal(starts.length, updates.length); assert.equal(ends.length, updates.length)
    assert.ok(starts.length >= 2)
  })
  assert.deepEqual(defaultRunLimits, initialLimits)
})
