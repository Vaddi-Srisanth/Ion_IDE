import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendTerminalInput } from '../src/renderer/run-console/xterm'
import { RunConsoleStore } from '../src/renderer/run-console/store'

test('terminal input sends complete bounded Unicode input without splitting surrogate pairs', () => {
  const text = 'a'.repeat(4999) + '🌍'.repeat(4000) + '\r'
  const parts: string[] = []
  assert.equal(sendTerminalInput(text, chunk => parts.push(chunk)), true)
  assert.equal(parts.join(''), text)
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part) <= 16 * 1024)
    assert.doesNotMatch(part, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u)
  }
})

test('oversized ordinary and bracketed pastes are rejected atomically, never clipped', () => {
  for (const text of ['x'.repeat(16001), '\x1b[200~' + 'x'.repeat(20000) + '\x1b[201~']) {
    const parts: string[] = []
    assert.equal(sendTerminalInput(text, chunk => parts.push(chunk)), false)
    assert.deepEqual(parts, [])
  }
})

test('input rejection is visible and leaves the active program and transcript intact', () => {
  const store = new RunConsoleStore()
  store.start('input.c', false)
  store.update({ kind: 'phase', phase: 'running' })
  store.update({ kind: 'data', stream: 'terminal', text: 'Enter input: ' })
  const before = store.getSnapshot()
  store.inputRejected()
  assert.equal(store.getSnapshot().phase, 'running')
  assert.equal(store.getSnapshot().run, before.run)
  assert.equal(store.getSnapshot().hasOutput, true)
  assert.match(store.getSnapshot().error!, /not sent/)
})
