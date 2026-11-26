import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const deadline = 12_000

function discover(name, environment, windowsPath) {
  if (environment) return environment
  if (process.platform === 'darwin') return execFileSync('/usr/bin/xcrun', ['--find', name], { encoding: 'utf8' }).trim()
  if (process.platform === 'win32') return windowsPath
  return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim()
}

class DapClient {
  constructor(executable) {
    this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32' })
    this.seq = 1
    this.pending = new Map()
    this.waiters = new Map()
    this.queued = new Map()
    this.buffer = Buffer.alloc(0)
    this.stderr = ''
    this.child.stdout.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain() })
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-64 * 1024) })
    this.child.once('exit', (code, signal) => {
      const error = new Error(`lldb-dap exited (${code ?? signal ?? 'unknown'}): ${this.stderr}`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
  }
  send(value) {
    const body = Buffer.from(JSON.stringify(value))
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }
  request(command, arguments_ = {}, timeout = deadline) {
    const seq = this.seq++
    this.send({ seq, type: 'request', command, arguments: arguments_ })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`${command} timed out. stderr=${this.stderr}`)) }, timeout)
      this.pending.set(seq, { command, resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) } })
    })
  }
  event(name, timeout = deadline) {
    const queued = this.queued.get(name)
    if (queued?.length) return Promise.resolve(queued.shift())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.get(name)?.delete(waiter); reject(new Error(`${name} timed out. stderr=${this.stderr}`)) }, timeout)
      const waiter = value => { clearTimeout(timer); this.waiters.get(name)?.delete(waiter); resolve(value) }
      const set = this.waiters.get(name) ?? new Set(); set.add(waiter); this.waiters.set(name, set)
    })
  }
  handle(value) {
    if (process.env.ION_DAP_TRACE === '1') console.error('DAP', JSON.stringify(value))
    if (value?.type === 'response') {
      const pending = this.pending.get(value.request_seq)
      if (!pending) return
      this.pending.delete(value.request_seq)
      if (value.success === false) pending.reject(new Error(`${pending.command}: ${value.message ?? 'failed'}`))
      else pending.resolve(value.body ?? {})
    } else if (value?.type === 'event') {
      const waiters = this.waiters.get(value.event)
      if (waiters?.size) for (const waiter of [...waiters]) waiter(value.body ?? {})
      else { const queue = this.queued.get(value.event) ?? []; if (queue.length < 32) queue.push(value.body ?? {}); this.queued.set(value.event, queue) }
    } else if (value?.type === 'request') {
      this.send({ seq: this.seq++, type: 'response', request_seq: value.seq, command: value.command,
        success: false, message: 'Ion native acceptance rejects reverse execution requests.' })
    }
  }
  drain() {
    while (this.buffer.length) {
      const split = this.buffer.indexOf('\r\n\r\n')
      if (split < 0) { assert.ok(this.buffer.length <= 8 * 1024); return }
      assert.ok(split + 4 <= 8 * 1024)
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, split).toString('ascii'))
      assert.ok(match)
      const length = Number(match[1]); assert.ok(Number.isSafeInteger(length) && length <= 8 * 1024 * 1024)
      const end = split + 4 + length
      if (this.buffer.length < end) return
      const body = this.buffer.subarray(split + 4, end); this.buffer = this.buffer.subarray(end)
      this.handle(JSON.parse(body.toString('utf8')))
    }
  }
  async stop() {
    if (this.child.exitCode !== null) return
    try { await this.request('disconnect', { restart: false, terminateDebuggee: true }, 3_000) } catch {}
    this.child.stdin.end()
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) {
          if (process.platform !== 'win32' && this.child.pid) { try { process.kill(-this.child.pid, 'SIGKILL') } catch {} }
          else if (this.child.pid) void execute('taskkill.exe', ['/pid', String(this.child.pid), '/t', '/f'],
            { windowsHide: true, timeout: 3_000 }).catch(() => this.child.kill('SIGKILL'))
        }
        resolve()
      }, 3_000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'ion-native-debug-'))
