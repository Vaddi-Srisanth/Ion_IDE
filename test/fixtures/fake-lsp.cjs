let buffer = Buffer.alloc(0)
const { appendFileSync } = require('node:fs')
function send(value) {
  const body = Buffer.from(JSON.stringify(value))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())
    if (!match) process.exit(2)
    const length = Number(match[1])
    const end = headerEnd + 4 + length
    if (buffer.length < end) return
    const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString())
    if (process.env.ION_FAKE_LSP_LOG) appendFileSync(process.env.ION_FAKE_LSP_LOG,
      (message.method || (message.id === 99 && message.result && message.result.applied === false ? 'apply-rejected' : 'response')) + '\n')
    buffer = buffer.subarray(end)
    if (message.method === 'initialize') setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }),
      Number(process.env.ION_FAKE_LSP_INITIALIZE_DELAY_MS || 0))
    else if (message.method === 'initialized') send({ jsonrpc: '2.0', id: 99, method: 'workspace/applyEdit', params: { edit: {
      changes: { 'file:///outside/not-authorized.c': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'unsafe' }] },
    } } })
    else if (message.method === 'ion/echo') send({ jsonrpc: '2.0', id: message.id, result: message.params })
    else if (message.method === 'ion/publishDiagnostics') {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: message.params })
      send({ jsonrpc: '2.0', id: message.id, result: null })
    }
    else if (message.method === 'textDocument/hover') send({ jsonrpc: '2.0', id: message.id, result: null })
    else if (message.method === 'ion/huge') process.stdout.write('Content-Length: 9000000\r\n\r\n')
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null })
    else if (message.method === 'exit') process.exit(0)
  }
})

