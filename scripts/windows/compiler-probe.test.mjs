import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compilerProbeTargets, parseCompilerProbe } from './compiler-probe.mjs'

test('live compiler diagnostics use only correlated numeric helper and payload identities', () => {
  const records = [{ kind: 'spawn-call', id: 1, executable: 'ion-pty.exe', payload: 'gcc.exe' },
    { kind: 'spawn-return', id: 1, pid: 123 }, { kind: 'native-status', id: 1, status: 'READY', payloadPid: 456 }]
  assert.deepEqual(compilerProbeTargets({ records }), [123, 456])
  assert.equal(compilerProbeTargets({ records: records.slice(1) }), null)
  assert.equal(compilerProbeTargets({ records: records.map(row => ({ ...row, payloadPid: '456 OR true' })) }), null)
})

test('bounded snapshot preserves actual process and thread wait evidence and refuses incomplete data', () => {
  const text = 'IONCOMPILER1\nP|456|123|639302215957483910|0|Z2NjLmV4ZQ==\nT|456|789|Wait|Suspended|0\nEND|1|1\n'
  const snapshot = parseCompilerProbe(text)
  assert.equal(snapshot.processes[0].name, 'gcc.exe')
  assert.equal(snapshot.threads[0].wait, 'Suspended')
  for (const bad of [text.replace('END|1|1', ''), text.replace('END|1|1', 'END|0|1'),
    text.replace('Z2NjLmV4ZQ==', 'Z2NjLmV4ZQ'), text.replace('|Wait|', '|Wait|extra|'),
    text.replace('456|123', '-1|123'), text + 'extra\n', '']) assert.throws(() => parseCompilerProbe(bad))
  assert.throws(() => parseCompilerProbe('x'.repeat(128 * 1024 + 1)))
})
