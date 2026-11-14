import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Complete A/B/C execution is deliberately unavailable until direct-shell Job
// ownership has been verified on Windows. B-only has an explicit native opt-in.
// No import, default CLI invocation or --plan starts a process or Electron.
export const lanes = Object.freeze(['A', 'B', 'C'])
export const sourceText = '#include <stdio.h>\nint main(void) { puts("ION-GCC-LATENCY"); return 0; }\n'
const digest = text => createHash('sha256').update(text).digest('hex')
const states = new Set(['exited', 'timeout', 'cancelled', 'error', 'output-limit', 'unavailable'])
const maxEvidenceBytes = 8 * 1024 * 1024
const evidenceOwners = new WeakSet()

// Reserve both names before execution. Acknowledged records have completed a
// FileHandle.sync; the journal also survives an incomplete final JSON report.
// This is process-crash durability, not a hardware/power-loss guarantee.
export async function reserveNativeEvidence(path, { maxBytes = 2 * 1024 * 1024 } = {}) {
  assert.ok(Number.isInteger(maxBytes) && maxBytes >= 512 && maxBytes <= 2 * 1024 * 1024)
  const reportPath = resolve(path), journalPath = reportPath + '.samples.jsonl'
  const output = await open(reportPath, 'wx', 0o600)
  let journal, closed = false, broken = false, bytes = 0, sequence = 0, journalMs = 0
  async function writeFinal(value) {
    assert.ok(!closed, 'Evidence is closed.')
    const data = Buffer.from(JSON.stringify(value, null, 2) + '\n')
    let offset = 0
    while (offset < data.length) {
      const written = await output.write(data, offset, data.length - offset, offset)
      assert.ok(written.bytesWritten > 0, 'Evidence report write made no progress.')
      offset += written.bytesWritten
    }
    await output.truncate(data.length)
    await output.sync()
  }
  try {
    await writeFinal({ schemaVersion: 1, status: 'reserved-not-measured', journalPath })
    journal = await open(journalPath, 'wx', 0o600)
  } catch (error) {
    await writeFinal({ schemaVersion: 1, status: 'preflight-failed-not-measured', journalPath,
      failure: String(error).slice(0, 1000) }).catch(() => {})
    await journal?.close().catch(() => {})
    await output.close()
    throw error
  }
  const owner = { reportPath, journalPath,
    get journalBytes() { return bytes }, get journalMs() { return journalMs },
    async append(kind, data) {
      assert.ok(!closed && !broken, 'Evidence journal is closed or failed; execution must stop.')
      const line = Buffer.from(JSON.stringify({ schemaVersion: 1, sequence: sequence + 1, kind, data }) + '\n')
      if (line.length > 16 * 1024 || bytes + line.length > maxBytes) {
        broken = true
        throw new Error('Bounded evidence journal is full; execution must stop.')
      }
      const began = performance.now()
      try {
        await journal.writeFile(line)
        await journal.sync()
        bytes += line.length
        sequence++
      } catch (error) { broken = true; throw error }
      finally { journalMs += performance.now() - began }
    },
    writeFinal,
    async close() {
      if (closed) return
      closed = true
      evidenceOwners.delete(owner)
      const results = await Promise.allSettled([journal.close(), output.close()])
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Evidence files did not close cleanly.')
    },
  }
  evidenceOwners.add(owner)
  return owner
}

export function compactJournalSample(row) {
  const compact = { ...row, detail: String(row.detail ?? '').slice(0, 512) }
  for (const key of ['stdoutTail', 'stderrTail']) {
    const text = boundedUtf8Tail(row[key], 4096)
    compact[key + 'Base64'] = Buffer.from(text).toString('base64')
    compact[key + 'OriginalBytes'] = Buffer.byteLength(row[key] ?? '')
    compact[key + 'RetainedBytes'] = Buffer.byteLength(text)
    delete compact[key]
  }
  return compact
}
async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export function boundedUtf8Tail(text, limit = 8192) {
  const bytes = Buffer.from(text ?? '', 'utf8')
  let start = Math.max(0, bytes.length - limit)
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

export function productionCompileLimit(source) {
  const literal = /export\s+const\s+defaultRunLimits\s*=\s*\{\s*compileMs:\s*([\d_]+)\s*[,}]/.exec(source)?.[1]
  assert.ok(literal && /^\d+(?:_\d+)*$/.test(literal), 'Cannot derive a literal compile limit from the current production runner; no fallback timeout is allowed.')
  const value = Number(literal.replaceAll('_', ''))
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 120000)
  return value
}

