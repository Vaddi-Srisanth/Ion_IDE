import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify, stripVTControlCharacters } from 'node:util'
import { InteractiveRunner } from '../src/main/run-console/engine'
import { startPty } from '../src/main/run-console/pty'
import { TerminalService } from '../src/main/terminal/service'
import { windowsEnvironment, windowsSystemDirectory, windowsToolPaths } from '../src/main/windows-process'
import type { TerminalEvent } from '../src/shared/terminal'

async function until<T>(read: () => T, message: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + 8_000
  do {
    const value = read()
    if (value) return value
    await sleep(20)
  } while (performance.now() < deadline)
  assert.fail(message)
}

const skip = process.platform !== 'win32'
const helper = resolve(process.env.ION_WINDOWS_PTY_EXE ?? process.env.ION_WINDOWS_PROCESS_TEST_HELPER ?? 'dist/native/ion-pty.exe')

test('Windows Run Console uses ConPTY for TTY, resize, Unicode argv and interactive input', { skip, timeout: 25_000 }, async (t) => {
  await access(helper)
  const directory = await mkdtemp(join(tmpdir(), 'ion-pty-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const workspace = join(directory, 'workspace λ with spaces')
  await mkdir(workspace)
  const script = join(workspace, 'test λ.cjs')
  await writeFile(script, String.raw`
    const assert = require('node:assert/strict');
    const path = require('node:path');
    assert.ok(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
    assert.equal(path.basename(process.cwd()), 'workspace λ with spaces');
    assert.deepEqual(process.argv.slice(2), ['with space', 'ends with \\', '"quotes"', 'λ 文', '']);
    const input = require('node:readline').createInterface({ input: process.stdin, terminal: false });
    input.once('line', async (line) => {
      const sleep = require('node:timers/promises').setTimeout;
      const deadline = performance.now() + 3000;
      const size = [0, 0];
      assert.equal(process.stdout._handle.getWindowSize(size), 0);
      // Windows applies the resize on a separate ConPTY control channel.
      // Node's public getWindowSize() just returns its cached columns and rows.
      while ((size[0] !== 100 || size[1] !== 35) && performance.now() < deadline) {
        await sleep(15);
        assert.equal(process.stdout._handle.getWindowSize(size), 0);
      }
      process.stdout.write('ION_INPUT:' + line + ':SIZE:' + size.join('x') + '\n');
      process.stderr.write('ION_STDERR\n');
      input.close();
      process.stdin.destroy();
      process.exitCode = 7;
    });
    process.stdout.write('ION_READY\n');
  `)
  let transcript = ''
  let sent = false
  const session = startPty({
    helper, executable: process.execPath, args: [script, 'with space', 'ends with \\', '"quotes"', 'λ 文', ''],
    cwd: workspace, environment: windowsEnvironment(windowsToolPaths(), directory),
    columns: 80, rows: 24, signal: new AbortController().signal, timeoutMs: 12_000, budget: { remaining: 64 * 1024 },
    ready() {},
    onOutput(text) {
      transcript += text
      if (!sent && stripVTControlCharacters(transcript).includes('ION_READY')) {
        sent = true
        session.resize(100, 35)
        session.input('Hello λ\r')
      }
    },
  })
  const result = await session.result
  const output = stripVTControlCharacters(transcript)
  assert.equal(result.state, 'exited', result.detail ?? 'ConPTY transcript: ' + JSON.stringify(transcript))
  assert.equal(result.exitCode, 7, output)
  assert.equal(result.outputComplete, true, output)
  assert.match(output, /ION_INPUT:Hello λ:SIZE:100x35/)
  assert.match(output, /ION_STDERR/)
})

test('Windows ConPTY forwards control input to the program', { skip, timeout: 25_000 }, async (t) => {
  await access(helper)
  const directory = await mkdtemp(join(tmpdir(), 'ion-pty-input-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const options = {
    helper, executable: process.execPath, cwd: directory,
    environment: windowsEnvironment(windowsToolPaths(), directory),
    columns: 80, rows: 24, signal: new AbortController().signal, timeoutMs: 8_000,
    ready() {},
  }

  for (const raw of [true, false]) {
    let output = ''
    let sent = false
    const code = raw
      ? "process.stdin.setRawMode(true).once('data', data => process.stdout.write('ION_RAW:' + data.toString('hex') + '\\n', () => process.exit(0)));"
      : "process.once('SIGINT', () => process.stdout.write('ION_INTERRUPT\\n', () => process.exit(0)));"
    const session = startPty({
      ...options, budget: { remaining: 64 * 1024 },
      args: ['-e', code + " console.log('ION_READY'); setInterval(() => {}, 5000);"],
      onOutput(text) {
        output += text
        if (!sent && stripVTControlCharacters(output).includes('ION_READY')) {
          sent = true
          session.input('\x03')
        }
      },
    })
    const result = await session.result
    const transcript = stripVTControlCharacters(output)
    assert.equal(result.state, 'exited', result.detail ?? 'ConPTY transcript: ' + JSON.stringify(output))
    assert.equal(result.exitCode, 0, transcript)
    assert.match(transcript, raw ? /ION_RAW:03/ : /ION_INTERRUPT/)
  }
})

test('Windows ConPTY bounds busy program output and execution time', { skip, timeout: 25_000 }, async (t) => {
  await access(helper)
  const directory = await mkdtemp(join(tmpdir(), 'ion-pty-limits-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const options = {
    helper, executable: process.execPath, cwd: directory,
    environment: windowsEnvironment(windowsToolPaths(), directory),
    columns: 80, rows: 24, signal: new AbortController().signal,
    ready() {},
  }

  let bytes = 0
  const capped = await startPty({
    ...options, budget: { remaining: 2048 }, timeoutMs: 8_000,
    args: ['-e', "let i = 0; setInterval(() => console.log(i++, 'abcd '.repeat(100)), 10);"],
    onOutput(text) { bytes += Buffer.byteLength(text) },
  }).result
  assert.equal(capped.state, 'output-limit')
  assert.equal(capped.outputComplete, false)
  assert.equal(bytes, 2048)

  const timed = await startPty({
    ...options, budget: { remaining: 2048 }, timeoutMs: 1_000,
    args: ['-e', 'setInterval(() => {}, 5000);'],
    onOutput() {},
  }).result
  assert.equal(timed.state, 'timeout')
})

test('Windows terminal launches in the workspace and explicit close cleans up a detached child', { skip, timeout: 30_000 }, async (t) => {
  await access(helper)
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ion shell ')))
  const script = join(workspace, 'job.cjs')
  await writeFile(script, String.raw`
    const { spawn } = require('node:child_process');
    const job = spawn(process.execPath, ['-e', 'setInterval(() => {}, 5000)'], { detached: true, stdio: 'ignore' });
    console.log('ION_JOB:' + job.pid);
    setInterval(() => {}, 5000);
  `)
  const directoryCommand = 'echo ION-WORKSPACE:%CD%'
  const listCommand = 'dir /b *.cjs'
  const output = new Map<string, string>()
  const events: TerminalEvent[] = []
  const terminal = new TerminalService(helper, (event) => {
    events.push(event)
    if (event.kind !== 'data') return
    output.set(event.id, (output.get(event.id) ?? '') + event.text)
    terminal.ack(event.id, event.sequence)
  })
  t.after(async () => {
    await terminal.closeAll()
    await rm(workspace, { force: true, recursive: true })
  })
  const { stdout: standalone } = await promisify(execFile)(join(windowsSystemDirectory, 'cmd.exe'),
    ['/D', '/Q', '/S', '/C', directoryCommand + '&' + listCommand],
    { cwd: workspace, windowsHide: true, timeout: 5000 })
  const expected = standalone.trim().split(/\r?\n/)
  assert.equal(expected[0].toLowerCase(), ('ION-WORKSPACE:' + workspace).toLowerCase())
  assert.equal(expected[1], 'job.cjs')
  const first = await terminal.create(workspace, 100, 30)
  assert.match(first.title, /^cmd\.exe$/i)
  const second = await terminal.create(workspace, 100, 30)
  assert.notEqual(first.id, second.id)
  assert.equal(events.length, 0)
  terminal.attach(first.id)
  terminal.attach(second.id)
  await terminal.input(first.id, directoryCommand)
  await terminal.input(first.id, '\r')
  await until(() => stripVTControlCharacters(output.get(first.id) ?? '').toLowerCase()
    .includes(expected[0].toLowerCase()), 'Command Prompt did not print its active workspace.')
  await terminal.input(first.id, listCommand + '\r')
  await until(() => stripVTControlCharacters(output.get(first.id) ?? '').includes(expected[1]), 'Command Prompt did not list the fixture.')
  await terminal.input(first.id, '"' + process.execPath + '" .\\job.cjs')
  await terminal.input(first.id, '\r')
  const child = await until(() => {
    const match = /ION_JOB:(\d+)/.exec(stripVTControlCharacters(output.get(first.id) ?? ''))
    return match ? Number(match[1]) : null
  }, 'Shell did not start the workspace script: ' + stripVTControlCharacters(output.get(first.id) ?? ''))
  assert.doesNotThrow(() => process.kill(child, 0))
  await terminal.close(first.id)
  await until(() => {
    try { process.kill(child, 0); return false } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }, 'ConPTY Job Object left a descendant running')
  await terminal.input(second.id, 'exit 19\r')
  const exit = await until(() => events.find((event): event is Extract<TerminalEvent, { kind: 'exit' }> =>
    event.kind === 'exit' && event.id === second.id), 'Second shell stopped responding')
  assert.equal(exit.code, 19, exit.detail)
})

test('Windows Run Console falls back to line input if the installed helper is absent', { skip, timeout: 15_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ion-pty-fallback-'))
  t.after(() => rm(cwd, { force: true, recursive: true }))
  const runner = new InteractiveRunner(join(cwd, 'missing-ion-pty.exe'), { compileMs: 5000, programMs: 5000, outputBytes: 4096 })
  let transcript = ''
  const result = await runner.run({
    cwd, label: 'JavaScript', language: 'javascript', toolchain: process.execPath,
    run: { executable: process.execPath, args: ['-e', "process.stdin.once('data', data => process.stdout.write('ION_FALLBACK:' + data));"] },
  }, (event) => {
    if (event.kind === 'phase' && event.phase === 'running') {
      runner.input('value\r')
      runner.input('\x04')
    }
    if (event.kind === 'data') transcript += event.text
  }, new AbortController().signal)
  assert.equal(result.status, 'success', result.message)
  assert.match(transcript, /Windows pseudoconsole unavailable/)
  assert.match(transcript, /ION_FALLBACK:value/)
})
