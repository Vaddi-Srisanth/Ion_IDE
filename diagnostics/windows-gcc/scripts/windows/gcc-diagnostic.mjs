// Offline diagnostic handoff, never loaded by Ion. No execution on import.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { arch, platform, release, totalmem, cpus } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { StringDecoder } from 'node:string_decoder'
import { comparisonPlan, productionCompileLimit, sourceText, timingStatistics } from './compare-gcc-latency.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sha = data => createHash('sha256').update(data).digest('hex')
const maxSampleBytes = 256 * 1024
const validId = /^(?:first-[ABC]|warm-(?:[1-9][0-9]?|100)-[ABC])$/
const publicStages = new Set(['adapter', 'compiler-command', 'compiler-process', 'compiler-payload', 'compiler-job',
  'compiler-stdout', 'compiler-stderr', 'adapter-cleanup', 'job-membership', 'ownership', 'cleanup', 'streams',
  'diagnostic', 'engine', 'compile', 'source-check-before-compile', 'source-check-before-program', 'program', 'pty',
  'publish-run-console', 'output', 'resolve-program', 'result'])
const publicEvents = new Set(['request', 'construct-start', 'constructed', 'construct-error', 'spawn-request', 'spawned',
  'ready-observed', 'clean-observed', 'first-callback', 'last-callback', 'end', 'destroy-before-end', 'exit', 'exit-callback',
  'close', 'cleanup', 'result-finalized', 'result-delivered', 'requested', 'completed', 'start', 'stop', 'error-callback',
  'child-observed', 'child-absent-observed', 'controller-job-verified', 'terminate-owned-child', 'failed',
  'completion-unverified', 'stream-error', 'reader-cleanup-unverified', 'exact-payload-exit-unverified',
  'fail-closed-terminate-job', 'ready', 'success', 'compile-error', 'runtime-error', 'timeout', 'cancelled', 'output-limit',
  'rejected', 'flushed', 'dispatch-start', 'dispatch-end', 'launch-requested', 'line-launch-requested', 'spawn-error'])
