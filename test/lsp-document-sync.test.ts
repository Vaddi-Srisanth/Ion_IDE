import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import type { ToolSnapshot } from '../src/shared/language-tools'
import { DiagnosticGenerationFence, ExternalLspService, LspDocumentSynchronizer } from '../src/main/language-tools/lsp-adapter'
import { LspProcess } from '../src/main/language-tools/lsp-process'

interface Notification { method: string; params: unknown }

function recorder() {
  const notifications: Notification[] = []
  return {
    notifications,
    notify: async (method: string, params: unknown) => { notifications.push({ method, params }) },
  }
}

test('unchanged semantic requests share one open document without redundant changes', async () => {
  const sync = new LspDocumentSynchronizer()
  const { notifications, notify } = recorder()
  const uri = 'file:///workspace/main.js'
  const text = 'export function total(a, b) { return a + b }\n'
  assert.equal(await sync.synchronize(uri, 'javascript', 7, text, notify), 1)
  for (let request = 0; request < 6; request++) {
    assert.equal(await sync.synchronize(uri, 'javascript', 7, text, notify), 1)
  }
  assert.equal(sync.size, 1)
  assert.deepEqual(notifications.map(({ method }) => method), ['textDocument/didOpen'])
})

test('an actual edit emits one monotonic update while equivalent versions stay quiet', async () => {
  const sync = new LspDocumentSynchronizer()
  const { notifications, notify } = recorder()
  const uri = 'file:///workspace/main.js'
  await sync.synchronize(uri, 'javascript', 1, 'const value = 1\n', notify)
  assert.equal(await sync.synchronize(uri, 'javascript', 2, 'const value = 2\n', notify), 2)
  assert.equal(await sync.synchronize(uri, 'javascript', 3, 'const value = 2\n', notify), 2)
  assert.equal(await sync.synchronize(uri, 'javascript', 2, 'const value = 1\n', notify), 2,
    'A stale request must not overwrite the synchronized buffer.')
  assert.deepEqual(notifications.map(({ method }) => method), ['textDocument/didOpen', 'textDocument/didChange'])
  assert.deepEqual((notifications[1].params as { textDocument: { version: number } }).textDocument.version, 2)
})

test('closing and restarting clears document synchronization state', async () => {
  const sync = new LspDocumentSynchronizer()
  const { notifications, notify } = recorder()
  const first = 'file:///workspace/first.py', second = 'file:///workspace/second.py'
  await Promise.all([
    sync.synchronize(first, 'python', 1, 'value = 1\n', notify),
    sync.synchronize(second, 'python', 1, 'value = 2\n', notify),
  ])
  await sync.close(first, notify)
  assert.equal(sync.size, 1)
  assert.equal(await sync.synchronize(first, 'python', 1, 'value = 1\n', notify), 1,
    'A closed document must reopen with a fresh protocol version.')
  await sync.closeAll(notify)
  assert.equal(sync.size, 0)
  assert.equal(notifications.filter(({ method }) => method === 'textDocument/didOpen').length, 3)
  assert.equal(notifications.filter(({ method }) => method === 'textDocument/didClose').length, 3)
})

test('equal Monaco versions with conflicting content fail closed', async () => {
  const sync = new LspDocumentSynchronizer()
  const { notify } = recorder()
  const uri = 'file:///workspace/main.ts'
  await sync.synchronize(uri, 'typescript', 4, 'const value = 1\n', notify)
  await assert.rejects(() => sync.synchronize(uri, 'typescript', 4, 'const value = 2\n', notify),
    /Conflicting language document snapshot/)
})