export function comparisonPlan({ sampleCount = 100, compileMs, firstLane = 'A' } = {}) {
  assert.ok(Number.isInteger(sampleCount) && sampleCount >= 30 && sampleCount <= 100, 'Choose 30–100 warm samples per lane.')
  assert.ok(Number.isInteger(compileMs) && compileMs > 0 && compileMs <= 120000, 'Supply the production-derived compile deadline.')
  assert.ok(lanes.includes(firstLane), 'First lane must be A, B or C.')
  const order = [...lanes.slice(lanes.indexOf(firstLane)), ...lanes.slice(0, lanes.indexOf(firstLane))]
  const samples = order.map(lane => ({ id: `first-${lane}`, phase: 'first-compile-exposure', lane, round: 0 }))
  for (let round = 0; round < sampleCount; round++) {
    for (let index = 0; index < lanes.length; index++) {
      const lane = order[(round + index) % order.length]
      samples.push({ id: `warm-${round + 1}-${lane}`, phase: 'warm', lane, round: round + 1 })
    }
  }
  return {
    schemaVersion: 1, execution: 'pending-native-ownership-verification', nativePlatform: 'win32', nativeArchitecture: 'x64',
    warmSamplesPerLane: sampleCount, firstLane, compileMs, outputLimitBytes: 64 * 1024, retainedOutputBytesPerStream: 8192,
    retries: 0, firstExposurePolicy: 'One first compile exposure per lane, separately reported. Not independent OS-cold samples; no cache purge.',
    abortPolicy: 'Stop scheduling immediately. Cancel the current owned operation and verify cleanup; never retry or replace unsuccessful samples.',
    workload: { sourceName: 'latency-probe.c', sourceText, sourceSha256: digest(sourceText), outputName: 'latency-probe.exe',
      args: ['-x', 'c', '-std=c17', '-Wall', '-Wextra', '-fdiagnostics-color=never', '<same private source>', '-o', '<same private output>'],
      identityRequirement: 'Identical canonical GCC path, compiler hash/version, argv, cwd, source hash and environment hash for all three lanes. Record every difference.' },
    laneDefinitions: {
      A: { scope: 'Direct PowerShell ProcessStartInfo with structured ArgumentList',
        pending: 'Verify a noninheritable kill-on-close self-Job and exact membership BEFORE GCC starts. Post-spawn assignment is forbidden.',
        ownership: 'powershell-self-job-before-start' },
      B: { scope: 'Production execute adapter under standalone Node with the installation-owned Ion helper', ownership: 'atomic-job-list' },
      C: { scope: 'Production InteractiveRunner in a real disposable Electron main process; engine-only, not a UI paint test',
        pending: 'Use the existing desktop harness only on an explicitly approved native Windows GUI session; never launch on macOS.', ownership: 'atomic-job-list' },
    },
    constraints: ['No compiler download, PATH mutation, workspace executable, shell command string, retry, timeout increase, push, release or installed-app modification.',
      'GCC version execution before the first sample changes exposure conditions; record it, or collect --version after all samples.',
      'Measure each lane with monotonic timestamps and record its precise measurement boundary; unequal boundaries are not matched timings.',
      'A self-owned PowerShell Job may survive controller loss until its bounded compiler deadline; verify and report that distinct lifecycle.'],
    samples,
  }
}

function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null
}

export function timingStatistics(values) {
  assert.ok(Array.isArray(values) && values.every(value => Number.isFinite(value) && value >= 0), 'Latencies must be actual finite nonnegative milliseconds.')
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length
  return { count: n, medianMs: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    p95Ms: percentile(sorted, 0.95), p99Ms: percentile(sorted, 0.99), maxMs: n ? sorted[n - 1] : null }
}
export const summarizeLatencies = timingStatistics

