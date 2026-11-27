import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CopilotLanguageClient, type CopilotTransport } from '../src/main/copilot/client'

class FixtureTransport implements CopilotTransport {
  requests: Array<{ method: string; params: any; signal?: AbortSignal }> = []
  notifications: Array<{ method: string; params: any }> = []
  handlers = new Map<string, (params: unknown) => void>()
  responder: (method: string, params: any, signal?: AbortSignal) => Promise<unknown> = async () => null
  stopped = 0
  request(method: string, params: unknown, _timeoutMs?: number, signal?: AbortSignal) {
    this.requests.push({ method, params, signal })
    return this.responder(method, params, signal)
  }
  async notify(method: string, params: unknown) { this.notifications.push({ method, params }) }
  onNotification(method: string, handler: (params: unknown) => void) {
    this.handlers.set(method, handler)
    return { dispose: () => this.handlers.delete(method) }
  }
  async stop() { this.stopped++ }
  emit(method: string, value: unknown) { this.handlers.get(method)?.(value) }
}

const document = { uri: 'file:///workspace/app.ts', languageId: 'typescript', version: 1, text: 'const answer = ' }
const at = { line: 0, character: document.text.length }
const item = { insertText: '42', range: { start: { line: 0, character: 0 }, end: at },
  command: { title: 'accepted', command: 'github.copilot.didAcceptCompletionItem', arguments: ['completion-id'] } }

test('official device sign-in retains its finish command in main and exposes no credential', async () => {
  const transport = new FixtureTransport()
  const client = new CopilotLanguageClient(transport)
  transport.responder = async method => method === 'signIn'
    ? { userCode: 'ABCD-EFGH', command: { command: 'github.copilot.finishDeviceFlow', arguments: [] } }
    : method === 'workspace/executeCommand' ? { success: true }
      : { status: 'SignedIn', user: 'fixture-user', token: 'must-not-escape' }
  assert.deepEqual(await client.beginSignIn(), { userCode: 'ABCD-EFGH' })
  assert.deepEqual(await client.finishSignIn(), { status: 'SignedIn', user: 'fixture-user' })
  assert.deepEqual(transport.requests.map(({ method }) => method), ['signIn', 'workspace/executeCommand', 'checkStatus'])
  assert.deepEqual(transport.requests[1].params, { command: 'github.copilot.finishDeviceFlow', arguments: [] })
  assert.ok(!JSON.stringify(transport.requests).includes('must-not-escape'))
  await client.close()
})

test('device flow rejects unrecognized server commands and malformed codes', async () => {
  const transport = new FixtureTransport()
  const client = new CopilotLanguageClient(transport)
  transport.responder = async () => ({ userCode: 'ABCD', command: { command: 'workspace/applyEdit', arguments: [] } })
  await assert.rejects(client.beginSignIn(), /invalid sign-in request/)
  transport.responder = async () => ({ userCode: 'Bearer secret', command: { command: 'github.copilot.finishDeviceFlow', arguments: [] } })
  await assert.rejects(client.beginSignIn(), /invalid sign-in request/)
  assert.equal(transport.requests.some(({ method }) => method === 'workspace/executeCommand'), false)
  await client.close()
})

test('completion synchronizes only the active document and reports show, partial and accepted events', async () => {
  const transport = new FixtureTransport()
  const client = new CopilotLanguageClient(transport)
  transport.responder = async method => method === 'textDocument/inlineCompletion' ? { items: [item] } : null
  const rows = await client.complete(document, at, 2)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].range, item.range)
  assert.deepEqual(transport.notifications.map(({ method }) => method), ['textDocument/didOpen', 'textDocument/didFocus'])
  assert.equal(transport.requests[0].method, 'textDocument/inlineCompletion')
  assert.equal(transport.requests[0].params.textDocument.version, document.version)
  await client.shown(rows[0].id)
  await client.partiallyAccepted(rows[0].id, 1)
  await client.accepted(rows[0].id)
  assert.deepEqual(transport.notifications.slice(-2).map(({ method }) => method), [
    'textDocument/didShowCompletion', 'textDocument/didPartiallyAcceptCompletion',
  ])
  assert.equal(transport.requests.at(-1)?.method, 'workspace/executeCommand')
  assert.deepEqual(transport.requests.at(-1)?.params, item.command && { command: item.command.command, arguments: item.command.arguments })
  assert.ok(!JSON.stringify(transport.requests).includes('Authorization'))
  await client.close()
})

