import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { startPty } from '../src/main/run-console/pty'

const execute = promisify(execFile)

test('native Run Console owns a real terminal and cleans up after a run', { skip: process.platform !== 'darwin' }, async (t) => {
  if (!await execute('/usr/bin/xcode-select', ['-p']).then(() => true, () => false)) {
    t.skip('Apple Command Line Tools are unavailable.')
    return
  }
  const scratch = await mkdtemp(join(tmpdir(), 'ion-pty-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const helper = join(scratch, 'ion-pty')
  await execute('/usr/bin/xcrun', ['clang', '-std=c11', '-D_DARWIN_C_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror',
    resolve('src/main/run-console/pty-helper.c'), '-o', helper])

  const options = {
    helper, executable: '/bin/sh', cwd: scratch, environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    columns: 80, rows: 24, signal: new AbortController().signal, timeoutMs: 3_000,
    ready: () => {}, onOutput: () => {},
  }

  await t.test('real tty input, Unicode echo, terminal resize and both output streams', async () => {
    let stream = ''
    let prompted = false
    let ready = false
    const session = startPty({
      ...options, budget: { remaining: 8192 },
      args: ['-c', '[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || exit 99; printf "Input: "; read value; printf "Value: %s\n" "$value"; echo "Error stream" >&2; stty size'],
      ready: () => { ready = true },
      onOutput(text) {
        assert.equal(ready, true)
        stream += text
        if (!prompted && stream.includes('Input: ')) {
          prompted = true
          session.resize(99, 36)
          session.input('Hello λ\r')
        }
      },
    })
    const result = await session.result
    assert.equal(result.exitCode, 0)
    assert.equal(result.state, 'exited')
    assert.equal(result.signal, undefined)
    assert.match(stream, /Input: Hello λ\r\nValue: Hello λ\r\nError stream\r\n36 99\r\n/)
  })

  await t.test('terminal interrupt reports a signal and an explicit exit code stays a code', async () => {
    const interrupt = startPty({
      ...options, budget: { remaining: 8192 },
      args: ['-c', 'echo ready; while :; do sleep 10; done'],
      onOutput(text) { if (text.includes('ready')) interrupt.input('\x03') },
    })
    const result = await interrupt.result
    assert.equal(result.signal, 'SIGINT')
    assert.equal(result.exitCode, null)
    const voluntary = await startPty({ ...options, budget: { remaining: 8192 }, args: ['-c', 'exit 130'] }).result
    assert.equal(voluntary.exitCode, 130)
    assert.equal(voluntary.signal, undefined)
  })

  await t.test('a fast program keeps output while the PTY relay is paused', async () => {
    const marker = join(scratch, 'program-wrote-output')
    const source = join(scratch, 'fast.c')
    const program = join(scratch, 'fast')
    await writeFile(source, `
      #include <fcntl.h>
      #include <signal.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        if (argc != 2 || kill(getppid(), SIGSTOP) < 0) return 1;
        if (write(STDOUT_FILENO, "fast stdout\\n", 12) != 12) return 2;
        if (write(STDERR_FILENO, "fast stderr\\n", 12) != 12) return 3;
        int marker = open(argv[1], O_WRONLY | O_CREAT | O_EXCL, 0600);
        if (marker < 0) return 4;
        close(marker);
        return 0;
      }
    `)
    await execute('/usr/bin/xcrun', ['clang', source, '-o', program])
    const child = spawn(helper, ['80', '24', program, marker], { cwd: scratch })
    const closed = once(child, 'close')
    const timeout = setTimeout(() => { child.kill('SIGCONT'); child.kill('SIGTERM') }, 3000)
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (text) => { output += text })
    child.stderr.resume()
    try {
      let written = false
      for (let attempt = 0; attempt < 100 && !written; attempt++) {
        written = await access(marker).then(() => true, () => false)
        if (!written) await delay(10)
      }
      assert.equal(written, true)
      // Keep the relay paused while the child reaches exit with unread tty bytes.
      await delay(100)
      child.kill('SIGCONT')
      assert.deepEqual(await closed, [0, null])
      assert.equal(output, 'fast stdout\r\nfast stderr\r\n')
    } finally {
      child.kill('SIGCONT')
      child.kill('SIGTERM')
      await closed
      clearTimeout(timeout)
    }
  })

  await t.test('Stop reaps a program and a subprocess that ignored TERM', async () => {
    const controller = new AbortController()
    let descendant = 0
    const session = startPty({
      ...options, signal: controller.signal, budget: { remaining: 8192 },
      args: ['-c', 'trap "" TERM; sleep 120 & echo "$!"; wait'],
      onOutput(text) {
        if (!descendant) {
          descendant = Number(text.trim())
          controller.abort()
        }
      },
    })
    const result = await session.result
    assert.equal(result.state, 'cancelled')
    assert.ok(descendant > 0)
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(descendant, 0) } catch { break }
      await delay(20)
    }
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
  })

  await t.test('timeout and output limit stop jobs promptly', async () => {
    const timed = await startPty({
      ...options, timeoutMs: 100, budget: { remaining: 8192 }, args: ['-c', 'while :; do :; done'],
    }).result
    assert.equal(timed.state, 'timeout')
    let bytes = 0
    const capped = await startPty({
      ...options, executable: '/usr/bin/yes', args: [], budget: { remaining: 2048 },
      onOutput: (text) => { bytes += Buffer.byteLength(text) },
    }).result
    assert.equal(capped.state, 'output-limit')
    assert.equal(bytes, 2048)
    assert.equal(capped.outputComplete, false)
  })

  await t.test('closing the parent input pipe terminates the program', async () => {
    const child = spawn(helper, ['80', '24', '/bin/sh', '-c', 'echo "$$"; exec /bin/sleep 120'], { cwd: scratch })
    const closed = once(child, 'close')
    let program = 0
    child.stdout.once('data', (text: Buffer) => {
      program = Number(text.toString().trim())
      child.stdin.end()
    })
    let emergencyUsed = false
    const emergency = setTimeout(() => {
      emergencyUsed = true
      child.kill('SIGTERM')
    }, 2_000)
    try {
      const [code, signal] = await closed
      assert.equal(emergencyUsed, false)
      assert.equal(code, null)
      assert.equal(signal, 'SIGTERM')
      assert.ok(program > 0)
      assert.throws(() => process.kill(program, 0), { code: 'ESRCH' })
    } finally {
      clearTimeout(emergency)
    }
  })

  await t.test('closing the output reader releases the program even with input still open', async () => {
    const child = spawn(helper, ['80', '24', '/usr/bin/yes'], { cwd: scratch })
    const closed = once(child, 'close')
    let emergencyUsed = false
    const emergency = setTimeout(() => {
      emergencyUsed = true
      child.stdin.end()
      child.kill('SIGTERM')
    }, 2000)
    child.stdout.once('data', () => child.stdout.destroy())
    child.stderr.resume()
    try {
      const [code, signal] = await closed
      assert.equal(emergencyUsed, false)
      assert.equal(code, null)
      assert.equal(signal, 'SIGKILL')
    } finally {
      clearTimeout(emergency)
    }
  })
})
