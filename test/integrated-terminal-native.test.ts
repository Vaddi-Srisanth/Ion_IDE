import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { TerminalService } from '../src/main/terminal/service'
import type { TerminalEvent } from '../src/shared/terminal'

const execute = promisify(execFile)

async function until<T>(read: () => T | Promise<T>, message: string): Promise<T> {
  const deadline = performance.now() + 4_000
  do {
    const value = await read()
    if (value) return value
    await sleep(20)
  } while (performance.now() < deadline)
  assert.fail(message)
}

test('native terminal streams output on demand and closes the shell job groups', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  if (!await execute('/usr/bin/xcode-select', ['-p']).then(() => true, () => false)) {
    t.skip('Apple Command Line Tools are unavailable.')
    return
  }
  const scratch = await mkdtemp(join(tmpdir(), 'ion-shell-test-'))
  const helper = join(scratch, 'ion-pty')
  const cwd = join(scratch, 'workspace')
  const oldHome = process.env.HOME
  const oldZdotdir = process.env.ZDOTDIR
  const oldXdg = process.env.XDG_CONFIG_HOME
  const events: TerminalEvent[] = []
  const output = new Map<string, string>()
  let holdAck = true
  const terminal = new TerminalService(helper, (event) => {
    events.push(event)
    if (event.kind === 'data') {
      output.set(event.id, (output.get(event.id) ?? '') + event.text)
      if (!holdAck) terminal.ack(event.id, event.sequence)
    }
  })
  t.after(async () => {
    await terminal.closeAll()
    for (const [key, value] of [['HOME', oldHome], ['ZDOTDIR', oldZdotdir], ['XDG_CONFIG_HOME', oldXdg]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(scratch, { recursive: true, force: true })
  })
  await mkdir(cwd)
  await execute('/usr/bin/xcrun', ['clang', '-std=c11', '-D_DARWIN_C_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror',
    resolve('src/main/run-console/pty-helper.c'), '-o', helper])
  process.env.HOME = process.env.ZDOTDIR = process.env.XDG_CONFIG_HOME = scratch
  const prompt = "printf 'ION-TEST-SHELL-READY\n'\n"
  await Promise.all(['.zshrc', '.bash_profile', '.profile'].map((file) => writeFile(join(scratch, file), prompt)))
  await assert.rejects(terminal.create(cwd, 80, 1), /dimensions/)
  await assert.rejects(terminal.input('../outside', 'x'), /session ID/)

  const first = await terminal.create(cwd, 80, 24)
  await sleep(60)
  assert.equal(events.length, 0, 'no output arrives before the renderer attaches')
  terminal.attach(first.id)
  const data = await until(() => events.find((event) => event.kind === 'data' && event.id === first.id), 'shell never produced a prompt')
  assert.equal(data?.kind, 'data')
  await terminal.input(first.id, "printf '%s\\n' ION-ACK-TEST\r")
  terminal.ack(first.id, data.sequence + 1)
  await sleep(60)
  assert.equal(events.length, 1, 'a wrong or withheld ACK keeps the next chunk paused')
  holdAck = false
  terminal.ack(first.id, data.sequence)
  await until(() => output.get(first.id)?.includes('\r\nION-ACK-TEST\r\n'), 'ACK did not resume terminal output')
  await assert.rejects(terminal.input(first.id, 'λ'.repeat(8193)), /16 KiB/)

  terminal.resize(first.id, 99, 36)
  await terminal.input(first.id, 'stty size; pwd\r')
  await until(() => /36 99\r\n.*\/workspace\r\n/.test(output.get(first.id) ?? ''), 'tty dimensions or working directory were not applied')

  const second = await terminal.create(cwd, 80, 24)
  terminal.attach(second.id)
  await terminal.input(first.id,
    `/bin/sh -c 'echo $$ > bg.pid; trap "" HUP TERM; exec /bin/sleep 90' & /bin/sh -c 'echo $$ > fg.pid; trap "" HUP TERM; exec /bin/sleep 90'\r`)
  const ids = await until(async () => {
    const values = await Promise.all(['bg.pid', 'fg.pid'].map((file) => readFile(join(cwd, file), 'utf8').then(Number, () => 0)))
    return values.every((pid) => pid > 0) ? values : null
  }, 'foreground and background jobs did not start')
  assert.ok(ids)
  const groupOf = async (pid: number) => (await execute('/bin/ps', ['-o', 'pgid=', '-p', String(pid)])).stdout.trim()
  assert.notEqual(await groupOf(ids[0]), await groupOf(ids[1]), 'shell jobs have separate native groups')
  await terminal.close(first.id)
  await until(() => ids.every((pid) => {
    try { process.kill(pid, 0); return false } catch { return true }
  }), 'explicit close left terminal job processes alive')
  await terminal.input(second.id, "printf '%s\\n' ION-OTHER-SESSION; exit 7\r")
  const exit = await until(() => events.find((event) => event.kind === 'exit' && event.id === second.id), 'second shell never exited')
  assert.equal(exit?.kind, 'exit')
  assert.equal(exit.code, 7)
  assert.match(output.get(second.id) ?? '', /\r\nION-OTHER-SESSION\r\n/)

  const third = await terminal.create(cwd, 80, 24)
  await terminal.input(third.id, "printf '%s\\n' ION-BEFORE-ATTACH; exit 3\r")
  await sleep(60)
  assert.equal(events.some((event) => event.id === third.id), false)
  terminal.attach(third.id)
  const delayedExit = await until(() => events.find((event) => event.kind === 'exit' && event.id === third.id),
    'the terminal lost the final output or exit before attach')
  assert.equal(delayedExit?.kind, 'exit')
  assert.equal(delayedExit.code, 3)
  assert.match(output.get(third.id) ?? '', /\r\nION-BEFORE-ATTACH\r\n/)

  const pending = terminal.create(cwd, 80, 24)
  const refused = assert.rejects(pending, /closing/)
  await terminal.closeAll()
  await refused
})