try {
  const source = join(scratch, 'main.c')
  const program = join(scratch, process.platform === 'win32' ? 'ion-debug-target.exe' : 'ion-debug-target')
  const text = [
    'static int twice(int value) {',
    '  int result = value * 2;',
    '  return result;',
    '}',
    'int main(void) {',
    '  int answer = twice(21);',
    '  return answer == 42 ? 0 : 1;',
    '}',
    '',
  ].join('\n')
  await writeFile(source, text)
  const clang = discover('clang', process.env.ION_CLANG,
    String.raw`C:\Program Files\LLVM\bin\clang.exe`)
  const adapter = discover('lldb-dap', process.env.ION_LLDB_DAP,
    String.raw`C:\Program Files\LLVM\bin\lldb-dap.exe`)
  assert.ok(isAbsolute(clang) && isAbsolute(adapter), 'Debugger tools must resolve to absolute paths.')
  const [realClang, realAdapter] = await Promise.all([realpath(clang), realpath(adapter)])
  assert.ok(!realClang.startsWith(scratch) && !realAdapter.startsWith(scratch), 'Workspace-controlled debugger tool was selected.')
  const sysroot = process.platform === 'darwin'
    ? execFileSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim() : undefined
  const compiler = await execute(realClang, [...(sysroot ? ['-isysroot', sysroot] : []), '-g', '-O0', source, '-o', program],
    { cwd: scratch, timeout: 20_000, windowsHide: true })
  assert.equal(compiler.stderr, '')
  const version = await execute(realAdapter, ['--version'], { timeout: 10_000, windowsHide: true }).catch(() => ({ stdout: '', stderr: '' }))
  const client = new DapClient(realAdapter)
  try {
    const capabilities = await client.request('initialize', { clientID: 'ion-native-acceptance', adapterID: 'lldb',
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsRunInTerminalRequest: false })
    assert.equal(typeof capabilities, 'object')
    const initialized = client.event('initialized')
    const launched = client.request('launch', { program, cwd: scratch, args: [], stopOnEntry: false })
      .then(body => ({ body }), error => ({ error }))
    await initialized
    const breakpoint = await client.request('setBreakpoints', { source: { name: 'main.c', path: source },
      breakpoints: [{ line: 6 }], sourceModified: false })
    assert.equal(breakpoint.breakpoints?.[0]?.verified, true, 'lldb-dap did not verify the source breakpoint.')
    const stopped = client.event('stopped')
    await client.request('configurationDone')
    const launchResult = await launched
    if ('error' in launchResult) throw launchResult.error
    const stop = await stopped
    assert.ok(stop.reason === 'breakpoint' || stop.reason === 'entry')
    const threads = await client.request('threads')
    assert.ok(threads.threads?.length)
    const threadId = stop.threadId ?? threads.threads[0].id
    const stack = await client.request('stackTrace', { threadId, startFrame: 0, levels: 20 })
    const frame = stack.stackFrames?.find(item => item.source?.path === source) ?? stack.stackFrames?.[0]
    assert.ok(frame && Number.isInteger(frame.id), 'lldb-dap returned no source stack frame.')
    const scopes = await client.request('scopes', { frameId: frame.id })
    assert.ok(scopes.scopes?.length, 'lldb-dap returned no scopes.')
    const localScope = scopes.scopes.find(scope => /local/i.test(scope.name)) ?? scopes.scopes[0]
    const variables = await client.request('variables', { variablesReference: localScope.variablesReference })
    assert.ok(Array.isArray(variables.variables), 'lldb-dap returned no variable collection.')
    const stepStop = client.event('stopped')
    await client.request('next', { threadId })
    await stepStop
    const terminated = client.event('terminated')
    await client.request('continue', { threadId })
    await terminated
    assert.equal(client.pending.size, 0)
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, clang: realClang,
      adapter: realAdapter, adapterVersion: (version.stdout || version.stderr).trim().split('\n')[0] || 'not reported',
      breakpointLine: breakpoint.breakpoints[0].line, frames: stack.stackFrames.length,
      scopes: scopes.scopes.length, variables: variables.variables.length }))
    console.log('PASS native clang/lldb-dap breakpoint, stack, scopes, variables, step, continue and cleanup')
  } finally { await client.stop() }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
