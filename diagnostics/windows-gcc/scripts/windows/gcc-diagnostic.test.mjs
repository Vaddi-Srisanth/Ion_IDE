import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { inside, safeEnvironment, distribution, stageDurations, validateSample, summarize, sanitizeReport, sanitizeEvents, nativeRun, JsonHost, preparePackage, validateDiagnosticBudget } from './gcc-diagnostic.mjs'

const execute = promisify(execFile)
const event = (ms, stage, event) => ({ ms, stage, event })
function row(lane = 'B', overrides = {}) {
  return { kind: 'result', schemaVersion: 1, runId: 'warm-1-' + lane, lane, phase: 'warm', elapsedMs: 501,
    state: 'exited', exitCode: 0, outputComplete: true, cleanupVerified: true,
    events: [event(1, 'compiler-process', 'spawn-request'), event(3, 'compiler-process', 'spawned'),
      event(4, 'compiler-payload', 'ready-observed'), event(15, 'compiler-job', 'clean-observed'),
      event(16, 'compiler-process', 'exit-callback'), event(17, 'compiler-stdout', 'end'), event(18, 'compiler-stderr', 'end'),
      event(19, 'compiler-process', 'result-finalized'), event(500, 'adapter', 'result-delivered')], ...overrides }
}
test('one fixed compiler environment excludes personal and executable-injection variables', () => {
  const env = safeEnvironment('C:\\private\\disposable', 'C:\\toolchain\\bin\\gcc.exe', 'C:\\Windows')
  assert.equal(env.PATH, 'C:\\toolchain\\bin;C:\\Windows\\System32')
  assert.equal(env.HOME, 'C:\\private\\disposable\\home')
  assert.equal(env.TEMP, 'C:\\private\\disposable\\temp')
  for (const forbidden of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PYTHONPATH', 'GCC_EXEC_PREFIX', 'CPATH', 'LIBRARY_PATH']) assert.equal(env[forbidden], undefined)
  assert.equal(inside('C:\\test', 'C:\\test\\file', win32), true)
  for (const path of ['C:\\test-other\\file', 'D:\\test\\file', 'C:\\test\\..\\secret']) assert.equal(inside('C:\\test', path, win32), false)
})
test('compiler timing excludes C program/PTY elapsed time and distinguishes supervisor start', () => {
  const metrics = stageDurations(row('C'))
  assert.equal(metrics.compilerRequestToFinalizedMs, 18)
  assert.equal(metrics.adapterResultAfterFinalizedMs, 481)
  assert.match(metrics.startObservation, /supervisor/)
  assert.match(stageDurations(row('A')).startObservation, /actual GCC/)
  assert.equal(stageDurations({ lane: 'C', events: [] }).compilerRequestToFinalizedMs, null)
})
test('statistics preserve timeout outliers and withhold undersampled p95/p99', () => {
  const values = Array.from({ length: 99 }, () => 2).concat(15000)
  assert.equal(distribution(values).p99Ms, 2)
  assert.equal(distribution(values).maxMs, 15000)
  assert.equal(distribution(values.slice(0, 99)).p99Ms, null)
  assert.equal(distribution([2, 5]).p95Ms, null)
  const rows = [row(), row('B', { state: 'timeout', success: false, elapsedMs: 15010 })].map(r => ({ ...r, metrics: stageDurations(r) }))
  const result = summarize(rows, 303)
  assert.equal(result.groups['B/warm'].timeoutCount, 1)
  assert.equal(result.groups['B/warm'].totalAdapterIntervalNotComparableAcrossLanes.maxMs, 15010)
  assert.equal(result.unexecuted, 301); assert.equal(result.issueFixed, false)
})
test('sample identity, ordering, bounds and success are validated instead of trusted', () => {
  const good = row()
  assert.equal(validateSample(good, { id: good.runId, lane: 'B' }).success, true)
  assert.equal(validateSample({ ...good, success: true, exitCode: 1 }, { id: good.runId, lane: 'B' }).success, false)
  for (const change of [{ runId: 'wrong-run' }, { events: [event(2, 's', 'e'), event(1, 's', 'e')] },
    { elapsedMs: NaN }, { events: Array(257).fill(event(1, 's', 'e')) }]) {
    assert.throws(() => validateSample({ ...good, ...change }, { id: good.runId, lane: 'B' }))
  }
})
test('shareable results are reconstructed from whitelisted fields and cannot hide failed gates', () => {
  const secret = 'NEVER_SHARE_USERNAME_PATH_APIKEY_CONTENT'
  const raw = row('B', { success: true, state: 'timeout', stdoutTail: secret, stderrTail: secret,
    detail: secret, commandLine: secret, privatePath: secret, metrics: stageDurations(row()), events: [{ value: secret }] })
  const result = sanitizeReport({ schemaVersion: 1, provenance: 'native-windows-execution', platform: 'win32', architecture: 'x64',
    planned: 303, complete: true, samples: [raw], hostCleanupVerified: false, binariesUnchanged: false,
    sourceUnchanged: true, failure: secret, identity: { compilerPath: secret }, hardware: { cpu: secret } })
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.equal(result.samples[0].success, false)
  assert.equal(result.hostCleanupVerified, false); assert.equal(result.binariesUnchanged, false)
  assert.equal(result.diagnosticVerification, 'incomplete-or-failed')
  assert.equal(result.failurePresent, true); assert.equal(result.releaseStatus, 'held')
  assert.equal(result.provenance, 'native-windows-execution') // declaration, never proof of provenance
  assert.equal(sanitizeReport({ samples: [] }).provenance, 'not-native-measured')
  assert.deepEqual(sanitizeEvents([{ ms: 2, stage: secret, event: 'spawned' }, { ms: 3, stage: 'compiler-process', event: 'spawned', value: secret, pid: 123 }]),
    [{ ms: 3, stage: 'compiler-process', event: 'spawned', pid: 123 }])
})
test('native command refuses macOS before writing files or launching Electron', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(nativeRun({}), /genuine Windows/)
  await assert.rejects(execute(process.execPath, ['scripts/windows/gcc-diagnostic.mjs', '--run']), error => /genuine Windows/.test(error.stderr))
  await assert.rejects(execute(process.execPath, ['scripts/windows/gcc-diagnostic-host.cjs']), error => /No diagnostic host may launch on macOS/.test(error.stderr))
})
test('plan CLI starts no Windows process and marks all native measurements unavailable', async () => {
  const result = JSON.parse((await execute(process.execPath, ['scripts/windows/gcc-diagnostic.mjs', '--plan', '--samples', '100'])).stdout)
  assert.equal(result.samples.length, 303)
  assert.equal(result.compileMs, 15000)
  assert.equal(result.nativeMeasurements, 'not measured')
  assert.equal(result.retries, 0)
})
test('offline sanitizer reserves a new output and never overwrites existing evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ion-gcc-sanitize-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { writeFile } = await import('node:fs/promises')
  const source = join(root, 'private.json'), output = join(root, 'share.json')
  await writeFile(source, JSON.stringify({ samples: [] }))
  await execute(process.execPath, ['scripts/windows/gcc-diagnostic.mjs', '--sanitize', source, '--out', output])
  const before = await readFile(output)
  await assert.rejects(execute(process.execPath, ['scripts/windows/gcc-diagnostic.mjs', '--sanitize', source, '--out', output]), error => /EEXIST/.test(error.stderr))
  assert.deepEqual(await readFile(output), before)
})
test('actual JSONL child transport preserves split UTF-8, live events, stderr and normal shutdown', async t => {
  const script = `const b=Buffer.from(JSON.stringify({kind:'event',text:'λ🙂'})+'\\n');
    for(let i=0;i<b.length;i++)setTimeout(()=>process.stdout.write(b.subarray(i,i+1)),i);
    process.stderr.write('private fixture stderr');
    process.stdin.on('data',()=>process.exit(0));`
  const host = new JsonHost(process.execPath, ['-e', script], {})
  t.after(() => host.kill())
  const item = await host.next(3000)
  assert.equal(item.text, 'λ🙂')
  const result = await host.close()
  assert.equal(result.normal, true); assert.equal(result.code, 0)
  assert.match(host.errorTail, /fixture stderr/)
  assert.throws(() => process.kill(host.child.pid, 0), { code: 'ESRCH' })
})
test('actual malformed-protocol child is stopped; failure never becomes a successful sample', async t => {
  const host = new JsonHost(process.execPath, ['-e', 'process.stdout.write("invalid-json\\n");setInterval(()=>{},1000)'], {})
  t.after(() => host.kill())
  await assert.rejects(host.next(3000), /JSON|Unexpected/)
  await host.closed
  assert.ok(host.error)
  assert.throws(() => process.kill(host.child.pid, 0), { code: 'ESRCH' })
})
test('prepared package runs offline plan/sanitizer without repository or node_modules and refuses overwrite', { skip: existsSync(new URL('./gcc-package.json', import.meta.url)) ? 'Standalone fixture already prepared; package-builder integration passed separately in source checkout, which has esbuild and handoff inputs.' : false }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ion-gcc-package-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const destination = join(root, 'package')
  const result = await preparePackage(destination)
  assert.equal(result.manifest.compileMs, 15000)
  const { createHash } = await import('node:crypto')
  for (const file of result.manifest.sourceFiles) assert.equal(createHash('sha256').update(await readFile(join(destination, file.path))).digest('hex'), file.sha256)
  const cli = join(destination, 'scripts/windows/gcc-diagnostic.mjs')
  const plan = JSON.parse((await execute(process.execPath, [cli, '--plan', '--samples', '30'], { cwd: root })).stdout)
  assert.equal(plan.samples.length, 93)
  assert.equal(plan.nativeMeasurements, 'not measured')
  await execute(process.execPath, ['--check', join(destination, 'scripts/windows/gcc-production-adapter.cjs')])
  await assert.rejects(preparePackage(destination), { code: 'EEXIST' })
  assert.equal(JSON.parse(await readFile(join(destination, 'scripts/windows/gcc-package.json'), 'utf8')).adapterSha256, result.manifest.adapterSha256)
})