export const unmeasured = Object.freeze(['Independent kernel GCC/cc1/linker create and exit times in lanes B/C',
  'Native Job/stdio-reader cleanup initiation in lanes B/C', 'Filesystem/antivirus attribution',
  'Full Ion workspace/UI load, renderer delivery and paint', 'Application RAM/CPU/startup regression'])

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export function inside(root, path, paths = { relative, isAbsolute, sep }) {
  const value = paths.relative(root, path)
  return value === '' || (value !== '..' && !value.startsWith('..' + paths.sep) && !paths.isAbsolute(value))
}
export function safeEnvironment(root, compiler, systemRoot, paths = win32) {
  assert.ok(paths.isAbsolute(root) && paths.isAbsolute(compiler) && paths.isAbsolute(systemRoot))
  return { PATH: [paths.dirname(compiler), paths.join(systemRoot, 'System32')].join(';'),
    SystemRoot: systemRoot, WINDIR: systemRoot, HOME: paths.join(root, 'home'), USERPROFILE: paths.join(root, 'home'),
    LOCALAPPDATA: paths.join(root, 'home', 'Local'), APPDATA: paths.join(root, 'home', 'Roaming'),
    TEMP: paths.join(root, 'temp'), TMP: paths.join(root, 'temp'), LANG: 'C' }
}
export function distribution(values) {
  const stats = timingStatistics(values)
  return { ...stats, p95Ms: values.length >= 20 ? stats.p95Ms : null, p99Ms: values.length >= 100 ? stats.p99Ms : null,
    percentileMethod: 'nearest rank; p95 withheld below 20, p99 withheld below 100; no outlier filtering' }
}
function eventAt(row, stage, event) { return row.events?.find(e => e.stage === stage && e.event === event)?.ms ?? null }
function interval(a, b) { return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null }
export function stageDurations(row) {
  const at = (stage, event) => eventAt(row, stage, event)
  const direct = row.lane === 'A'
  const spawn = at('compiler-process', 'spawn-request')
  const exit = at('compiler-process', 'exit-callback')
  const done = at('compiler-process', 'result-finalized')
  return {
    compilerRequestToFinalizedMs: interval(spawn, done),
    spawnRequestToObservedStartMs: interval(spawn, at('compiler-process', 'spawned')),
    startObservation: direct ? 'actual GCC Process.Start return' : 'Ion supervisor spawn callback; not actual GCC start',
    readyReceiptToCleanReceiptMs: direct ? null : interval(at('compiler-payload', 'ready-observed'), at('compiler-job', 'clean-observed')),
    exitCallbackToStdoutEndMs: interval(exit, at('compiler-stdout', 'end')),
    exitCallbackToStderrEndMs: interval(exit, at('compiler-stderr', 'end')),
    exitCallbackToFinalizedMs: interval(exit, done),
    adapterResultAfterFinalizedMs: interval(done, at('adapter', 'result-delivered')),
    cleanupInitiatedToCompletedMs: interval(at('adapter-cleanup', 'requested'), at('adapter-cleanup', 'completed')),
    kernelCompilerExitMs: null,
  }
}
export function validateSample(row, expected) {
  assert.equal(row.kind, 'result'); assert.equal(row.schemaVersion, 1)
  assert.equal(row.runId, expected.id); assert.equal(row.lane, expected.lane)
  assert.ok(validId.test(row.runId))
  assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)
  assert.ok(Array.isArray(row.events) && row.events.length <= 256)
  let last = -1
  for (const e of row.events) {
    assert.ok(Number.isFinite(e.ms) && e.ms >= last)
    assert.ok(typeof e.stage === 'string' && e.stage.length <= 80 && typeof e.event === 'string' && e.event.length <= 80)
    last = e.ms
  }
  assert.ok(Buffer.byteLength(JSON.stringify(row)) <= maxSampleBytes)
  assert.equal(typeof row.cleanupVerified, 'boolean')
  assert.equal(typeof row.outputComplete, 'boolean')
  // Success is derived, never accepted from an adapter's cosmetic label.
  return { ...row, success: row.state === 'exited' && row.exitCode === 0 && row.outputComplete && row.cleanupVerified && !row.overflow,
    metrics: stageDurations(row) }
}
export function summarize(samples, planned) {
  const groups = {}
  for (const lane of ['A', 'B', 'C']) for (const phase of ['first-compile-exposure', 'warm']) {
    const rows = samples.filter(row => row.lane === lane && row.phase === phase)
    const stages = {}
    for (const key of ['compilerRequestToFinalizedMs', 'spawnRequestToObservedStartMs', 'readyReceiptToCleanReceiptMs',
      'exitCallbackToFinalizedMs', 'adapterResultAfterFinalizedMs', 'cleanupInitiatedToCompletedMs']) {
      stages[key] = distribution(rows.flatMap(row => Number.isFinite(row.metrics?.[key]) ? [row.metrics[key]] : []))
    }
    groups[lane + '/' + phase] = { attempted: rows.length, unsuccessful: rows.filter(row => !row.success).length,
      timeoutCount: rows.filter(row => row.state === 'timeout').length,
      cleanupUnverified: rows.filter(row => !row.cleanupVerified).length,
      primaryCompilerInterval: distribution(rows.flatMap(row => Number.isFinite(row.metrics?.compilerRequestToFinalizedMs) ? [row.metrics.compilerRequestToFinalizedMs] : [])),
      compilerIntervalUnavailable: rows.filter(row => !Number.isFinite(row.metrics?.compilerRequestToFinalizedMs)).length,
      totalAdapterIntervalNotComparableAcrossLanes: distribution(rows.filter(row => !row.adapterResultUnavailable).map(row => row.elapsedMs)),
      adapterIntervalUnavailable: rows.filter(row => row.adapterResultUnavailable).length,
      outerObserverWholeAttemptMs: distribution(rows.flatMap(row => Number.isFinite(row.observerWallMs) ? [row.observerWallMs] : [])),
      stages }
  }
  return { attempted: samples.length, planned, unexecuted: planned - samples.length, groups,
    complete: samples.length === planned, allCleanupVerified: samples.every(row => row.cleanupVerified),
    issueFixed: false, releaseStatus: 'held' }
}

