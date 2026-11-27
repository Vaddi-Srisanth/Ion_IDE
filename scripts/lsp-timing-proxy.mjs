import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import process from 'node:process'

const [destination, entry, ...args] = process.argv.slice(2)
if (!entry || !destination) throw new Error('The LSP timing proxy requires a server entry point and a private timing log.')

const session = `${process.pid}-${process.hrtime.bigint()}`
const log = createWriteStream(destination, { flags: 'a', mode: 0o600 })
const pending = new Map()
let eventCount = 0
const maxEvents = 512
const observedMethods = new Set([
  'initialize', 'initialized', 'workspace/didChangeConfiguration',
  'textDocument/didOpen', 'textDocument/didChange', 'textDocument/definition',
  'textDocument/completion', 'textDocument/hover', 'textDocument/signatureHelp',
  'textDocument/references', 'textDocument/publishDiagnostics', 'shutdown', 'exit',
])

function record(event, method) {
  if (eventCount++ >= maxEvents) return
  log.write(JSON.stringify({ session, tNs: String(process.hrtime.bigint()), event, ...(method ? { method } : {}) }) + '\n')
}

function key(id) { return `${typeof id}:${String(id)}` }
function observe(direction, message) {
  if (!message || typeof message !== 'object') return
  if (direction === 'client' && typeof message.method === 'string') {
    const method = observedMethods.has(message.method) ? message.method : 'other-method'
    record('request', method)
    if (message.id !== undefined) pending.set(key(message.id), method)
    return
  }
  if (direction === 'server' && message.id !== undefined) {
    const request = pending.get(key(message.id))
    if (!request) return
    pending.delete(key(message.id))
    record('response', request)
    return
  }
  if (direction === 'server' && typeof message.method === 'string') {
    const method = observedMethods.has(message.method) ? message.method : 'other-method'
    record('notification', method)
  }
}

function inspector(direction) {
  let bytes = Buffer.alloc(0)
  return chunk => {
    bytes = Buffer.concat([bytes, chunk])
    while (bytes.length) {
      const headerEnd = bytes.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        if (bytes.length > 8 * 1024) bytes = Buffer.alloc(0)
        return
      }
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)\r\n/i.exec(bytes.subarray(0, headerEnd + 2).toString('ascii'))
      const length = match ? Number(match[1]) : NaN
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
        bytes = Buffer.alloc(0)
        return
      }
      const end = headerEnd + 4 + length
      if (bytes.length < end) return
      try { observe(direction, JSON.parse(bytes.subarray(headerEnd + 4, end).toString('utf8'))) }
      catch { record('malformed-frame') }
      bytes = bytes.subarray(end)
    }
  }
}

record('proxy-start')
const child = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
child.once('spawn', () => record('server-spawned'))
child.once('error', () => record('server-spawn-error'))

const clientFrames = inspector('client')
const serverFrames = inspector('server')
process.stdin.on('data', chunk => { clientFrames(chunk); if (!child.stdin.write(chunk)) process.stdin.pause() })
child.stdin.on('drain', () => process.stdin.resume())
process.stdin.once('end', () => child.stdin.end())
child.stdout.on('data', chunk => { serverFrames(chunk); if (!process.stdout.write(chunk)) child.stdout.pause() })
process.stdout.on('drain', () => child.stdout.resume())
child.stderr.pipe(process.stderr)

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
let exitCode = 1
child.once('exit', (code, signal) => {
  record('server-exit', signal ?? String(code ?? 'unknown'))
  exitCode = code ?? 1
})
child.once('close', () => log.end(() => { process.exitCode = exitCode }))
