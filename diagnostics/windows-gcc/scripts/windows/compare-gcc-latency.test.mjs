import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { analyzeReceipts, boundedUtf8Tail, compactJournalSample, comparisonPlan, productionCompileLimit,
  reserveNativeEvidence, timingStatistics } from './compare-gcc-latency.mjs'

// Synthetic unit-test receipts only. These tests are not Windows measurements.
const sha = text => createHash('sha256').update(text).digest('hex')
const plan = comparisonPlan({ sampleCount: 30, compileMs: 15000 })
function row(index, overrides = {}) {
  const sample = plan.samples[index]
  return { ...sample, state: 'exited', exitCode: 0, elapsedMs: index + 1,
    stdoutTail: '', stderrTail: '', outputComplete: true, cleanupVerified: true, sourceUnchanged: true,
    compileDeadlineMs: 15000, ownershipMethod: plan.laneDefinitions[sample.lane].ownership,
    identity: { compilerPath: 'C:\\Tools\\GCC\\bin\\gcc.exe', compilerSha256: sha('fixture compiler'),
      compilerVersion: 'synthetic fixture, never executed', sourceSha256: plan.workload.sourceSha256,
      cwd: 'C:\\private\\fixture', argv: ['-x', 'c', 'fixture.c', '-o', 'fixture.exe'],
      environmentSha256: sha('fixture environment'), measurementBoundary: 'synthetic unit-test boundary' },
    ...overrides }
}
const receipt = samples => ({ schemaVersion: 1, platform: 'win32', architecture: 'x64', provenance: 'native-execution', samples })

test('production deadline comes from the real runner and rejects expressions or fallback values', async () => {
  const source = await readFile(new URL('../../src/main/runner.ts', import.meta.url), 'utf8')
  assert.equal(productionCompileLimit(source), 15000)
  assert.throws(() => productionCompileLimit('export const defaultRunLimits = { compileMs: getLimit(), outputBytes: 1 }'))
  assert.throws(() => productionCompileLimit('export const defaultRunLimits = { compileMs: 15_000 * 2, outputBytes: 1 }'))
  assert.throws(() => productionCompileLimit('export const defaultRunLimits = { compileMs: 1__500, outputBytes: 1 }'))
})

test('first exposure is separate; warm scheduling rotates without retries or omitted lanes', () => {
  assert.deepEqual(plan.samples.slice(0, 3).map(row => row.id), ['first-A', 'first-B', 'first-C'])
  assert.deepEqual(plan.samples.slice(3, 12).map(row => row.lane), ['A', 'B', 'C', 'B', 'C', 'A', 'C', 'A', 'B'])
  assert.equal(plan.samples.length, 93)
  assert.equal(new Set(plan.samples.map(row => row.id)).size, 93)
  for (const lane of ['A', 'B', 'C']) assert.equal(plan.samples.filter(row => row.lane === lane && row.phase === 'warm').length, 30)
  assert.equal(plan.retries, 0)
  assert.match(plan.firstExposurePolicy, /Not independent OS-cold/)
  assert.match(plan.laneDefinitions.C.scope, /engine-only, not a UI paint test/)
  assert.throws(() => comparisonPlan({ sampleCount: 29, compileMs: 15000 }))
  assert.throws(() => comparisonPlan({ sampleCount: 101, compileMs: 15000 }))
  assert.throws(() => comparisonPlan({ sampleCount: 30 }))
})

test('statistics use explicit nearest-rank percentiles, real median and null for unmeasured values', () => {
  assert.deepEqual(timingStatistics([8, 1, 4, 2]), { count: 4, medianMs: 3, p95Ms: 8, p99Ms: 8, maxMs: 8 })
  const values = Array.from({ length: 100 }, (_, index) => index + 1)
  assert.deepEqual(timingStatistics(values), { count: 100, medianMs: 50.5, p95Ms: 95, p99Ms: 99, maxMs: 100 })
  assert.deepEqual(timingStatistics([]), { count: 0, medianMs: null, p95Ms: null, p99Ms: null, maxMs: null })
  for (const invalid of [[NaN], [Infinity], [-1], ['15']]) assert.throws(() => timingStatistics(invalid))
})

test('UTF-8 evidence tails retain only complete characters within the byte cap', () => {
  for (const value of ['a'.repeat(9000), 'λ'.repeat(9000), '学习'.repeat(9000), '🙂'.repeat(9000)]) {
    const tail = boundedUtf8Tail(value)
    assert.ok(Buffer.byteLength(tail) <= 8192)
    assert.ok(value.endsWith(tail))
    assert.ok(!tail.includes('\ufffd'))
  }
})

