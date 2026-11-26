import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import type { ToolSnapshot } from '../src/shared/language-tools'
import { canonicalFileUriIdentity, DiagnosticGenerationFence, ExternalLspService, LspDocumentSynchronizer } from '../src/main/language-tools/lsp-adapter'
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
  assert.equal(fence.publish(uri, 1, { diagnostics: [] }).decision, 'accepted', 'The initial generation has no stale predecessor.')
  assert.deepEqual(fence.publish(uri, 3, { diagnostics: [{ message: 'stale A' }] }).decision, 'ignored')
  assert.equal(fence.publish(uri, 3, { version: 3, diagnostics: [{ message: 'current C' }] }).decision, 'accepted')
  assert.equal(fence.publish(uri, 3, { version: 1, diagnostics: [{ message: 'late A' }] }).reason, 'older-version')
  assert.equal(fence.publish(uri, 3, { version: 2, diagnostics: [{ message: 'late B' }] }).reason, 'older-version')
  assert.deepEqual(fence.take(uri, 3)?.diagnostics, [{ message: 'current C' }])
  assert.deepEqual(fence.take(uri, 2)?.diagnostics, [{ message: 'late B' }])
})

test('Windows URI aliases share one canonical document identity without changing protocol spelling', async () => {
  const canonical = 'C:\\Workspace\\Café File.py'
  const resolveWindows = async (path: string) => path.toLowerCase().includes('café file.py') ? canonical : path
  const sync = new LspDocumentSynchronizer('win32', resolveWindows)
  const { notifications, notify } = recorder()
  const original = 'file:///C:/Workspace/Caf%C3%A9%20File.py'
  const alias = 'file:///c:/workspace/Caf%C3%A9%20File.py'
  assert.equal(await canonicalFileUriIdentity(original, 'win32', resolveWindows),
    await canonicalFileUriIdentity(alias, 'win32', resolveWindows))
  await sync.synchronize(original, 'python', 1, 'value = 1\n', notify)
  await sync.synchronize(alias, 'python', 2, 'value = 1\n', notify)
  const match = await sync.match(alias)
  assert.equal(sync.size, 1)
  assert.equal(match?.protocolUri, original)
  assert.equal(match?.rawUriMatched, false)
  assert.deepEqual(notifications.map(({ method }) => method), ['textDocument/didOpen'])
})

test('Windows physical identity does not merge a junction or alias resolving outside the document', async () => {
  const resolveWindows = async (path: string) => path.toLowerCase().includes('redirected')
    ? 'D:\\Outside\\main.py' : 'C:\\Workspace\\main.py'
  const sync = new LspDocumentSynchronizer('win32', resolveWindows)
  const { notifications, notify } = recorder()
  await sync.synchronize('file:///C:/Workspace/main.py', 'python', 1, 'value = 1\n', notify)
  await sync.synchronize('file:///C:/Redirected/main.py', 'python', 1, 'value = 1\n', notify)
  assert.equal(sync.size, 2)
  assert.equal(notifications.filter(({ method }) => method === 'textDocument/didOpen').length, 2)
})

test('Windows URI identity decodes spaces and Unicode and normalizes long equivalent paths through realpath', async () => {
  const longTail = Array.from({ length: 24 }, (_, index) => `folder-${index}`).join('\\')
  const canonical = `C:\\Workspace\\Café Space\\${longTail}\\main.py`
  const resolveWindows = async () => canonical
  const encoded = `file:///C:/Workspace/Caf%C3%A9%20Space/${longTail.replaceAll('\\', '/')}/main.py`
  const alias = `file:///c:/workspace/Cafe%CC%81%20Space/${longTail.toUpperCase().replaceAll('\\', '/')}/folder/../main.py`
  assert.equal(await canonicalFileUriIdentity(encoded, 'win32', resolveWindows),
    await canonicalFileUriIdentity(alias, 'win32', resolveWindows))
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

async function waitForDiagnosticFence(service: ExternalLspService) {
  for (let turn = 0; turn < 100 && service.pendingDiagnosticWaiterCount === 0; turn++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(service.pendingDiagnosticWaiterCount, 1, 'Diagnostic fence was not installed.')
}

test('a delayed unversioned A report cannot satisfy a synchronized B request', async () => {
  const { host, service } = await fakeService()
  const path = join(tmpdir(), 'ion-race-a-b.py')
  const uri = pathToFileURL(path).href
  try {
    await service.query(snapshot(path, 1, 'value = 1\n', 'hover'))
    await service.query(snapshot(path, 2, 'value = (\n', 'hover'))
    const pending = service.query(snapshot(path, 2, 'value = (\n', 'diagnostics'))
    await waitForDiagnosticFence(service)
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

test('an unversioned server exposes B only after the bounded stream advances beyond stale A', async () => {
  const { host, service } = await fakeService()
  const path = join(tmpdir(), 'ion-unversioned-a-b.py')
  const uri = pathToFileURL(path).href
  try {
    await service.query(snapshot(path, 1, 'value = 1\n', 'hover'))
    await service.query(snapshot(path, 2, 'value = (\n', 'hover'))
    const pending = service.query(snapshot(path, 2, 'value = (\n', 'diagnostics'))
    await waitForDiagnosticFence(service)
    await host.request('ion/publishDiagnostics', { uri, diagnostics: [diagnostic('stale A')] })
    await host.request('ion/publishDiagnostics', { uri, diagnostics: [diagnostic('current B')] })
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
    await waitForDiagnosticFence(service)
    await host.request('ion/publishDiagnostics', { uri, version: 2, diagnostics: [diagnostic('late B')] })
    await host.request('ion/publishDiagnostics', { uri, diagnostics: [diagnostic('late unversioned A')] })
    await host.request('ion/publishDiagnostics', { uri, version: 3, diagnostics: [diagnostic('current C')] })
    const result = await pending
    assert.deepEqual(result.rows.map(row => row[3]), ['current C'])
  } finally {
    await service.stop()
  }
})

test('diagnostic trace contains correlation metadata without paths or source content', async () => {
  const trace = join(tmpdir(), `ion-diagnostic-trace-${process.pid}-${Date.now()}.jsonl`)
  const previous = process.env.ION_LSP_DIAGNOSTIC_TRACE
  process.env.ION_LSP_DIAGNOSTIC_TRACE = trace
  const { host, service } = await fakeService()
  const path = join(tmpdir(), 'Private Project Name', 'secret source.py')
  const uri = pathToFileURL(path).href
  try {
    await service.query(snapshot(path, 1, 'private_source_text = 1\n', 'hover'))
    const pending = service.query(snapshot(path, 1, 'private_source_text = 1\n', 'diagnostics'))
    await host.request('ion/publishDiagnostics', { uri, version: 1, diagnostics: [diagnostic('private diagnostic text')] })
    await pending
    const evidence = await readFile(trace, 'utf8')
    assert.ok(evidence.includes('canonicalIdentityHash'))
    assert.ok(evidence.includes('diagnosticVersion'))
    for (const secret of [path, uri, 'Private Project Name', 'secret source.py', 'private_source_text', 'private diagnostic text']) {
      assert.equal(evidence.includes(secret), false)
    }
  } finally {
    await service.stop()
    if (previous === undefined) delete process.env.ION_LSP_DIAGNOSTIC_TRACE
    else process.env.ION_LSP_DIAGNOSTIC_TRACE = previous
    await rm(trace, { force: true })
  }
})
