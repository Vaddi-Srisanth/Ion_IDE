// Real filesystem/collector tests with explicitly synthetic timing records.
// No PowerShell, Windows API, GCC or Electron is executed here.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { collect, metadata } from './gcc-actions.mjs'

let packageDirectory = fileURLToPath(new URL('../../', import.meta.url))
try { await readFile(new URL('./gcc-package.json', import.meta.url)) }
catch { packageDirectory = resolve('release-blockers/gcc-handoff/ion-gcc-diagnostic-package') }
const secret = 'DO_NOT_PUBLISH_PRIVATE_PATH_KEY_OR_COMPILER_OUTPUT'
const event = (ms, stage, event) => ({ ms, stage, event })
function sample(id, overrides = {}) {
  return { schemaVersion: 1, kind: 'result', runId: id, lane: id.at(-1), phase: id.startsWith('first-') ? 'first-compile-exposure' : 'warm',
    state: 'exited', exitCode: 0, elapsedMs: 10, cleanupVerified: true, outputComplete: true,
    stdoutTail: secret, stderrTail: secret, detail: secret, compilerPath: secret,
    events: [event(1, 'compiler-process', 'spawn-request'), event(2, 'compiler-process', 'spawned'),
      event(3, 'compiler-payload', 'ready-observed'), event(6, 'compiler-job', 'clean-observed'),
      event(7, 'compiler-process', 'exit-callback'), event(8, 'compiler-process', 'close'),
      event(9, 'compiler-process', 'result-finalized')], ...overrides }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ion-gcc-ci-collector-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'run')
  await mkdir(join(workspace, 'raw'), { recursive: true })
  return { root, workspace, output: join(root, 'artifacts', 'collection') }
}
const collectFixture = f => collect({ package: packageDirectory, workspace: f.workspace, out: f.output, samples: 30, firstLane: 'A' })
async function ledger(workspace, rows, { omitStart = false } = {}) {
  const records = rows.flatMap(row => [
    ...(!omitStart ? [{ kind: 'attempt-start', id: row.runId, lane: row.lane }] : []),
    { kind: 'attempt-complete', runId: row.runId, lane: row.lane, success: row.state === 'exited', cleanupVerified: row.cleanupVerified, elapsedMs: row.elapsedMs, private: secret }])
  await writeFile(join(workspace, 'attempts.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n')
}
async function raw(workspace, row, { final = true, trace = true } = {}) {
  if (final) await writeFile(join(workspace, 'raw', row.runId + '.json'), JSON.stringify(row))
  if (trace) await writeFile(join(workspace, 'raw', row.runId + '.events.jsonl'), [
    ...row.events.map(e => ({ ...e, kind: 'event', runId: row.runId, lane: row.lane, private: secret })), row,
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
}
async function artifactText(root) {
  const strings = []
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isDirectory()) strings.push(await artifactText(join(root, e.name)))
    else strings.push(await readFile(join(root, e.name), 'utf8'))
  }
  return strings.join('\n')
}

test('native metadata refuses macOS before creating artifacts or executing tools', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await assert.rejects(metadata({ package: packageDirectory, gcc: 'C:\\mingw64\\bin\\gcc.exe', helper: 'C:\\tools\\helper.exe', out: join(f.root, 'metadata.json') }), /genuine Windows/)
  await assert.rejects(readFile(join(f.root, 'metadata.json')), { code: 'ENOENT' })
})
test('missing workspace still produces failure-safe artifacts with no invented timings', async t => {
  const f = await fixture(t)
  const result = await collect({ package: packageDirectory, workspace: join(f.root, 'absent'), out: f.output, samples: 100, firstLane: 'C' })
  assert.equal(result.diagnosticVerification, 'incomplete-or-failed')
  assert.equal(result.planned, 303); assert.equal(result.observedAttemptCount, 0)
  assert.equal(result.groups['A/warm'].primaryCompilerInterval.medianMs, null)
  assert.ok(result.evidenceGaps.includes('workspace-missing-or-redirected'))
  assert.equal(result.releaseStatus, 'held')
})
test('failed and slow samples survive sanitization and retain their numeric lifecycle evidence', async t => {
  const f = await fixture(t), row = sample('warm-1-B', { state: 'timeout', exitCode: 125, elapsedMs: 15020 })
  await ledger(f.workspace, [row]); await raw(f.workspace, row)
  const result = await collectFixture(f)
  assert.equal(result.groups['B/warm'].timeoutCount, 1)
  assert.equal(result.groups['B/warm'].totalAdapterIntervalNotComparableAcrossLanes.maxMs, 15020)
  assert.equal(result.samples[0].success, false)
  const safe = JSON.parse(await readFile(join(f.output, 'samples/warm-1-B.result.json'), 'utf8'))
  assert.equal(safe.events[0].stage, 'compiler-process')
  assert.ok(!('stdoutTail' in safe))
  assert.ok(!(await artifactText(f.output)).includes(secret))
})
test('live final result is recovered if host dies before writing final row/report; original final row wins', async t => {
  const f = await fixture(t), live = sample('first-A', { elapsedMs: 15000, state: 'timeout' })
  await ledger(f.workspace, [live]); await raw(f.workspace, live, { final: false })
  const result = await collectFixture(f)
  assert.equal(result.measuredResultCount, 1)
  assert.equal(result.samples[0].elapsedMs, 15000)
  assert.equal(result.samples[0].recoveredFromLiveMessage, true)
  assert.ok(result.evidenceGaps.includes('result-recovered-from-live-trace-without-final-row'))
  assert.equal(result.diagnosticVerification, 'incomplete-or-failed')
  const g = await fixture(t), original = sample('first-A', { elapsedMs: 12 })
  await ledger(g.workspace, [original]); await raw(g.workspace, live)
  await writeFile(join(g.workspace, 'raw/first-A.json'), JSON.stringify(original))
  const disagreement = await collectFixture(g)
  assert.equal(disagreement.samples[0].elapsedMs, 12)
  assert.ok(disagreement.evidenceGaps.includes('live-and-final-result-disagree'))
})
test('unfinished and completed-only ledger attempts remain visible with unavailable durations', async t => {
  const f = await fixture(t)
  await writeFile(join(f.workspace, 'attempts.jsonl'), [
    { kind: 'attempt-start', id: 'first-A', lane: 'A' },
    { kind: 'attempt-complete', runId: 'first-B', lane: 'B', cleanupVerified: false, elapsedMs: null },
  ].map(v => JSON.stringify(v)).join('\n') + '\n')
  const result = await collectFixture(f)
  assert.equal(result.observedAttemptCount, 2)
  assert.equal(result.unfinishedAttempts.length, 2)
  assert.ok(result.unfinishedAttempts.every(row => row.elapsedMs === null && !row.cleanupVerified))
  assert.ok(result.evidenceGaps.includes('completion-without-start'))
})
test('corrupted lines and redirected or oversized raw files become coverage gaps; private text never published', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside-private.json')
  await writeFile(outside, JSON.stringify(sample('first-A')))
  await writeFile(join(f.workspace, 'attempts.jsonl'), '{broken-private-json-' + secret)
  try { await symlink(outside, join(f.workspace, 'raw/first-A.json')) }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
    // Ordinary Windows users need no symlink privilege to run this suite.
    // The platform-independent size-bound rejection remains exercised there.
    await writeFile(join(f.workspace, 'raw/first-A.json'), secret.repeat(6000))
  }
  await writeFile(join(f.workspace, 'raw/first-B.events.jsonl'), JSON.stringify({ kind: 'event', runId: 'first-B', lane: 'B', ms: 1, stage: secret, event: 'spawned' }) + '\n' + secret)
  const result = await collectFixture(f)
  assert.equal(result.diagnosticVerification, 'incomplete-or-failed')
  assert.ok(result.evidenceGaps.includes('raw-evidence-invalid-or-oversized'))
  assert.ok(result.evidenceGaps.includes('partial-trace-malformed-or-truncated'))
  assert.ok(!(await artifactText(f.output)).includes(secret))
})
test('collector refuses an existing output directory rather than merging private files into artifacts', async t => {
  const f = await fixture(t)
  await mkdir(f.output, { recursive: true })
  await writeFile(join(f.output, 'private.txt'), secret)
  await assert.rejects(collectFixture(f), { code: 'EEXIST' })
  assert.equal(await readFile(join(f.output, 'private.txt'), 'utf8'), secret)
})
test('complete synthetic fixture passes only with all 93 results, live traces, ledger, preservation and host cleanup', async t => {
  const f = await fixture(t), rows = ['A', 'B', 'C'].flatMap(lane => [sample('first-' + lane), ...Array.from({ length: 30 }, (_, i) => sample('warm-' + (i + 1) + '-' + lane))])
  await ledger(f.workspace, rows)
  for (const row of rows) await raw(f.workspace, row)
  await writeFile(join(f.workspace, 'report-private.json'), JSON.stringify({ samples: rows, planned: 93, complete: true,
    hostCleanupVerified: true, binariesUnchanged: true, sourceUnchanged: true, privatePath: secret }))
  const result = await collectFixture(f)
  assert.equal(result.diagnosticVerification, 'completed-review-required')
  assert.equal(result.measuredResultCount, 93)
  assert.equal(result.groups['C/warm'].primaryCompilerInterval.count, 30)
  assert.equal(result.groups['C/warm'].primaryCompilerInterval.p99Ms, null)
  assert.equal(result.issueFixed, false)
  assert.ok(!(await artifactText(f.output)).includes(secret))
})