/** A useful partial measurement, explicitly not an A/B/C comparison. */
export async function runIonNodeLane({ compilerPath, target = 'dist', sampleCount = 100, compileMs, sourceCommit = null, signal, evidence }) {
  assert.ok(evidenceOwners.has(evidence), 'Native measurements require exclusively reserved --out evidence before execution.')
  assert.equal(process.platform, 'win32', 'Native execution is Windows-only; no macOS app or process will be launched.')
  assert.equal(process.arch, 'x64', 'This diagnostic targets native Windows x64.')
  assert.equal(compileMs, productionCompileLimit(await readFile(new URL('../../src/main/runner.ts', import.meta.url), 'utf8')),
    'The native adapter cannot raise the current production compiler deadline.')
  const plan = comparisonPlan({ sampleCount, compileMs })
  assert.ok(compilerPath && win32.isAbsolute(compilerPath), 'Explicitly select an installed GCC with --gcc and its absolute path.')
  const compiler = await realpath(compilerPath)
  assert.match(win32.basename(compiler), /^gcc\.exe$/i)
  const repository = fileURLToPath(new URL('../../', import.meta.url))
  const fromRepository = relative(repository, compiler)
  assert.ok(fromRepository === '..' || fromRepository.startsWith('..' + sep) || win32.isAbsolute(fromRepository), 'Never execute a workspace-controlled compiler.')
  if (sourceCommit !== null) assert.match(sourceCommit, /^[a-f0-9]{40}$/i)
  const helper = await realpath(resolve(target, 'native/ion-pty.exe'))
  const root = await mkdtemp(join(tmpdir(), 'ion-gcc-latency-'))
  const source = join(root, plan.workload.sourceName), output = join(root, plan.workload.outputName)
  const report = { schemaVersion: 1, platform: process.platform, architecture: process.arch, provenance: 'native-execution',
    sourceCommit, scope: 'B-only: production execute under standalone Node; no Electron, editor UI, direct-shell A or engine C measured.',
    status: 'not-verified', nativePending: ['A: verified direct-shell pre-execution Job ownership', 'C: explicitly approved native Electron session'],
    schedule: 'B-only, not interleaved A/B/C; first compile exposure is separate and is not a cache-purged cold sample.',
    firstExposureConditions: 'Compiler/helper metadata hashing precedes the first compile; no OS cache purge or independent cold-cache claim.',
    node: process.versions.node, compileMs, outputLimitBytes: plan.outputLimitBytes, samples: [], cleanupVerified: true }
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let tools
  try {
    await writeFile(source, sourceText, { flag: 'wx' })
    report.identity = { compilerPath: compiler, compilerSha256: await fileDigest(compiler),
      helperPath: helper, helperSha256: await fileDigest(helper), sourceSha256: plan.workload.sourceSha256,
      runnerSha256: digest(await readFile(new URL('../../src/main/runner.ts', import.meta.url))), cwd: root,
      argv: ['-x', 'c', '-std=c17', '-Wall', '-Wextra', '-fdiagnostics-color=never', source, '-o', output],
      measurementBoundary: 'performance.now immediately before execute through its verified process/output cleanup; includes Ion helper startup.' }
    const { build, stop } = await import('esbuild')
    const bundle = join(root, 'ion-execute.cjs')
    try {
      await build({ stdin: { contents: `export {execute} from './src/main/runner.ts';
        export {configureWindowsProcessHelper,windowsEnvironment,workspaceSafeWindowsToolPaths} from './src/main/windows-process.ts';`, resolveDir: repository },
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    } finally { stop() }
    tools = createRequire(import.meta.url)(bundle)
    tools.configureWindowsProcessHelper(helper)
    const environment = tools.windowsEnvironment(await tools.workspaceSafeWindowsToolPaths(root), root)
    report.identity.environmentSha256 = digest(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))))
    await evidence.append('identity', { identity: report.identity, sourceCommit, node: process.versions.node, compileMs,
      schedule: report.schedule, durability: 'FileHandle.sync acknowledged outside the compiler latency interval.' })
    for (const sample of plan.samples.filter(sample => sample.lane === 'B')) {
      if (controller.signal.aborted) { report.aborted = true; break }
      // If the controller crashes after this acknowledged record, the attempt
      // stays explicitly unfinished rather than disappearing from the report.
      await evidence.append('attempt-start', sample)
      const began = performance.now()
      let result
      try {
        result = await tools.execute(compiler, report.identity.argv, { cwd: root, input: '', signal: controller.signal,
          timeoutMs: compileMs, budget: { remaining: plan.outputLimitBytes }, environment, splitOutput: true })
      } catch (error) {
        result = { state: 'error', exitCode: null, outputComplete: false,
          detail: 'Adapter threw: ' + String(error?.message ?? error), stdout: '', stderr: '' }
      }
      const elapsedMs = performance.now() - began
      const row = { ...sample, elapsedMs, state: result.state, exitCode: result.exitCode,
        outputComplete: result.outputComplete, cleanupVerified: result.outputComplete === true,
        stdoutTail: boundedUtf8Tail(result.stdout), stderrTail: boundedUtf8Tail(result.stderr), detail: String(result.detail ?? '').slice(0, 1000),
        success: result.state === 'exited' && result.exitCode === 0 && result.outputComplete === true }
      report.samples.push(row)
      await evidence.append('attempt-complete', compactJournalSample(row))
      if (result.outputComplete !== true) { report.cleanupVerified = false; break }
    }
    report.sourceUnchanged = digest(await readFile(source)) === plan.workload.sourceSha256
    report.binariesUnchanged = await fileDigest(compiler) === report.identity.compilerSha256
      && await fileDigest(helper) === report.identity.helperSha256
    // Version execution is a recorded postlude, so it cannot warm the first
    // compile exposure. It is never substituted for a workload sample.
    if (!controller.signal.aborted && report.cleanupVerified) {
      await evidence.append('version-postlude-start', { argv: ['--version'] })
      const version = await tools.execute(compiler, ['--version'], { cwd: root, input: '', signal: controller.signal,
        timeoutMs: compileMs, budget: { remaining: plan.outputLimitBytes }, environment, splitOutput: true })
      report.versionPostlude = { state: version.state, exitCode: version.exitCode, outputComplete: version.outputComplete,
        stdout: Buffer.from(version.stdout ?? '', 'utf8').subarray(0, 4096).toString('utf8') }
      await evidence.append('version-postlude-complete', { ...report.versionPostlude,
        stdout: undefined, stdoutBase64: Buffer.from(report.versionPostlude.stdout).toString('base64') })
      if (version.outputComplete !== true) report.cleanupVerified = false
    }
    report.complete = report.samples.length === sampleCount + 1
    report.failures = report.samples.filter(sample => !sample.success)
    const warm = report.samples.filter(sample => sample.phase === 'warm')
    report.warm = { allMeasuredSamples: timingStatistics(warm.map(sample => sample.elapsedMs)),
      successfulSamplesOnly: timingStatistics(warm.filter(sample => sample.success).map(sample => sample.elapsedMs)) }
    if (report.complete && report.failures.length === 0 && report.sourceUnchanged && report.binariesUnchanged && report.cleanupVerified
      && report.versionPostlude?.state === 'exited' && report.versionPostlude.exitCode === 0) report.status = 'B-only-measured'
  } catch (error) {
    report.failure = String(error?.stack ?? error).slice(0, 4000)
    // Preserve the scratch data on an unexpected execution failure. Do not
    // delete resources under a potentially still-running unverified command.
    report.cleanupVerified = false
  } finally {
    controller.abort()
    signal?.removeEventListener('abort', abort)
    if (report.cleanupVerified) {
      try { await rm(root, { recursive: true, force: true }) }
      catch (error) { report.cleanupVerified = false; report.cleanupFailure = String(error).slice(0, 1000) }
    }
    if (!report.cleanupVerified) report.retainedScratch = root
  }
  report.evidence = { journalPath: evidence.journalPath, journalBytes: evidence.journalBytes,
    journalSyncMs: evidence.journalMs, syncExcludedFromCompilerTiming: true }
  if (!report.cleanupVerified) report.status = 'not-verified'
  return report
}

