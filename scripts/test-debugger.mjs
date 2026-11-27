import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const adapter = resolve('scripts/fake-dap-adapter.mjs')
const timeoutMs = 5_000

class DapClient {
  constructor(child) {
    this.child = child
    this.sequence = 1
    this.pending = new Map()
    this.waiters = new Map()
    this.buffer = Buffer.alloc(0)
    this.reverseRequests = 0
    child.stdout.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain() })
    child.once('exit', (code, signal) => {
      const reason = new Error(`Adapter exited (${code ?? signal ?? 'unknown'}).`)
      for (const pending of this.pending.values()) pending.reject(reason)
      this.pending.clear()
    })
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message))
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }

  request(command, arguments_ = {}) {
    assert.ok(this.pending.size < 32)
    const seq = this.sequence++
    this.send({ seq, type: 'request', command, arguments: arguments_ })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`${command} timed out.`)) }, timeoutMs)
      this.pending.set(seq, { resolve: value => { clearTimeout(timer); resolve(value) },
        reject: reason => { clearTimeout(timer); reject(reason) }, command })
    })
  }

  event(name) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.get(name)?.delete(waiter); reject(new Error(`${name} event timed out.`)) }, timeoutMs)
      const waiter = value => { clearTimeout(timer); this.waiters.get(name)?.delete(waiter); resolve(value) }
      const set = this.waiters.get(name) ?? new Set()
      set.add(waiter)
      this.waiters.set(name, set)
    })
  }

  handle(message) {
    if (message?.type === 'response') {
      const pending = this.pending.get(message.request_seq)
      if (!pending) return
      this.pending.delete(message.request_seq)
      if (message.success === false) pending.reject(new Error(message.message ?? `${pending.command} failed.`))
      else pending.resolve(message.body ?? {})
      return
    }
    if (message?.type === 'event') {
      for (const waiter of [...(this.waiters.get(message.event) ?? [])]) waiter(message.body ?? {})
      return
    }
    if (message?.type === 'request') {
      this.reverseRequests++
      this.send({ seq: this.sequence++, type: 'response', request_seq: message.seq, command: message.command,
        success: false, message: 'Ion rejects adapter-initiated execution requests.' })
    }
  }

  drain() {
    while (this.buffer.length) {
      const separator = this.buffer.indexOf('\r\n\r\n')
      if (separator < 0) { assert.ok(this.buffer.length <= 8 * 1024); return }
      const header = this.buffer.subarray(0, separator).toString('ascii')
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
      assert.ok(match, 'DAP frame omitted Content-Length.')
      const length = Number(match[1])
      assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= 8 * 1024 * 1024)
      const end = separator + 4 + length
      if (this.buffer.length < end) return
      const body = this.buffer.subarray(separator + 4, end)
      this.buffer = this.buffer.subarray(end)
      this.handle(JSON.parse(body.toString('utf8')))
    }
  }

  async close() {
    this.child.stdin.end()
    if (this.child.exitCode !== null) return
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); reject(new Error('Adapter did not exit.')) }, timeoutMs)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

async function cycle({ reverse = false } = {}) {
  const child = spawn(process.execPath, [adapter], { stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...process.env, ION_FAKE_DAP_FRAGMENT: '1', ...(reverse ? { ION_FAKE_DAP_REVERSE: '1' } : {}),
  } })
  const client = new DapClient(child)
  const initialized = client.event('initialized')
  const capabilities = await client.request('initialize', { adapterID: 'ion-fake', linesStartAt1: true, columnsStartAt1: true })
  assert.equal(capabilities.supportsConfigurationDoneRequest, true)
  await initialized
  if (reverse) {
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(client.reverseRequests, 1, 'Reverse execution request was not observed and rejected.')
  }
  await client.request('launch', { program: '/private/ion-owned-debug-target' })
  const breakpoints = await client.request('setBreakpoints', { source: { path: '/workspace/main.c' }, breakpoints: [{ line: 4 }] })
  assert.deepEqual(breakpoints.breakpoints.map(({ verified, line }) => [verified, line]), [[true, 4]])
  const firstStop = client.event('stopped')
  await client.request('configurationDone')
  assert.equal((await firstStop).reason, 'breakpoint')
  assert.deepEqual((await client.request('threads')).threads, [{ id: 1, name: 'main' }])
  const stack = await client.request('stackTrace', { threadId: 1, startFrame: 0, levels: 20 })
  assert.equal(stack.stackFrames[0].line, 4)
  const scopes = await client.request('scopes', { frameId: stack.stackFrames[0].id })
  const variables = await client.request('variables', { variablesReference: scopes.scopes[0].variablesReference })
  assert.equal(variables.variables[0].value, '42')
  assert.equal((await client.request('evaluate', { expression: 'value', frameId: 7 })).result, 'value')
  const stepped = client.event('stopped')
  await client.request('next', { threadId: 1 })
  assert.equal((await stepped).reason, 'step')
  const terminated = client.event('terminated')
  await client.request('continue', { threadId: 1 })
  await terminated
  await client.request('disconnect', { terminateDebuggee: true })
  await client.close()
  assert.equal(child.exitCode, 0)
  assert.equal(client.pending.size, 0)
}

for (let index = 0; index < 3; index++) await cycle({ reverse: index === 0 })
console.log('PASS bounded fake DAP framing, reverse-request rejection, breakpoints, stack, variables, stepping and cleanup')
