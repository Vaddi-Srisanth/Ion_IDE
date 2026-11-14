import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import type { Readable } from 'node:stream'
import { monitorWindowsPipeProcess } from '../src/main/windows-process'
import type { RunTrace } from '../src/main/run-console/trace'

// These use real local child processes and fd3 pipes on the host OS. They
// verify parser/Node IO behavior, not Windows Job APIs or descendant ownership.
function fixture(t: TestContext, script: string, executable = process.execPath, control = true, trace?: RunTrace) {
  const child = spawn(executable, ['-e', script], {
    windowsHide: true, stdio: control ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  const failures: string[] = []
  const spawnErrors: Error[] = []
  child.on('error', error => spawnErrors.push(error))
  const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
    child.once('close', (code, signal) => resolve([code, signal]))
  })
  const monitor = monitorWindowsPipeProcess(child, message => failures.push(message), trace)
  child.stdout.resume()
  child.stderr.resume()
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    child.stdin.destroy()
    const status = child.stdio[3] as Readable | undefined
    status?.resume()
    await closed
    monitor.dispose()
  })
  return { child, monitor, closed, failures, spawnErrors }
}

test('optional pipe trace distinguishes parsed payload identity and cleanup receipt without retaining listeners', { timeout: 5000 }, async t => {
  const records: { stage: string; event: string; value?: number | string | boolean | null }[] = []
  const trace: RunTrace = (stage, event, value) => records.push({ stage, event, value })
  // Deliberately different from the fake supervisor's own PID. This proves the
  // parser reports the READY payload, not child.pid. No native Windows claim.
  const script = "require('node:fs').writeSync(3,'READY 42\\nCLEAN\\n');"
  const sample = fixture(t, script, process.execPath, true, trace)
  await sample.closed
  assert.equal(await sample.monitor.finished, true)
  assert.deepEqual(records, [
    { stage: 'compiler-payload', event: 'ready-observed', value: 42 },
    { stage: 'compiler-job', event: 'clean-observed', value: undefined },
  ])
  const status = sample.child.stdio[3] as Readable
  assert.equal(status.listenerCount('data'), 0)
  assert.equal(status.listenerCount('error'), 0)
  sample.monitor.dispose()

  const disabled = fixture(t, script)
  await disabled.closed
  assert.equal(await disabled.monitor.finished, true)
  assert.equal(records.length, 2, 'Omitting tracing introduces no extra records or observer.')
  const invalid = fixture(t, "require('node:fs').writeSync(3,'READY NaN\\nCLEAN\\n');", process.execPath, true, trace)
  await invalid.closed
  assert.equal(await invalid.monitor.finished, false)
  assert.equal(records.length, 2, 'An unvalidated payload must not produce a trusted identity marker.')
})

test('pipe status parser accepts READY and CLEAN split across actual IO events', { timeout: 5000 }, async t => {
  const sample = fixture(t, `
    const fs = require('node:fs');
    const parts = ['RE', 'ADY ' + process.pid + '\\nCL', 'EAN\\n'];
    let next = 0;
    process.stdin.on('data', () => {
      if (++next < parts.length) fs.writeSync(3, parts[next]);
      else process.exit(0);
    });
    fs.writeSync(3, parts[0]);
  `)
  let events = 0
  const status = sample.child.stdio[3] as Readable
  status.on('data', () => { events++; sample.child.stdin.write('next\n') })
  assert.equal(sample.monitor.verified, false)
  assert.deepEqual(await sample.closed, [0, null])
  assert.equal(events, 3, 'Each fragment is acknowledged before the child writes the next fragment.')
  assert.equal(await sample.monitor.finished, true)
  assert.equal(sample.monitor.verified, true)
  assert.deepEqual(sample.failures, [])
})

test('pipe status distinguishes real exit 125 from supervisor ERROR', { timeout: 5000 }, async t => {
  const actual = fixture(t, `const fs=require('node:fs'); fs.writeSync(3,'READY '+process.pid+'\\nCLEAN\\n'); process.exit(125);`)
  assert.deepEqual(await actual.closed, [125, null])
  assert.equal(await actual.monitor.finished, true)
  assert.deepEqual(actual.failures, [])

  const failed = fixture(t, `require('node:fs').writeSync(3,'ERROR 2\\n'); process.exit(125);`)
  assert.deepEqual(await failed.closed, [125, null])
  assert.equal(await failed.monitor.finished, false)
  assert.match(failed.monitor.detail ?? '', /failed \(2\)/)
  assert.equal(failed.failures.length, 1)
})

test('pipe status verification waits for queued fd3 bytes after child exit', { timeout: 5000 }, async t => {
  const sample = fixture(t, `require('node:fs').writeSync(3,'READY '+process.pid+'\\nCLEAN\\n');`)
  const status = sample.child.stdio[3] as Readable
  status.pause()
  await once(sample.child, 'exit')
  assert.equal(sample.monitor.verified, false, 'Leader exit alone does not establish that status bytes were consumed.')
  status.resume()
  assert.deepEqual(await sample.closed, [0, null])
  assert.equal(await sample.monitor.finished, true)
  assert.equal(sample.monitor.verified, true)
  assert.deepEqual(sample.failures, [])
})

test('pipe status rejects incomplete final status at actual EOF', { timeout: 5000 }, async t => {
  const sample = fixture(t, `require('node:fs').writeSync(3,'READY '+process.pid+'\\nCLE');`)
  await sample.closed
  assert.equal(await sample.monitor.finished, false)
  assert.match(sample.monitor.detail ?? '', /ended mid-message/)
})

