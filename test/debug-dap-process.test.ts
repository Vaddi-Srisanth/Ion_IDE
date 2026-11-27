import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DapFrameDecoder, DapProcess, encodeDapMessage, type DapMessage } from '../src/main/debug/dap-process'

const response = (request = 1): DapMessage => ({ seq: request + 10, type: 'response', request_seq: request,
  success: true, command: 'test', body: { value: request } })

test('DAP decoder accepts split and combined bounded frames', () => {
  const messages: DapMessage[] = [], failures: Error[] = []
  const decoder = new DapFrameDecoder(value => messages.push(value), error => failures.push(error))
  const first = encodeDapMessage(response(1)), second = encodeDapMessage(response(2))
  decoder.push(first.subarray(0, 7))
  decoder.push(Buffer.concat([first.subarray(7), second]))
  decoder.end()
  assert.deepEqual(messages, [response(1), response(2)])
  assert.deepEqual(failures, [])
})

test('DAP decoder fails closed on duplicate, oversized, malformed and truncated messages', () => {
  for (const [payload, expected] of [
    [Buffer.from('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}'), /invalid protocol header/],
    [Buffer.from('Content-Length: 9000000\r\n\r\n'), /invalid protocol payload length/],
    [Buffer.from('Content-Length: 1\r\n\r\n{'), /invalid protocol payload/],
    [Buffer.from('Content-Length: 20\r\n\r\n{}'), /mid-message/],
  ] as const) {
    const failures: Error[] = []
    const decoder = new DapFrameDecoder(() => assert.fail('invalid payload escaped'), error => failures.push(error))
    decoder.push(payload); decoder.end()
    assert.match(failures[0]?.message ?? '', expected)
  }
})

const fixture = String.raw`
let bytes = Buffer.alloc(0), expected = null, seq = 100
function send(value) {
  const body = Buffer.from(JSON.stringify(value))
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]))
}
function receive(value) {
  if (value.type === 'response' && value.request_seq === 500 && value.success === false) {
    send({ seq: ++seq, type: 'response', request_seq: 2, success: true, command: 'reverse', body: { rejected: true } })
    return
  }
  if (value.type !== 'request') return
  if (value.command === 'echo') send({ seq: ++seq, type: 'response', request_seq: value.seq, success: true, command: value.command, body: value.arguments })
  else if (value.command === 'reverse') send({ seq: 500, type: 'request', command: 'runInTerminal', arguments: { kind: 'integrated', args: ['unsafe'] } })
  else if (value.command === 'wait') setTimeout(() => send({ seq: ++seq, type: 'response', request_seq: value.seq, success: true, command: value.command }), 500)
  else if (value.command === 'disconnect') {
    send({ seq: ++seq, type: 'response', request_seq: value.seq, success: true, command: value.command })
    setTimeout(() => process.exit(0), 10)
  }
}
process.stdin.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk])
  for (;;) {
    if (expected === null) {
      const boundary = bytes.indexOf('\r\n\r\n'); if (boundary < 0) return
      expected = Number(/Content-Length:\s*(\d+)/i.exec(bytes.subarray(0, boundary).toString('ascii'))[1])
      bytes = bytes.subarray(boundary + 4)
    }
    if (bytes.length < expected) return
    const body = bytes.subarray(0, expected); bytes = bytes.subarray(expected); expected = null
    receive(JSON.parse(body.toString('utf8')))
  }
})
`

test('DAP process correlates responses, rejects reverse launch requests and cancels waiters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-dap-test-'))
  const script = join(directory, 'adapter.cjs')
  await writeFile(script, fixture)
  const host = await DapProcess.start({ executable: process.execPath, args: [script], cwd: directory, env: { ...process.env } })
  try {
    assert.deepEqual(await host.request('echo', { safe: true }), { safe: true })
    assert.deepEqual(await host.request('reverse'), { rejected: true })
    const controller = new AbortController()
    const waiting = host.request('wait', {}, 2_000, controller.signal)
    controller.abort(new Error('cancelled by test'))
    await assert.rejects(waiting, /cancelled by test/)
    await new Promise(resolve => setTimeout(resolve, 550))
    assert.deepEqual(await host.request('echo', { afterLateResponse: true }), { afterLateResponse: true })
    assert.equal(host.closed, false)
  } finally {
    await host.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('DAP event waits are cancellable and do not poison the live connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-dap-test-'))
  const script = join(directory, 'adapter.cjs')
  await writeFile(script, fixture)
  const host = await DapProcess.start({ executable: process.execPath, args: [script], cwd: directory, env: { ...process.env } })
  try {
    const controller = new AbortController()
    const waiting = host.waitForEvent('stopped', undefined, 2_000, controller.signal)
    controller.abort()
    await assert.rejects(waiting, /aborted|cancelled/i)
    assert.deepEqual(await host.request('echo', { live: true }), { live: true })
  } finally {
    await host.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