test('failed timings remain in all-sample statistics and are never replaced by a rerun', () => {
  const rows = plan.samples.map((_, index) => row(index))
  const failedIndex = plan.samples.findIndex(sample => sample.id === 'warm-1-A')
  rows[failedIndex] = row(failedIndex, { state: 'timeout', exitCode: null, elapsedMs: 15031 })
  const result = analyzeReceipts(plan, receipt(rows))
  assert.equal(result.complete, true)
  assert.equal(result.status, 'not-verified')
  assert.equal(result.failures.length, 1)
  assert.equal(result.groups['A/warm'].allMeasuredSamples.count, 30)
  assert.equal(result.groups['A/warm'].allMeasuredSamples.maxMs, 15031)
  assert.equal(result.groups['A/warm'].successfulSamplesOnly.count, 29)
  assert.throws(() => analyzeReceipts(plan, receipt([rows[0], rows[0]])), /duplicate/)
  assert.throws(() => analyzeReceipts(plan, receipt([rows[1], rows[0]])), /scheduled interleaved order/)
})

test('aborted or unavailable execution stays incomplete and reports missing samples without zero timings', () => {
  const result = analyzeReceipts(plan, receipt([row(0)]))
  assert.equal(result.complete, false)
  assert.equal(result.unexecuted, 92)
  assert.equal(result.groups['B/warm'].allMeasuredSamples.medianMs, null)
  const absent = analyzeReceipts(plan, receipt([row(0, { state: 'unavailable', elapsedMs: null,
    exitCode: null, cleanupVerified: false, outputComplete: false })]))
  assert.equal(absent.status, 'not-verified')
  assert.equal(absent.groups['A/first-compile-exposure'].allMeasuredSamples.count, 0)
})

test('unverified cleanup prevents launching later samples; raised deadlines invalidate the experiment', () => {
  assert.throws(() => analyzeReceipts(plan, receipt([row(0, { cleanupVerified: false }), row(1)])), /continued after unverified cleanup/)
  const stopped = analyzeReceipts(plan, receipt([row(0, { cleanupVerified: false })]))
  assert.match(stopped.failures[0].reasons.join(' '), /cleanup unverified/)
  assert.throws(() => analyzeReceipts(plan, receipt([row(0, { compileDeadlineMs: 30000 })])), /mismatched compiler deadlines/)
  const wrongBoundary = analyzeReceipts(plan, receipt([row(0, { ownershipMethod: 'assign-after-spawn' })]))
  assert.equal(wrongBoundary.status, 'not-verified')
  assert.match(wrongBoundary.failures[0].reasons.join(' '), /ownership boundary/)
})

test('native platform, actual workload identity and measurement boundaries remain explicit', () => {
  assert.throws(() => analyzeReceipts(plan, { ...receipt([]), platform: 'darwin' }), /native Windows/)
  assert.throws(() => analyzeReceipts(plan, { ...receipt([]), provenance: 'plan-only' }), /not a benchmark/)
  const changed = row(1)
  changed.identity.environmentSha256 = sha('different environment')
  const result = analyzeReceipts(plan, receipt([row(0), changed]))
  assert.equal(result.matchedIdentity, false)
  const differentClockBoundary = row(1)
  differentClockBoundary.identity.measurementBoundary = 'shell startup included only here'
  assert.equal(analyzeReceipts(plan, receipt([row(0), differentClockBoundary])).matchedIdentity, false)
  const fakeCompiler = row(0)
  fakeCompiler.identity.compilerPath = 'gcc.exe'
  assert.throws(() => analyzeReceipts(plan, receipt([fakeCompiler])), /canonical absolute/)
  const clipped = row(0, { stderrTail: 'λ'.repeat(4097) })
  assert.throws(() => analyzeReceipts(plan, receipt([clipped])))
})

test('durable journal retains failed and unfinished attempts even without a final report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ion-gcc-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'report.json'), evidence = await reserveNativeEvidence(output)
  try {
    await evidence.append('attempt-start', { id: 'warm-1-B' })
    await evidence.append('attempt-complete', compactJournalSample({ id: 'warm-1-B', state: 'timeout',
      elapsedMs: 15001, success: false, stdoutTail: '', stderrTail: 'actual timeout evidence' }))
    await evidence.append('attempt-start', { id: 'warm-2-B' })
  } finally { await evidence.close() }
  const records = (await readFile(output + '.samples.jsonl', 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map(record => record.sequence), [1, 2, 3])
  assert.equal(records[1].data.state, 'timeout')
  assert.equal(records[1].data.elapsedMs, 15001)
  assert.equal(Buffer.from(records[1].data.stderrTailBase64, 'base64').toString(), 'actual timeout evidence')
  assert.equal(records.at(-1).kind, 'attempt-start')
  assert.equal(records.at(-1).data.id, 'warm-2-B')
  assert.equal(JSON.parse(await readFile(output, 'utf8')).status, 'reserved-not-measured')
  await assert.rejects(evidence.append('attempt-complete', {}), /closed/)
})