test('whole-session budget is bounded separately from the unchanged compiler deadline', async () => {
  assert.equal(validateDiagnosticBudget(), 600000)
  for (const value of [0, -1, 59999, 900001, NaN, Infinity, '600000']) assert.throws(() => validateDiagnosticBudget(value))
  const result = JSON.parse((await execute(process.execPath, ['scripts/windows/gcc-diagnostic.mjs', '--plan', '--samples', '30', '--first-lane', 'C', '--max-duration-ms', '60000'])).stdout)
  assert.equal(result.diagnosticBudgetMs, 60000)
  assert.equal(result.compileMs, 15000)
  assert.equal(result.firstLane, 'C')
  assert.equal(result.samples[0].id, 'first-C')
})

test('persistent host premature exit cannot be counted as a normal requested shutdown; one-shot exit is explicit', async t => {
  for (const oneShot of [false, true]) {
    const host = new JsonHost(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({kind:"host-ready"})+"\\n");'], { oneShot })
    t.after(() => host.kill())
    assert.equal((await host.next(3000)).kind, 'host-ready')
    await host.closed
    const result = await host.close()
    assert.equal(result.closedBeforeQuit, true)
    assert.equal(result.normal, oneShot)
  }
})

test('one-shot result transport works when child stdin is already closed and final output is flushed', async t => {
  const script = `process.stdin.destroy();process.stdout.write(JSON.stringify({kind:'host-ready'})+'\\n');
    process.stdout.write(JSON.stringify({kind:'result',runId:'first-C',padding:'x'.repeat(50000)})+'\\n',()=>{});`
  const host = new JsonHost(process.execPath, ['-e', script], { oneShot: true })
  t.after(() => host.kill())
  assert.equal((await host.next(3000)).kind, 'host-ready')
  const result = await host.next(3000)
  assert.equal(result.kind, 'result'); assert.equal(result.padding.length, 50000)
  const closed = await host.close()
  assert.equal(closed.normal, true); assert.equal(closed.code, 0)
})

test('observer failure exports strict structured fields and never becomes successful despite valid compiler exit', () => {
 const secret='PRIVATE_PATH_OR_TOKEN'
 const raw=row('A',{observerFailure:{category:'membership-invariant',managedType:'System.InvalidOperationException',nativeErrorCode:87,operation:'job-member-counts',lifecycleStage:'cleanup',ownedProcessAlreadyExited:true,cleanupCompleted:true,compilerResultValid:true,detail:secret},observerFailureCount:1,compilerResultValid:true})
 const result=sanitizeReport({samples:[raw]}).samples[0]
 assert.equal(result.success,false);assert.equal(result.observerFailure.operation,'job-member-counts');assert.equal(result.compilerResultValid,true)
 assert.ok(!JSON.stringify(result).includes(secret));assert.equal(validateSample(raw,{id:raw.runId,lane:'A'}).success,false)
 raw.observerFailure={category:secret,managedType:secret,operation:secret,lifecycleStage:secret,nativeErrorCode:secret}
 assert.ok(!JSON.stringify(sanitizeReport({samples:[raw]})).includes(secret))
})