test('pipe status does not verify a READY-only child', { timeout: 5000 }, async t => {
  const sample = fixture(t, `require('node:fs').writeSync(3,'READY '+process.pid+'\\n');`)
  await sample.closed
  assert.equal(await sample.monitor.finished, false)
  assert.equal(sample.monitor.verified, false)
})

test('pipe status bounds oversized invalid input and reports failure once', { timeout: 5000 }, async t => {
  const sample = fixture(t, `const fs=require('node:fs'); fs.writeSync(3,'X'.repeat(8192)); fs.writeSync(3,'Y'.repeat(8192));`)
  await sample.closed
  assert.equal(await sample.monitor.finished, false)
  assert.equal(sample.failures.length, 1)
  assert.match(sample.monitor.detail ?? '', /invalid status/)
})

test('pipe status rejects CLEAN before READY and duplicate completion', { timeout: 5000 }, async t => {
  for (const message of ['CLEAN\n', 'READY 1\nCLEAN\nCLEAN\n']) {
    const sample = fixture(t, `require('node:fs').writeSync(3,${JSON.stringify(message)});`)
    await sample.closed
    assert.equal(await sample.monitor.finished, false)
    assert.equal(sample.failures.length, 1)
  }
})

test('pipe status force flag prevents a later CLEAN from claiming verified cleanup', { timeout: 5000 }, async t => {
  const sample = fixture(t, `require('node:fs').writeSync(3,'READY '+process.pid+'\\nCLEAN\\n');`)
  sample.monitor.markForced()
  await sample.closed
  assert.equal(await sample.monitor.finished, false)
  assert.equal(sample.monitor.verified, false)
  assert.deepEqual(sample.failures, [])
})

test('pipe status handles a real missing executable and absent status channel', { timeout: 5000 }, async t => {
  const missing = join(tmpdir(), 'ion-no-such-executable-' + crypto.randomUUID())
  let sample: ReturnType<typeof fixture> | undefined
  assert.doesNotThrow(() => { sample = fixture(t, '', missing) })
  assert.ok(sample)
  await sample.closed
  assert.equal(await sample.monitor.finished, false)
  assert.equal(sample.monitor.verified, false)
  assert.equal(sample.spawnErrors.length, 1)
  assert.equal((sample.spawnErrors[0] as NodeJS.ErrnoException).code, 'ENOENT')
})


test('private fd4 Stop is idempotent, acknowledged and separate from program stdin', { timeout: 5000 }, async t => {
  const sample = fixture(t, `
    const fs = require('node:fs');
    fs.writeSync(3, 'READY '+process.pid+'\\n');
    process.stdin.on('data', bytes => process.stdout.write('program:' + bytes));
    let request = '';
    fs.createReadStream(null, {fd:4, autoClose:false}).on('data', bytes => {
      request += bytes;
      if (request === 'S\\n') { fs.writeSync(3, 'CLEAN\\n'); process.exit(125); }
      else if (request.length >= 2) process.exit(125);
    });
  `)
  const output = once(sample.child.stdout, 'data')
  sample.child.stdin.write('ordinary-input')
  assert.equal(String((await output)[0]), 'program:ordinary-input')
  const first = sample.monitor.requestStop()
  assert.equal(sample.monitor.requestStop(), first)
  assert.equal(await first, true)
  assert.deepEqual(await sample.closed, [125, null])
  assert.equal(sample.monitor.verified, true)
  assert.deepEqual(sample.failures, [])
})

test('private Stop without fd4 falls back without claiming CLEAN', { timeout: 5000 }, async t => {
  const sample = fixture(t, `require('node:fs').writeSync(3,'READY '+process.pid+'\\n');setInterval(()=>{},1000);`, process.execPath, false)
  await once(sample.child.stdio[3]!, 'data')
  assert.equal(await sample.monitor.requestStop(), false)
  await sample.closed
  assert.equal(sample.monitor.verified, false)
  assert.match(sample.monitor.detail ?? '', /cleanup is unverified/)
})

test('private Stop has a bounded unresponsive-supervisor fallback', { timeout: 8000 }, async t => {
  const sample = fixture(t, `
    const fs = require('node:fs');
    fs.writeSync(3,'READY '+process.pid+'\\n');
    fs.createReadStream(null,{fd:4,autoClose:false}).resume();
    setInterval(()=>{},1000);
  `)
  await once(sample.child.stdio[3]!, 'data')
  const before = Date.now()
  assert.equal(await sample.monitor.requestStop(), false)
  await sample.closed
  assert.equal(sample.monitor.verified, false)
  assert.match(sample.monitor.detail ?? '', /cleanup is unverified/)
  assert.ok(Date.now() - before < 7000, 'The fallback is bounded, not an application performance benchmark.')
})

test('Stop racing natural exit preserves a valid CLEAN still queued on fd3', { timeout: 5000 }, async t => {
  const sample = fixture(t, `require('node:fs').writeSync(3,'READY '+process.pid+'\\nCLEAN\\n');process.exit(0);`)
  const status = sample.child.stdio[3] as Readable
  status.pause()
  await once(sample.child, 'exit')
  assert.equal(sample.child.exitCode, 0)
  assert.equal(sample.monitor.verified, false, 'The final status is deliberately not consumed yet.')
  // The private control pipe may already be closed or return EPIPE here.
  // Neither case should invalidate a queued CLEAN from an already-exited helper.
  const stopping = sample.monitor.requestStop()
  status.resume()
  assert.deepEqual(await sample.closed, [0, null])
  assert.equal(await stopping, true)
  assert.equal(sample.monitor.verified, true)
  assert.equal(sample.monitor.detail, undefined)
  assert.deepEqual(sample.failures, [])
})