test('exclusive reservation preserves existing files and failed preflight never starts a sample', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ion-gcc-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const existing = join(root, 'existing.json')
  await writeFile(existing, 'KEEP THIS EXACTLY')
  await assert.rejects(reserveNativeEvidence(existing), error => error.code === 'EEXIST')
  assert.equal(await readFile(existing, 'utf8'), 'KEEP THIS EXACTLY')
  await assert.rejects(stat(existing + '.samples.jsonl'), error => error.code === 'ENOENT')
  const output = join(root, 'journal-collision.json')
  await writeFile(output + '.samples.jsonl', 'KEEP EXISTING JOURNAL')
  await assert.rejects(reserveNativeEvidence(output), error => error.code === 'EEXIST')
  assert.equal(await readFile(output + '.samples.jsonl', 'utf8'), 'KEEP EXISTING JOURNAL')
  assert.equal(JSON.parse(await readFile(output, 'utf8')).status, 'preflight-failed-not-measured')
})

test('journal capacity failure preserves acknowledged rows; worst-case stream evidence stays bounded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ion-gcc-journal-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'report.json'), evidence = await reserveNativeEvidence(output, { maxBytes: 512 })
  try {
    await evidence.append('attempt-start', { id: 'first-B' })
    const acknowledged = await readFile(evidence.journalPath, 'utf8')
    await assert.rejects(evidence.append('attempt-complete', { detail: 'x'.repeat(600) }), /journal is full/)
    assert.equal(await readFile(evidence.journalPath, 'utf8'), acknowledged)
  } finally { await evidence.close() }
  const completion = compactJournalSample({ id: 'warm-100-B', state: 'error', detail: '\0'.repeat(1000),
    stdoutTail: '\0'.repeat(8192), stderrTail: '🙂'.repeat(2048), success: false })
  const lineBytes = Buffer.byteLength(JSON.stringify({ sequence: 204, kind: 'attempt-complete', data: completion }) + '\n')
  assert.ok(lineBytes < 16 * 1024)
  assert.equal(completion.stdoutTailOriginalBytes, 8192)
  assert.equal(completion.stdoutTailRetainedBytes, 4096)
  assert.ok(101 * lineBytes + 101 * 512 + 2 * 16 * 1024 < 2 * 1024 * 1024)
})

test('the CLI prepares without process creation and refuses unverified native execution', async () => {
  const execute = promisify(execFile)
  const path = fileURLToPath(new URL('./compare-gcc-latency.mjs', import.meta.url))
  const { stdout } = await execute(process.execPath, [path, '--plan', '--samples', '30'], { maxBuffer: 64 * 1024 })
  const prepared = JSON.parse(stdout)
  assert.equal(prepared.nativeMeasurements, 'not measured')
  assert.equal(prepared.execution, 'pending-native-ownership-verification')
  assert.equal(prepared.samples.length, 93)
  await assert.rejects(execute(process.execPath, [path, '--run']), error =>
    error.code === 1 && /No process or app was started/.test(error.stderr))
  await assert.rejects(execute(process.execPath, [path, '--run-ion-node', '--gcc', 'C:\\Tools\\gcc.exe']), error =>
    error.code === 1 && /require --out/.test(error.stderr))
  if (process.platform !== 'win32') {
    const root = await mkdtemp(join(tmpdir(), 'ion-gcc-cli-'))
    try {
      const existing = join(root, 'existing.json')
      await writeFile(existing, 'KEEP EXISTING REPORT')
      await assert.rejects(execute(process.execPath, [path, '--run-ion-node', '--gcc', 'C:\\Tools\\gcc.exe', '--out', existing]), error =>
        error.code === 1 && /EEXIST/.test(error.stderr))
      assert.equal(await readFile(existing, 'utf8'), 'KEEP EXISTING REPORT')
      await assert.rejects(stat(existing + '.samples.jsonl'), error => error.code === 'ENOENT')
      const fresh = join(root, 'fresh.json')
      await assert.rejects(execute(process.execPath, [path, '--run-ion-node', '--gcc', 'C:\\Tools\\gcc.exe', '--out', fresh]), error =>
        error.code === 1 && /Native execution is Windows-only/.test(error.stderr))
      assert.equal(JSON.parse(await readFile(fresh, 'utf8')).status, 'failed-not-measured')
      assert.equal(await readFile(fresh + '.samples.jsonl', 'utf8'), '')
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

// Scheduling tests are synthetic; they do not claim Windows measurements.
test('independent CI hosts can balance first exposure across lanes without duplicate or missing samples', () => {
  for (const [firstLane, expected] of [['A', ['A','B','C']], ['B', ['B','C','A']], ['C', ['C','A','B']]]) {
    const schedule = comparisonPlan({ sampleCount: 100, compileMs: 15000, firstLane })
    assert.equal(schedule.samples.length, 303)
    assert.deepEqual(schedule.samples.slice(0, 3).map(row => row.lane), expected)
    assert.equal(new Set(schedule.samples.map(row => row.id)).size, 303)
    for (const lane of ['A', 'B', 'C']) assert.equal(schedule.samples.filter(row => row.phase === 'warm' && row.lane === lane).length, 100)
  }
  assert.throws(() => comparisonPlan({ sampleCount: 30, compileMs: 15000, firstLane: 'D' }))
})