function identityFingerprint(value) {
  assert.ok(value && typeof value === 'object', 'Every attempted native sample needs its actual workload identity.')
  assert.ok(win32.isAbsolute(value.compilerPath) && /^gcc\.exe$/i.test(win32.basename(value.compilerPath)), 'The actual GCC must be a canonical absolute Windows executable.')
  for (const key of ['compilerSha256', 'sourceSha256', 'environmentSha256']) assert.match(value[key] ?? '', /^[a-f0-9]{64}$/)
  assert.ok(typeof value.compilerVersion === 'string' && value.compilerVersion.length > 0 && value.compilerVersion.length <= 4096)
  assert.ok(win32.isAbsolute(value.cwd) && Array.isArray(value.argv) && value.argv.length <= 32)
  assert.ok(value.argv.every(arg => typeof arg === 'string' && arg.length <= 32768 && !arg.includes('\0')))
  assert.ok(typeof value.measurementBoundary === 'string' && value.measurementBoundary.length > 0 && value.measurementBoundary.length <= 512)
  return digest(JSON.stringify([value.compilerPath.toLowerCase(), value.compilerSha256, value.compilerVersion,
    value.sourceSha256, value.environmentSha256, value.cwd.toLowerCase(), value.argv, value.measurementBoundary]))
}