// Whitelist reconstruction. No raw output, errors, argv, paths, environment,
// process command lines or unconstrained strings enter a shareable result.
export function sanitizeReport(report) {
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const states = new Set(['exited', 'timeout', 'cancelled', 'error', 'compile-error', 'runtime-error', 'output-limit', 'unavailable'])
  const rows = (report.samples ?? []).slice(0, 303).map(row => {
    assert.ok(validId.test(row.runId) && ['A', 'B', 'C'].includes(row.lane))
    const phase = row.phase === 'warm' ? 'warm' : 'first-compile-exposure'
    const metrics = {}
    for (const key of Object.keys(stageDurations({ lane: row.lane }))) {
      if (key.endsWith('Ms')) metrics[key] = finite(row.metrics?.[key])
    }
    return { runId: row.runId, lane: row.lane, phase, elapsedMs: finite(row.elapsedMs),
      state: states.has(row.state) ? row.state : 'error', exitCode: Number.isInteger(row.exitCode) ? row.exitCode : null,
      cleanupVerified: row.cleanupVerified === true, outputComplete: row.outputComplete === true,
      adapterResultUnavailable: row.adapterResultUnavailable === true, observerWallMs: finite(row.observerWallMs),
      success: row.state === 'exited' && row.exitCode === 0 && row.cleanupVerified === true && row.outputComplete === true && row.overflow !== true,
      overflow: row.overflow === true, payloadPid: Number.isInteger(row.payloadPid) ? row.payloadPid : null,
      metrics }
  })
  const hashes = {}
  for (const key of ['compilerSha256', 'helperSha256', 'adapterSha256', 'sourceSha256', 'environmentSha256']) {
    if (/^[a-f0-9]{64}$/.test(report.identity?.[key] ?? '')) hashes[key] = report.identity[key]
  }
  return { schemaVersion: 1, provenance: report.provenance === 'native-windows-execution' ? 'native-windows-execution' : 'not-native-measured',
    platform: report.platform === 'win32' ? 'win32' : 'unverified', architecture: report.architecture === 'x64' ? 'x64' : 'unverified',
    identity: hashes, samples: rows, ...summarize(rows, Number.isInteger(report.planned) && report.planned <= 303 ? report.planned : 303),
    hostCleanupVerified: report.hostCleanupVerified === true, binariesUnchanged: report.binariesUnchanged === true,
    toolVersionRecorded: report.compilerVersionPostlude?.success === true,
    sourceUnchanged: report.sourceUnchanged === true, failurePresent: !!report.failure,
    diagnosticVerification: report.complete === true && report.hostCleanupVerified === true && report.binariesUnchanged === true
      && report.sourceUnchanged === true && !report.failure && rows.every(row => row.success) ? 'completed-review-required' : 'incomplete-or-failed',
    removed: ['Raw output and free-form messages', 'All paths/argv/environment/commands', 'Hardware identifiers and usernames'],
    limitations: unmeasured, releaseStatus: 'held', issueFixed: false }
}
export function sanitizeEvents(events = []) {
  return events.slice(0, 256).flatMap(event => {
    if (!publicStages.has(event.stage) || !publicEvents.has(event.event) || !Number.isFinite(event.ms) || event.ms < 0) return []
    const value = { ms: event.ms, stage: event.stage, event: event.event }
    for (const key of ['pid', 'value', 'callbackAtMs']) if (typeof event[key] === 'number' && Number.isFinite(event[key])) value[key] = event[key]
    return [value]
  })
}

async function readBoundedJson(path, limit = 4 * 1024 * 1024) {
  assert.ok((await stat(path)).size <= limit, 'Input exceeds diagnostic size limit.')
  return JSON.parse(await readFile(path, 'utf8'))
}
async function assertExecutable(file, root, { compiler = false } = {}) {
  assert.ok(win32.isAbsolute(file), 'Use an explicit absolute trusted executable path.')
  const canonical = await realpath(file)
  assert.ok(!inside(root, canonical), 'Executables must not be stored in the disposable workspace.')
  if (compiler) assert.match(basename(canonical), /^gcc\.exe$/i)
  const handle = await open(canonical, 'r')
  try {
    const dos = Buffer.alloc(64), pe = Buffer.alloc(6)
    assert.equal((await handle.read(dos, 0, 64, 0)).bytesRead, 64)
    assert.equal(dos.readUInt16LE(0), 0x5a4d)
    assert.equal((await handle.read(pe, 0, 6, dos.readUInt32LE(60))).bytesRead, 6)
    assert.equal(pe.readUInt32LE(0), 0x4550); assert.equal(pe.readUInt16LE(4), 0x8664, 'x64 executable required.')
  } finally { await handle.close() }
  return canonical
}
async function freshRoot(path) {
  assert.ok(isAbsolute(path), 'Use a new absolute disposable workspace path.')
  // Reject all existing destinations, including symlinks. Never recursively
  // delete a user-selected existing folder, even if it has an Ion-like name.
  await mkdir(path, { recursive: false })
  const root = await realpath(path)
  assert.equal(root.toLowerCase(), resolve(path).toLowerCase(), 'Workspace ancestors must not redirect through junctions.')
  for (const dir of ['work', 'manifests', 'raw', 'temp', 'home', 'home/Local', 'home/Roaming', 'profile', 'profile/session', 'profile/logs', 'sanitized-results']) {
    await mkdir(join(root, dir), { recursive: true })
  }
  return root
}

