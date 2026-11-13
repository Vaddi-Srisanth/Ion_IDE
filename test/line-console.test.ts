import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { InteractiveRunner } from '../src/main/run-console/engine'
import { startLineConsole } from '../src/main/run-console/line-console'
import { windowsEnvironment, windowsToolPaths } from '../src/main/windows-process'

const environment = process.platform === 'win32' ? windowsEnvironment(windowsToolPaths()) : {}

test('pipe console exchanges interactive input with a real local process', { timeout: 5000 }, async () => {
  const events = new EventEmitter()
  let output = ''
  const terminal = startLineConsole({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("Name? "); process.stdin.on("data", (data) => process.stdout.write("Received: " + data));'],
    cwd: process.cwd(), environment, signal: new AbortController().signal,
    timeoutMs: 3000, budget: { remaining: 4096 },
    ready() {},
    onOutput(text) {
      output += text
      if (text.includes('Name?')) events.emit('prompt')
    },
  })
  await once(events, 'prompt')
  terminal.input('IoX\x7fn\r')
  terminal.input('\x04')
  const result = await terminal.result
  assert.equal(result.state, 'exited')
  assert.equal(result.exitCode, 0)
  assert.equal(result.outputComplete, true)
  assert.match(output, /Received: Ion\r\n/)
})

test('pipe console stops running code on interrupt and bounds program output', { timeout: 5000 }, async () => {
  const start = (script: string, ready: () => void, output: (text: string) => void) => startLineConsole({
    executable: process.execPath, args: ['-e', script], cwd: process.cwd(), environment,
    signal: new AbortController().signal, timeoutMs: 3000, budget: { remaining: 16 },
    ready, onOutput: output,
  })
  const events = new EventEmitter()
  const waiting = start('setInterval(() => {}, 100);', () => events.emit('ready'), () => {})
  await once(events, 'ready')
  waiting.input('\x03')
  assert.equal((await waiting.result).state, 'cancelled')
  let output = ''
  const noisy = start('process.stdout.write("X".repeat(1000000));', () => {}, (text) => { output += text })
  const limited = await noisy.result
  assert.equal(limited.state, 'output-limit')
  assert.equal(limited.outputComplete, false)
  assert.equal(output, 'X'.repeat(16))
})

test('line input rejects an oversized paste without changing its existing input', { timeout: 5000 }, async () => {
  const events = new EventEmitter()
  let output = ''
  const terminal = startLineConsole({
    executable: process.execPath, args: ['-e', 'process.stdin.on("data",data=>process.stdout.write("Received:"+data));'],
    cwd: process.cwd(), environment, signal: new AbortController().signal,
    timeoutMs: 3000, budget: { remaining: 4096 }, ready() { events.emit('ready') },
    onOutput(text) { output += text },
  })
  await once(events, 'ready')
  terminal.input('pre')
  assert.throws(() => terminal.input('x'.repeat(16 * 1024)), /Input was not sent/)
  terminal.input('fix\r\x04')
  assert.equal((await terminal.result).exitCode, 0)
  assert.match(output, /Received:prefix\r\n/)
  assert.doesNotMatch(output, /xxx/)
})

test('Windows Run Console stops the process tree', { skip: process.platform !== 'win32', timeout: 10_000 }, async (t) => {
  const controller = new AbortController()
  const cwd = await mkdtemp(join(tmpdir(), 'ion-line-stop-'))
  t.after(async () => {
    controller.abort()
    await rm(cwd, { recursive: true, force: true })
  })
  const events = new EventEmitter()
  const child = `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore', windowsHide: true });
    worker.once('spawn', () => process.stdout.write('ION_WORKER_PID:' + worker.pid + '\\n'));
    setInterval(() => {}, 1000);
  `
  let output = ''
  const runner = new InteractiveRunner(join(cwd, 'missing-ion-pty.exe'), { compileMs: 5000, programMs: 5000, outputBytes: 4096 })
  const running = runner.run({
    cwd, language: 'javascript', label: 'process tree test', toolchain: process.execPath,
    run: { executable: process.execPath, args: ['-e', child], environment },
  }, (event) => {
    if (event.kind !== 'data') return
    output += event.text
    const pid = /ION_WORKER_PID:(\d+)\r?\n/.exec(output)?.[1]
    if (pid) events.emit('pid', Number(pid))
  }, controller.signal)
  const pid = await Promise.race([
    once(events, 'pid').then(([pid]) => Number(pid)),
    running.then((result) => assert.fail(`Worker did not start (${result.status}): ${output}`)),
  ])
  try {
    assert.match(output, /Using line input/)
    assert.doesNotThrow(() => process.kill(pid, 0), 'The worker is alive before cancellation.')
    controller.abort()
    assert.equal((await running).status, 'cancelled')
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
        throw error
      }
      await delay(50)
    }
    assert.fail('The child process survived cancellation')
  } finally {
    controller.abort()
    try { process.kill(pid, 'SIGKILL') } catch { /* The child already exited. */ }
  }
})