export function analyzeReceipts(plan, receipt) {
  assert.equal(plan.schemaVersion, 1)
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.platform, 'win32', 'macOS or simulated samples cannot stand in for native Windows.')
  assert.equal(receipt.architecture, 'x64')
  assert.equal(receipt.provenance, 'native-execution', 'Plan-only evidence is not a benchmark.')
  assert.ok(Array.isArray(receipt.samples) && receipt.samples.length <= plan.samples.length)
  const expected = new Map(plan.samples.map(sample => [sample.id, sample])), seen = new Set(), identities = new Set()
  const all = [], failures = []
  for (let index = 0; index < receipt.samples.length; index++) {
    const row = receipt.samples[index], scheduled = expected.get(row.id)
    assert.ok(scheduled && !seen.has(row.id), 'Unknown or duplicate sample; retries and replacements are forbidden.')
    assert.equal(row.id, plan.samples[index].id, 'Samples must retain the scheduled interleaved order, including failures.')
    assert.equal(row.lane, scheduled.lane)
    assert.equal(row.phase, scheduled.phase)
    assert.ok(states.has(row.state))
    assert.ok(row.elapsedMs === null || Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)
    assert.ok(row.elapsedMs !== null || row.state === 'unavailable', 'An attempted operation needs its measured elapsed time, even when it fails.')
    for (const key of ['stdoutTail', 'stderrTail']) assert.ok(typeof row[key] === 'string' && Buffer.byteLength(row[key]) <= plan.retainedOutputBytesPerStream)
    seen.add(row.id)
    const unavailable = row.state === 'unavailable'
    if (!unavailable) {
      identities.add(identityFingerprint(row.identity))
      assert.equal(row.identity.sourceSha256, plan.workload.sourceSha256)
      assert.equal(row.compileDeadlineMs, plan.compileMs, 'Raised or mismatched compiler deadlines invalidate the comparison.')
    }
    const reasons = []
    if (row.state !== 'exited' || row.exitCode !== 0) reasons.push(`${row.state}; exit ${row.exitCode}`)
    if (row.outputComplete !== true) reasons.push('output incomplete or unverified')
    if (row.cleanupVerified !== true) reasons.push('process cleanup unverified')
    if (row.sourceUnchanged !== true) reasons.push('source integrity unverified')
    if (row.ownershipMethod !== plan.laneDefinitions[row.lane].ownership) reasons.push('required ownership boundary unverified')
    const checked = { ...row, success: reasons.length === 0 }
    all.push(checked)
    if (reasons.length) failures.push({ id: row.id, lane: row.lane, phase: row.phase, reasons, elapsedMs: row.elapsedMs })
    if (row.cleanupVerified !== true && index + 1 < receipt.samples.length) {
      assert.fail('Execution continued after unverified cleanup; remaining samples must not be launched.')
    }
  }
  const matchedIdentity = identities.size === 1 && all.some(row => row.state !== 'unavailable')
  const groups = {}
  for (const lane of lanes) for (const phase of ['first-compile-exposure', 'warm']) {
    const group = all.filter(row => row.lane === lane && row.phase === phase)
    groups[`${lane}/${phase}`] = { planned: plan.samples.filter(row => row.lane === lane && row.phase === phase).length,
      attempted: group.length, failed: group.filter(row => !row.success).length,
      allMeasuredSamples: timingStatistics(group.flatMap(row => row.elapsedMs === null ? [] : [row.elapsedMs])),
      successfulSamplesOnly: timingStatistics(group.filter(row => row.success).map(row => row.elapsedMs)) }
  }
  return { schemaVersion: 1, complete: seen.size === plan.samples.length,
    status: seen.size === plan.samples.length && failures.length === 0 && matchedIdentity ? 'measured-pass' : 'not-verified',
    matchedIdentity, attempted: all.length, unexecuted: plan.samples.length - all.length, groups, failures,
    samples: all, note: 'All measured samples include failed timings. Successful-only statistics are separate, never replacements. Native receipt provenance requires independent review.' }
}