test('missing live trace and startup/host failures remain explicit instead of a false clean summary', async t => {
  const f = await fixture(t), row = sample('first-B')
  await ledger(f.workspace, [row]); await raw(f.workspace, row, { trace: false })
  await writeFile(join(f.workspace, 'report-private.json'), JSON.stringify({ samples: [row], planned: 93, failure: secret,
    diagnosticBudgetExpired: true, hostShutdown: [{ lane: 'B', pid: 123, normal: false, exited: true, code: 1, signal: secret, stderrTail: secret }] }))
  const result = await collectFixture(f)
  assert.ok(result.evidenceGaps.includes('live-trace-missing'))
  assert.equal(result.finalReportFailurePresent, true)
  assert.equal(result.diagnosticBudgetExpired, true)
  assert.deepEqual(result.hostShutdown, [{ lane: 'B', pid: 123, normal: false, exited: true, closedBeforeQuit: false, code: 1, signal: null }])
  assert.ok(!(await artifactText(f.output)).includes(secret))
})

test('host failures preserve only a safe source location, code and message hash', async t => {
  const { createRequire } = await import('node:module')
  const { safeHostError } = createRequire(import.meta.url)('./gcc-diagnostic-errors.cjs')
  const error = new Error(secret); error.code = 'ERR_ASSERTION'
  error.stack = 'Error: '+secret+'\n at attempt (C:\\private\\gcc-diagnostic-host.cjs:73:12)'
  const safe = safeHostError(error)
  assert.equal(safe.code, 'ERR_ASSERTION'); assert.equal(safe.line, 73)
  assert.ok(!JSON.stringify(safe).includes(secret)); assert.match(safe.messageSha256, /^[a-f0-9]{64}$/)
  const f = await fixture(t), row = sample('first-C', { state: 'error', exitCode: null, cleanupVerified: false })
  await ledger(f.workspace, [row]); await raw(f.workspace, row)
  await writeFile(join(f.workspace, 'raw/first-C.events.jsonl'), JSON.stringify({ kind: 'host-error', lane: 'C', message: secret, error: safe })+'\n')
  const result = await collectFixture(f)
  const trace = JSON.parse(await readFile(join(f.output, 'samples/first-C.timeline.json'), 'utf8'))
  assert.deepEqual(trace.hostErrors, [safe]); assert.ok(result.evidenceGaps.includes('diagnostic-host-error-retained'))
  assert.ok(!(await artifactText(f.output)).includes(secret))
})