test('completion bounds and cursor-checks untrusted server items', async () => {
  const transport = new FixtureTransport()
  const client = new CopilotLanguageClient(transport)
  transport.responder = async () => ({ items: [
    { ...item, range: { start: { line: 0, character: at.character + 1 }, end: { ...at } } },
    { ...item, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
    { ...item, insertText: 'x'.repeat(16 * 1024 + 1) },
    { ...item, insertText: 'valid' },
  ] })
  assert.deepEqual((await client.complete(document, at, 2)).map(({ text }) => text), ['valid'])
  await assert.rejects(client.complete({ ...document, text: 'x'.repeat(256 * 1024 + 1) }, at, 2), /bounded local source/)
  await assert.rejects(client.complete({ ...document, version: 0 }, at, 2), /bounded local source/)
  await assert.rejects(client.complete({ ...document, uri: 'file:relative.ts' }, at, 2), /bounded local source/)
  transport.responder = async () => ({ items: [{ ...item, command: { command: item.command.command, arguments: ['../run'] } }] })
  const unsafeCommand = await client.complete({ ...document, version: 2 }, at, 2)
  assert.equal(unsafeCommand.length, 1)
  await client.accepted(unsafeCommand[0].id)
  assert.equal(transport.requests.at(-1)?.method, 'textDocument/inlineCompletion', 'Unrecognized commands are never executed.')
  await client.close()
})

test('document edits are monotonic; switching files closes the old document and stale replies are ignored', async () => {
  const transport = new FixtureTransport()
  const client = new CopilotLanguageClient(transport)
  transport.responder = async method => method === 'textDocument/inlineCompletion' ? { items: [item] } : null
  await client.complete(document, at, 2)
  await assert.rejects(client.complete({ ...document, text: 'const number = ' }, at, 2), /without a new editor version/)
  await client.complete({ ...document, version: 2, text: document.text + '4' }, { line: 0, character: document.text.length + 1 }, 2)
  const other = { ...document, uri: 'file:///workspace/other.ts' }
  await client.complete(other, { line: 0, character: other.text.length }, 2)
  assert.ok(transport.notifications.some(({ method, params }) => method === 'textDocument/didChange' && params.textDocument.version === 2))
  assert.ok(transport.notifications.some(({ method, params }) => method === 'textDocument/didClose' && params.textDocument.uri === document.uri))

  let finish!: (value: unknown) => void, requestStarted!: () => void
  const started = new Promise<void>(resolve => { requestStarted = resolve })
  transport.responder = async method => method === 'textDocument/inlineCompletion'
    ? await new Promise(resolve => { finish = resolve; requestStarted() }) : null
  const pending = client.complete(other, { line: 0, character: other.text.length }, 2)
  await started
  client.cancelCompletion()
  finish({ items: [item] })
  assert.deepEqual(await pending, [])
  await client.close()
})

test('sign-out closes synchronized source and disposes status notifications', async () => {
  const transport = new FixtureTransport()
  let seen = 0
  const client = new CopilotLanguageClient(transport, () => seen++)
  transport.responder = async method => method === 'textDocument/inlineCompletion' ? { items: [item] }
    : method === 'checkStatus' ? { status: 'NotSignedIn', token: 'secret' } : null
  await client.complete(document, at, 2)
  transport.emit('didChangeStatus', { kind: 'Normal', message: 'ready', busy: false })
  assert.equal(seen, 1)
  assert.deepEqual(await client.signOut(), { status: 'NotSignedIn' })
  assert.ok(transport.notifications.some(({ method }) => method === 'textDocument/didClose'))
  assert.ok(transport.requests.some(({ method }) => method === 'signOut'))
  transport.emit('didChangeStatus', { kind: 'Error', message: 'signed out', busy: false })
  assert.equal(seen, 2)
  await client.close()
  assert.equal(transport.stopped, 1)
  transport.emit('didChangeStatus', { kind: 'Normal', message: 'ignored after close', busy: false })
  assert.equal(seen, 2)
})