async function main() {
  const { values } = parseArgs({ options: { plan: { type: 'boolean' }, analyze: { type: 'string' },
    samples: { type: 'string', default: '100' }, out: { type: 'string' }, run: { type: 'boolean' },
    'run-ion-node': { type: 'boolean' }, gcc: { type: 'string' }, target: { type: 'string', default: 'dist' },
    'source-commit': { type: 'string' } } })
  if (values.run) throw new Error('Native execution is unavailable: direct-shell pre-execution Job ownership and the native Electron lane require Windows verification. No process or app was started.')
  const runnerSource = await readFile(new URL('../../src/main/runner.ts', import.meta.url), 'utf8')
  const plan = comparisonPlan({ sampleCount: Number(values.samples), compileMs: productionCompileLimit(runnerSource) })
  let result = { ...plan, currentHost: { platform: process.platform, architecture: process.arch }, nativeMeasurements: 'not measured' }
  if (values['run-ion-node']) {
    assert.ok(!values.analyze && !values.plan, 'Native execution cannot be combined with plan or receipt analysis.')
    assert.ok(values.out, 'Native B measurements require --out for exclusive reservation and durable per-attempt evidence.')
    const evidence = await reserveNativeEvidence(values.out)
    const controller = new AbortController(), abort = () => controller.abort()
    let primaryError
    process.on('SIGINT', abort); process.on('SIGTERM', abort)
    try { result = await runIonNodeLane({ compilerPath: values.gcc, target: values.target,
      sampleCount: Number(values.samples), compileMs: plan.compileMs, sourceCommit: values['source-commit'] ?? null, signal: controller.signal, evidence }) }
    catch (error) {
      primaryError = error
      result = { schemaVersion: 1, status: 'failed-not-measured', failure: String(error).slice(0, 2000), journalPath: evidence.journalPath }
    } finally {
      process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
      try { await evidence.writeFinal(result) }
      catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], 'Measurement and report persistence failed.') : error }
      try { await evidence.close() }
      catch (error) { primaryError ??= error }
    }
    if (primaryError) throw primaryError
    if (result.status !== 'B-only-measured') process.exitCode = 1
    return
  }
  if (values.analyze) {
    const input = resolve(values.analyze)
    assert.ok((await stat(input)).size <= maxEvidenceBytes, 'Receipt exceeds the bounded evidence limit.')
    result = analyzeReceipts(plan, JSON.parse(await readFile(input, 'utf8')))
  }
  const text = JSON.stringify(result, null, 2) + '\n'
  if (values.out) await writeFile(resolve(values.out), text, { flag: 'wx' })
  else process.stdout.write(text)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