export class JsonHost {
  constructor(executable, args, options) {
    this.child = spawn(executable, args, { ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.queue = []; this.queueBytes = 0; this.buffer = ''; this.errorBytes = 0; this.errorTail = ''; this.bytes = 0
    this.decoder = new StringDecoder('utf8')
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => { this.exit = { code, signal }; this.fail(new Error('Diagnostic host closed.')); resolve(this.exit) }))
    this.child.on('error', error => this.fail(error))
    this.child.stdin.on('error', error => this.fail(error))
    this.child.stdout.on('data', chunk => {
      this.bytes += chunk.length
      if (this.bytes > 80 * 1024 * 1024) { this.fail(new Error('Host output budget exceeded.')); this.kill(); return }
      this.buffer += this.decoder.write(chunk)
      if (Buffer.byteLength(this.buffer) > 2 * maxSampleBytes) { this.fail(new Error('Protocol line limit exceeded.')); this.kill(); return }
      let end
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
        if (!line.trim()) continue
        try {
          assert.ok(Buffer.byteLength(line) <= maxSampleBytes, 'Protocol message exceeds per-message budget.')
          const item = JSON.parse(line)
          if (this.pending) { const resolve = this.pending.resolve; this.pending.clear(); resolve(item) }
          else {
            const bytes = Buffer.byteLength(JSON.stringify(item))
            if (this.queue.length >= 256 || this.queueBytes + bytes > 2 * maxSampleBytes) throw new Error('Host message queue exceeded.')
            this.queue.push(item); this.queueBytes += bytes
          }
        } catch (error) { this.fail(error); this.kill(); break }
      }
    })
    this.child.stderr.on('data', chunk => {
      this.errorBytes += chunk.length; this.errorTail = (this.errorTail + chunk.toString('utf8')).slice(-2048)
      if (this.errorBytes > 65536) { this.fail(new Error('Host stderr budget exceeded.')); this.kill() }
    })
  }
  fail(error) { this.error = error; if (this.pending) { const reject = this.pending.reject; this.pending.clear(); reject(error) } }
  next(ms, signal) {
    if (this.queue.length) {
      const item = this.queue.shift(); this.queueBytes -= Buffer.byteLength(JSON.stringify(item)); return Promise.resolve(item)
    }
    if (this.error) return Promise.reject(this.error)
    assert.ok(!this.pending, 'One outstanding host operation allowed.')
    return new Promise((resolve, reject) => {
      const abort = () => { this.pending?.clear(); reject(new Error('Diagnostic operation cancelled.')) }
      const timer = setTimeout(() => { this.pending?.clear(); reject(new Error('Diagnostic host observation guard expired; compiler deadline is unchanged.')) }, ms)
      const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending = undefined }
      this.pending = { resolve, reject, clear }
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    })
  }
  send(message) { if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n') }
  kill() { if (!this.exit) this.child.kill() }
  async close() {
    this.send({ kind: 'quit' }); this.child.stdin.end()
    let timer
    const normal = await Promise.race([this.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 6000) })])
    clearTimeout(timer)
    if (!normal) {
      this.kill()
      let guard
      await Promise.race([this.closed, new Promise(resolve => { guard = setTimeout(resolve, 3000) })]); clearTimeout(guard)
    }
    return { normal, exited: !!this.exit, ...this.exit, pid: this.child.pid }
  }
}

