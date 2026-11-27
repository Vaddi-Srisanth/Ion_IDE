#!/usr/bin/env node
import { stdin, stdout } from 'node:process'

const headerLimit = 8 * 1024
const bodyLimit = 8 * 1024 * 1024
let input = Buffer.alloc(0)
let sequence = 1
let launched = false
let configured = false
let stopped = false

function frame(message) {
  const body = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

function send(message) {
  const bytes = frame({ seq: sequence++, ...message })
  if (process.env.ION_FAKE_DAP_FRAGMENT === '1' && bytes.length > 8) {
    const first = Math.max(1, Math.floor(bytes.length / 3))
    stdout.write(bytes.subarray(0, first))
    stdout.write(bytes.subarray(first))
  } else stdout.write(bytes)
}

function response(request, body = {}, success = true, message) {
  send({ type: 'response', request_seq: request.seq, command: request.command, success, body,
    ...(message ? { message } : {}) })
}

function event(name, body = {}) { send({ type: 'event', event: name, body }) }

function request(command, arguments_) {
  send({ type: 'request', command, arguments: arguments_ })
}

function stop(reason = 'breakpoint') {
  stopped = true
  event('stopped', { reason, threadId: 1, allThreadsStopped: true })
}

function handle(message) {
  if (!message || message.type !== 'request' || !Number.isSafeInteger(message.seq) || typeof message.command !== 'string') return
  switch (message.command) {
    case 'initialize':
      response(message, { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true,
        supportsTerminateRequest: true, supportsRestartRequest: false })
      if (process.env.ION_FAKE_DAP_REVERSE === '1') request('runInTerminal', { kind: 'integrated', args: ['forbidden'] })
      event('initialized')
      break
    case 'launch':
      launched = true
      response(message)
      event('output', { category: 'console', output: 'fake debuggee launched\n' })
      break
    case 'setBreakpoints': {
      const requested = Array.isArray(message.arguments?.breakpoints) ? message.arguments.breakpoints : []
      response(message, { breakpoints: requested.map((item, index) => ({ id: index + 1, verified: true,
        line: Number.isInteger(item?.line) ? item.line : 1 })) })
      break
    }
    case 'configurationDone':
      configured = true
      response(message)
      if (launched) setImmediate(() => stop())
      break
    case 'threads': response(message, { threads: [{ id: 1, name: 'main' }] }); break
    case 'stackTrace':
      response(message, { stackFrames: [{ id: 7, name: 'main', line: 4, column: 1,
        source: { name: 'main.c', path: process.env.ION_FAKE_DAP_SOURCE ?? '/workspace/main.c' } }], totalFrames: 1 })
      break
    case 'scopes': response(message, { scopes: [{ name: 'Locals', variablesReference: 11, expensive: false }] }); break
    case 'variables': response(message, { variables: [{ name: 'value', value: '42', type: 'int', variablesReference: 0 }] }); break
    case 'evaluate': response(message, { result: String(message.arguments?.expression ?? ''), variablesReference: 0 }); break
    case 'next': case 'stepIn': case 'stepOut':
      stopped = false
      response(message)
      event('continued', { threadId: 1, allThreadsContinued: true })
      setImmediate(() => stop('step'))
      break
    case 'pause': response(message); if (!stopped) setImmediate(() => stop('pause')); break
    case 'continue':
      stopped = false
      response(message, { allThreadsContinued: true })
      event('continued', { threadId: 1, allThreadsContinued: true })
      setImmediate(() => { event('exited', { exitCode: 0 }); event('terminated') })
      break
    case 'disconnect': case 'terminate':
      response(message)
      if (configured) event('terminated')
      setImmediate(() => process.exit(0))
      break
    default: response(message, {}, false, `Unsupported command: ${message.command}`)
  }
}

function drain() {
  while (input.length) {
    const separator = input.indexOf('\r\n\r\n')
    if (separator < 0) {
      if (input.length > headerLimit) process.exit(2)
      return
    }
    if (separator + 4 > headerLimit) process.exit(2)
    const header = input.subarray(0, separator).toString('ascii')
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header)
    const length = match ? Number(match[1]) : NaN
    if (!Number.isSafeInteger(length) || length < 0 || length > bodyLimit) process.exit(2)
    const end = separator + 4 + length
    if (input.length < end) return
    const body = input.subarray(separator + 4, end)
    input = input.subarray(end)
    try { handle(JSON.parse(body.toString('utf8'))) }
    catch { process.exit(2) }
  }
}

stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk])
  if (input.length > bodyLimit + headerLimit) process.exit(2)
  drain()
})
stdin.on('end', () => process.exit(0))