test('diagnostic generations reject unversioned reports after an edit and retain reordered versions', () => {
  const fence = new DiagnosticGenerationFence()
  const uri = 'file:///workspace/main.py'
  assert.equal(fence.publish(uri, 1, { diagnostics: [] }), true, 'The initial generation has no stale predecessor.')
  assert.equal(fence.publish(uri, 3, { diagnostics: [{ message: 'stale A' }] }), false)
  assert.equal(fence.publish(uri, 3, { version: 3, diagnostics: [{ message: 'current C' }] }), true)
  assert.equal(fence.publish(uri, 3, { version: 1, diagnostics: [{ message: 'late A' }] }), true)
  assert.equal(fence.publish(uri, 3, { version: 2, diagnostics: [{ message: 'late B' }] }), true)
  assert.deepEqual(fence.take(uri, 3)?.diagnostics, [{ message: 'current C' }])
  assert.deepEqual(fence.take(uri, 2)?.diagnostics, [{ message: 'late B' }])
})

test('cancelled diagnostic waits release their generation waiter', async () => {
  const fence = new DiagnosticGenerationFence()
  const abort = new AbortController()
  const waiting = fence.wait('file:///workspace/main.py', 2, abort.signal)
  assert.equal(fence.pendingWaiterCount, 1)
  abort.abort(new Error('cancelled by test'))
  await assert.rejects(waiting, /cancelled by test/)
  assert.equal(fence.pendingWaiterCount, 0)
})

const fakeServer = resolve('test/fixtures/fake-lsp.cjs')

async function fakeService() {
  const directory = await mkdtemp(join(tmpdir(), 'ion-diagnostic-race-'))
  const host = await LspProcess.start({
    executable: process.execPath,
    args: [fakeServer],
    cwd: directory,
    env: { ...process.env },
    root: null,
  }, new AbortController().signal)
  return { host, service: ExternalLspService.attach(host, directory) }
}

function snapshot(path: string, version: number, text: string, operation: ToolSnapshot['operation']): ToolSnapshot {
  return { path, version, text, operation, language: 'python', offset: 0 }
}

function diagnostic(message: string) {
  return { severity: 1, message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
}

test('a delayed unversioned A report cannot satisfy a synchronized B request', async () => {
  const { host, service } = await fakeService()
  const path = join(tmpdir(), 'ion-race-a-b.py')
  const uri = pathToFileURL(path).href
  try {
    await service.query(snapshot(path, 1, 'value = 1\n', 'hover'))
    await service.query(snapshot(path, 2, 'value = (\n', 'hover'))
    const pending = service.query(snapshot(path, 2, 'value = (\n', 'diagnostics'))
    await host.request('ion/echo', 'B diagnostics waiter installed')
    let settled = false
    void pending.then(() => { settled = true })
    await host.request('ion/publishDiagnostics', { uri, diagnostics: [diagnostic('stale A')] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'An unversioned predecessor must not release the B waiter.')
    await host.request('ion/publishDiagnostics', { uri, version: 2, diagnostics: [diagnostic('current B')] })
    const result = await pending
    assert.deepEqual(result.rows.map(row => row[3]), ['current B'])
  } finally {
    await service.stop()
  }
})

test('rapid A to B to C edits survive deliberately reordered diagnostic notifications', async () => {
  const { host, service } = await fakeService()
  const path = join(tmpdir(), 'ion-race-a-b-c.py')
  const uri = pathToFileURL(path).href
  try {
    await service.query(snapshot(path, 1, 'value = 1\n', 'hover'))
    await service.query(snapshot(path, 2, 'value = (\n', 'hover'))
    await service.query(snapshot(path, 3, 'value = [\n', 'hover'))
    const pending = service.query(snapshot(path, 3, 'value = [\n', 'diagnostics'))
    await host.request('ion/echo', 'C diagnostics waiter installed')
    await host.request('ion/publishDiagnostics', { uri, version: 2, diagnostics: [diagnostic('late B')] })
    await host.request('ion/publishDiagnostics', { uri, diagnostics: [diagnostic('late unversioned A')] })
    await host.request('ion/publishDiagnostics', { uri, version: 3, diagnostics: [diagnostic('current C')] })
    const result = await pending
    assert.deepEqual(result.rows.map(row => row[3]), ['current C'])
  } finally {
    await service.stop()
  }
})
