import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCurrentDiagnosticReport, LspDocumentSynchronizer } from '../src/main/language-tools/lsp-adapter'

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

test('unversioned diagnostics cannot satisfy a request after the document changes', () => {
  const unversioned = { diagnostics: [] }
  assert.equal(isCurrentDiagnosticReport(unversioned, 4, true), false)
  assert.equal(isCurrentDiagnosticReport(unversioned, 4, false), true)
  assert.equal(isCurrentDiagnosticReport({ version: 3, diagnostics: [] }, 4, true), false)
  assert.equal(isCurrentDiagnosticReport({ version: 4, diagnostics: [] }, 4, true), true)
})