async function recordJson(path, value, limit = maxSampleBytes) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  assert.ok(bytes.length <= limit, 'Per-sample evidence limit exceeded; stop instead of dropping evidence.')
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
}
export function validateDiagnosticBudget(value = 600000) {
  assert.ok(Number.isInteger(value) && value >= 60000 && value <= 900000, 'Diagnostic budget must be 60000–900000 ms; compiler deadlines are unchanged.')
  return value
}
export async function nativeRun(options) {
  assert.equal(platform(), 'win32', 'Native measurements require genuine Windows; no macOS launch is allowed.')
  assert.equal(arch(), 'x64')
  assert.ok(options.allowElectron, 'All three lanes require explicit --allow-electron-test for a private windowless Electron test host.')
  assert.ok(options.workspace && options.gcc && options.pwsh && options.helper && options.electron)
  const settings = await readBoundedJson(join(here, 'gcc-package.json'))
  const compiler = await assertExecutable(options.gcc, options.workspace, { compiler: true })
  const pwsh = await assertExecutable(options.pwsh, options.workspace)
  const helper = await assertExecutable(options.helper, options.workspace)
  const electron = await assertExecutable(options.electron, options.workspace)
  assert.ok(!inside(resolve(here, '../..'), compiler), 'GCC must not be controlled by the diagnostic source checkout.')
  const plan = comparisonPlan({ sampleCount: options.samples, compileMs: settings.compileMs, firstLane: options.firstLane })
  const diagnosticBudgetMs = validateDiagnosticBudget(options.maxDurationMs)
  const root = await freshRoot(options.workspace)
  const source = join(root, 'work', 'latency-probe.c'), output = join(root, 'work', 'latency-probe.exe')
  await writeFile(source, sourceText, { flag: 'wx' })
  const environment = safeEnvironment(root, compiler, process.env.SystemRoot || 'C:\\Windows')
  const environmentSha256 = sha(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))))
  const args = ['-x', 'c', '-std=c17', '-Wall', '-Wextra', '-fdiagnostics-color=never', source, '-o', output]
  const report = { schemaVersion: 1, provenance: 'native-windows-execution', platform: platform(), architecture: arch(),
    diagnosticBudgetMs, firstLane: plan.firstLane,
    startedAt: new Date().toISOString(), planned: plan.samples.length, samples: [], issueFixed: false, releaseStatus: 'held',
    environment, argv: args, workspace: root, limitations: unmeasured,
    hardware: { os: release(), memoryBytes: totalmem(), cpu: cpus()[0]?.model, logicalCpuCount: cpus().length },
    identity: { compilerPath: compiler, compilerSha256: await hashFile(compiler), helperSha256: await hashFile(helper),
      adapterSha256: await hashFile(join(here, 'gcc-production-adapter.cjs')), sourceSha256: sha(sourceText), environmentSha256,
      pwshSha256: await hashFile(pwsh), electronSha256: await hashFile(electron), node: process.versions.node },
    exposure: 'Executable hashes and runtime initialization precede the first compile. No cache purge; first exposures are not OS-cold. PowerShell host starts per attempt, B/C hosts persist.',
    ownership: 'A pre-owned PowerShell self-Job; B/C existing production atomic Job helper. Native behavior unverified until these scripts run.' }
  assert.equal(report.identity.adapterSha256, settings.adapterSha256, 'Prepared adapter differs from manifest.')
  const journal = await open(join(root, 'attempts.jsonl'), 'wx', 0o600)
  let journalBytes = 0
  const append = async value => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    assert.ok(bytes.length <= 16384 && journalBytes + bytes.length <= 3 * 1024 * 1024)
    await journal.writeFile(bytes); await journal.sync(); journalBytes += bytes.length
  }
  const controller = new AbortController(), abort = () => controller.abort()
  process.on('SIGINT', abort); process.on('SIGTERM', abort)
  // This bounds the whole diagnostic session, never increases a compiler deadline.
  // Abort flows through existing owned cancellation; incomplete samples stay evidence.
  const budgetTimer = setTimeout(() => { report.diagnosticBudgetExpired = true; controller.abort() }, diagnosticBudgetMs)
  const hosts = new Map()
  let direct, allClosed = true
  try {
    for (const lane of ['B', 'C']) {
      const hostEnvironment = { ...environment }
      const host = new JsonHost(lane === 'B' ? process.execPath : electron,
        [...(lane === 'C' ? ['--user-data-dir=' + join(root, 'profile')] : []), join(here, 'gcc-diagnostic-host.cjs'),
          '--ion-gcc-root=' + root, '--ion-gcc-helper=' + helper, '--ion-gcc-lane=' + lane],
        { cwd: root, env: hostEnvironment })
      hosts.set(lane, host)
      const ready = await host.next(20000, controller.signal)
      assert.equal(ready.kind, 'host-ready'); assert.equal(ready.lane, lane)
      await append({ kind: 'host-ready', lane, ...ready })
    }
    for (const sample of plan.samples) {
      if (controller.signal.aborted) break
      assert.equal(sha(await readFile(source)), report.identity.sourceSha256, 'Fixture source changed.')
      // Reset the same approved output path outside the timed interval. Never
      // overwrite or remove unrelated workspace files.
      await rm(output, { force: true })
      const manifest = { schemaVersion: 1, runId: sample.id, lane: sample.lane, workspace: root,
        compiler, source, output, cwd: dirname(source), args, environment, sourceSha256: sha(sourceText),
        timeoutMs: settings.compileMs, outputBytes: 65536 }
      const manifestPath = join(root, 'manifests', sample.id + '.json')
      await writeFile(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
      await append({ kind: 'attempt-start', ...sample })
      let row
      const began = performance.now()
      const partialEvents = []
      let invalidResult
      const liveTrace = await open(join(root, 'raw', sample.id + '.events.jsonl'), 'wx', 0o600)
      const receive = async host => {
        for (let count = 0; count < 258; count++) {
          const item = await host.next(Math.max(1, 25000 - (performance.now() - began)), controller.signal)
          assert.ok(Buffer.byteLength(JSON.stringify(item)) <= maxSampleBytes)
          await liveTrace.writeFile(JSON.stringify(item) + '\n')
          if (item.kind === 'result') return item
          assert.equal(item.kind, 'event')
          assert.equal(item.runId, sample.id); assert.equal(item.lane, sample.lane)
          assert.ok(partialEvents.length < 256 && Buffer.byteLength(JSON.stringify(item)) <= 2048)
          partialEvents.push(item)
          // Diagnostic observer I/O is explicit, common to all lanes, and can
          // perturb dispatch. This is not an uninstrumented performance run.
        }
        throw new Error('Event budget exhausted without a result.')
      }
      try {
        if (sample.lane === 'A') {
          direct = new JsonHost(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(here, 'gcc-direct-powershell.ps1'), '-ManifestPath', manifestPath],
            { cwd: root, env: { ...environment } })
          row = await receive(direct)
          assert.ok(row, 'No final direct-shell result.')
          const closed = await direct.close(); direct = undefined
          invalidResult = row
          assert.ok(closed.normal && closed.exited && closed.code === (row.state === 'exited' && row.exitCode === 0 && row.outputComplete && row.cleanupVerified ? 0 : 1),
            'Direct-shell host exit is unverified.')
        } else {
          hosts.get(sample.lane).send({ kind: 'run', manifest: manifestPath })
          row = await receive(hosts.get(sample.lane))
        }
        invalidResult = row
        row = validateSample(row, sample)
        if (row.state === 'exited' && row.exitCode === 0) {
          const built = await stat(output)
          assert.ok(built.isFile() && built.size > 0, 'GCC exited zero without a generated fixture executable.')
          row.fixtureOutputBytes = built.size
        }
        invalidResult = undefined
      } catch (error) {
        row = { kind: 'result', schemaVersion: 1, runId: sample.id, lane: sample.lane,
          elapsedMs: performance.now() - began, state: controller.signal.aborted ? 'cancelled' : 'error', exitCode: null,
          success: false, cleanupVerified: false, outputComplete: false, events: partialEvents, metrics: {},
          detail: String(error.message).slice(0, 1000), adapterResultUnavailable: true,
          hostDiagnostics: { pid: direct?.child.pid ?? hosts.get(sample.lane)?.child.pid ?? null,
            stderrTail: direct?.errorTail ?? hosts.get(sample.lane)?.errorTail ?? '',
            exit: direct?.exit ?? hosts.get(sample.lane)?.exit ?? null } }
        row.metrics = stageDurations(row)
        if (partialEvents.some(event => event.stage === 'compiler-process' && event.event === 'timeout')) row.state = 'timeout'
        if (invalidResult) await recordJson(join(root, 'raw', sample.id + '.invalid-result.json'), invalidResult)
      } finally {
        await liveTrace.sync(); await liveTrace.close()
      }
      row = { ...row, phase: sample.phase, round: sample.round, observerWallMs: performance.now() - began }
      await recordJson(join(root, 'raw', sample.id + '.json'), row)
      await recordJson(join(root, 'sanitized-results', sample.id + '.json'), {
        schemaVersion: 1, provenance: 'native-windows-execution', clock: 'per-attempt local monotonic; never subtract clocks across processes',
        ...sanitizeReport({ samples: [row] }).samples[0], events: sanitizeEvents(row.events) })
      const { events, stdoutTail, stderrTail, ...summaryRow } = row
      report.samples.push({ ...summaryRow, trace: 'raw/' + sample.id + '.json' })
      await append({ kind: 'attempt-complete', runId: row.runId, lane: row.lane, phase: row.phase, state: row.state,
        elapsedMs: row.elapsedMs, success: row.success, cleanupVerified: row.cleanupVerified, metrics: row.metrics })
      if (!row.cleanupVerified || row.overflow) break
    }
    // Record tool identity after the measured schedule, without warming its
    // first compile by executing --version first. Never mix into sample stats.
    if (!controller.signal.aborted && report.samples.length === plan.samples.length && report.samples.every(row => row.cleanupVerified)) {
      await append({ kind: 'version-postlude-start' })
      const host = hosts.get('B'), began = performance.now()
      host.send({ kind: 'version', manifest: join(root, 'manifests', 'first-B.json') })
      let version
      for (let count = 0; count < 258; count++) {
        const item = await host.next(Math.max(1, 25000 - (performance.now() - began)), controller.signal)
        if (item.kind === 'result') { version = validateSample(item, { id: 'first-B', lane: 'B' }); break }
        assert.equal(item.kind, 'event')
        await append({ kind: 'version-event', event: item })
      }
      assert.ok(version, 'Compiler version postlude did not return a result.')
      await recordJson(join(root, 'raw', 'version-postlude.json'), version)
      report.compilerVersionPostlude = { state: version.state, exitCode: version.exitCode, cleanupVerified: version.cleanupVerified,
        stdoutTail: version.stdoutTail, success: version.success }
      assert.ok(version.success, 'Compiler version/cleanup postlude failed; preserve diagnostic evidence.')
    }
    report.binariesUnchanged = await hashFile(compiler) === report.identity.compilerSha256
      && await hashFile(helper) === report.identity.helperSha256
    report.sourceUnchanged = sha(await readFile(source)) === report.identity.sourceSha256
  } catch (error) { report.failure = String(error.message).slice(0, 1000) }
  finally {
    controller.abort()
    for (const host of hosts.values()) host.send({ kind: 'cancel' })
    if (direct) {
      direct.kill(); report.directShellForced = true; allClosed = false
      try { await direct.close() } catch (error) { report.directShellCloseError = String(error.message).slice(0, 512) }
    }
    report.hostShutdown = []
    const lateEvidence = []
    for (const [lane, host] of hosts) {
      let result
      try { result = await host.close() }
      catch (error) { result = { normal: false, exited: !!host.exit, pid: host.child.pid, failure: String(error.message).slice(0, 512) }; host.kill() }
      report.hostShutdown.push({ lane, ...result, stderrTail: host.errorTail,
        stderrBytes: host.errorBytes, protocolError: host.error?.message?.slice(0, 512) })
      if (host.queue.length) lateEvidence.push({ lane, ...result, lateMessages: host.queue })
      if (!result.normal || !result.exited || result.code !== 0) allClosed = false
    }
    clearTimeout(budgetTimer)
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
    await journal.close()
    // Persistence failure must never skip cleanup of a different host.
    for (const evidence of lateEvidence) await recordJson(join(root, 'raw', 'host-shutdown-' + evidence.lane + '.json'), evidence, maxSampleBytes * 3)
    report.controllerAborted = report.samples.length < plan.samples.length
    Object.assign(report, summarize(report.samples, plan.samples.length))
    report.hostCleanupVerified = allClosed
    // Per-sample files keep full bounded traces. Summary references them so a
    // long run cannot accumulate all traces in the final in-memory report.
    const summaryRows = report.samples.map(({ events, stdoutTail, stderrTail, ...row }) => ({ ...row, trace: 'raw/' + row.runId + '.json' }))
    report.samples = summaryRows
    const serialized = Buffer.from(JSON.stringify(report, null, 2) + '\n')
    assert.ok(serialized.length <= 4 * 1024 * 1024)
    await writeFile(join(root, 'report-private.json'), serialized, { flag: 'wx', mode: 0o600 })
    await writeFile(join(root, 'sanitized-results', 'results.json'), JSON.stringify(sanitizeReport(report), null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    process.stdout.write('Diagnostic evidence retained at ' + root + '\n')
  }
  return report
}

export async function preparePackage(destination) {
  const repository = resolve(here, '../..')
  const root = resolve(destination)
  await mkdir(root) // exclusive new directory, never merge into an existing package
  const runtime = join(root, 'scripts', 'windows')
  await mkdir(runtime, { recursive: true })
  const runnerText = await readFile(join(repository, 'src/main/runner.ts'), 'utf8')
  const { build, stop } = await import('esbuild')
  try {
    await build({ stdin: { contents: `export {execute,defaultRunLimits} from './src/main/runner.ts';
      export {InteractiveRunner} from './src/main/run-console/engine.ts';
      export {configureWindowsProcessHelper} from './src/main/windows-process.ts';`, resolveDir: repository },
      outfile: join(runtime, 'gcc-production-adapter.cjs'), platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' })
  } finally { stop() }
  const sources = ['src/main/runner.ts', 'src/main/windows-process.ts', 'src/main/run-console/engine.ts',
    'src/main/run-console/trace.ts', 'src/main/run-console/pty.ts', 'src/main/run-console/line-console.ts',
    'src/main/run-console/pty-windows.cpp']
  const manifest = { schemaVersion: 1, nativeStatus: 'UNVERIFIED — prepared on macOS, not executed on Windows',
    releaseStatus: 'held', compileMs: productionCompileLimit(runnerText), sourceSha256: sha(sourceText),
    adapterSha256: await hashFile(join(runtime, 'gcc-production-adapter.cjs')), sourceFiles: [] }
  for (const name of sources) {
    const from = join(repository, name), to = join(root, name)
    await mkdir(dirname(to), { recursive: true }); await cp(from, to, { errorOnExist: true, force: false })
    manifest.sourceFiles.push({ path: name, sha256: await hashFile(from) })
  }
  for (const name of ['gcc-diagnostic.mjs', 'gcc-diagnostic-host.cjs', 'gcc-direct-powershell.ps1', 'compare-gcc-latency.mjs', 'build-pty.mjs']) {
    await cp(join(here, name), join(runtime, name), { errorOnExist: true, force: false })
  }
  await writeFile(join(runtime, 'gcc-package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  await cp(join(repository, 'WINDOWS_DIAGNOSTIC_GUIDE.md'), join(root, 'WINDOWS_DIAGNOSTIC_GUIDE.md'))
  await mkdir(join(root, 'evidence'), { recursive: true })
  for (const name of ['EVIDENCE_SUMMARY.md', 'REMAINING_WINDOWS_TASKS.md']) {
    await cp(join(repository, 'release-blockers/gcc-handoff', name), join(root, name))
  }
  await cp(join(repository, 'release-blockers/gcc-latency/source-review.diff'), join(root, 'evidence/optional-production-tracing.patch'))
  await cp(join(repository, 'release-blockers/gcc-handoff/sanitized-results'), join(root, 'sanitized-results'), { recursive: true })
  await writeFile(join(root, 'build-helper.mjs'), `import {buildWindowsPty} from './scripts/windows/build-pty.mjs';\nimport {mkdir} from 'node:fs/promises';\nimport {resolve} from 'node:path';\nif(process.platform!=='win32'||process.arch!=='x64')throw new Error('Native Windows x64 required.');\nconst scratch=resolve('build-temp');await mkdir(scratch,{recursive:true});process.env.TEMP=scratch;process.env.TMP=scratch;\nawait buildWindowsPty(resolve('native/ion-pty.exe'),'x64',resolve('src/main/run-console/pty-windows.cpp'));\n`, { flag: 'wx' })
  return { directory: root, manifest }
}

async function main() {
  const { values } = parseArgs({ options: { prepare: { type: 'string' }, run: { type: 'boolean' },
    workspace: { type: 'string' }, gcc: { type: 'string' }, pwsh: { type: 'string' }, helper: { type: 'string' },
    electron: { type: 'string' }, 'first-lane': { type: 'string', default: 'A' }, 'max-duration-ms': { type: 'string', default: '600000' }, 'allow-electron-test': { type: 'boolean' }, samples: { type: 'string', default: '100' },
    sanitize: { type: 'string' }, out: { type: 'string' }, plan: { type: 'boolean' } } })
  assert.ok([values.prepare, values.run, values.sanitize, values.plan].filter(Boolean).length === 1, 'Choose exactly one: --prepare DIR, --run, --sanitize FILE --out FILE, --plan.')
  if (values.prepare) { const result = await preparePackage(values.prepare); console.log(JSON.stringify(result, null, 2)); return }
  if (values.sanitize) {
    assert.ok(values.out); const report = sanitizeReport(await readBoundedJson(values.sanitize))
    await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); return
  }
  if (values.plan) {
    let compileMs
    try { compileMs = (await readBoundedJson(join(here, 'gcc-package.json'))).compileMs }
    catch { compileMs = productionCompileLimit(await readFile(join(here, '../../src/main/runner.ts'), 'utf8')) }
    const plan = comparisonPlan({ sampleCount: Number(values.samples), compileMs, firstLane: values['first-lane'] })
    plan.diagnosticBudgetMs = validateDiagnosticBudget(Number(values['max-duration-ms']))
    plan.laneDefinitions.A.pending = 'Implemented self-Job adapter and deadline watchdog require native Windows verification.'
    plan.laneDefinitions.C.pending = 'Implemented private windowless Electron engine host requires native Windows verification; original full UI workload is separate.'
    console.log(JSON.stringify({ ...plan,
      execution: 'handoff-implemented-native-unverified', nativeMeasurements: 'not measured', limitations: unmeasured }, null, 2)); return
  }
  const report = await nativeRun({ ...values, samples: Number(values.samples), allowElectron: values['allow-electron-test'], firstLane: values['first-lane'], maxDurationMs: Number(values['max-duration-ms']) })
  if (!report.complete || !report.allCleanupVerified || !report.hostCleanupVerified || !report.binariesUnchanged
    || !report.sourceUnchanged || report.samples.some(row => !row.success)) process.exitCode = 1
}
// Node canonicalizes module URLs, but argv can retain a junction/symlink or
// macOS /var alias. Compare actual files so a copied CLI cannot silently no-op.
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  await main().catch(error => { process.stderr.write(String(error.message).slice(0, 2048) + '\n'); process.exitCode = 1 })
}
