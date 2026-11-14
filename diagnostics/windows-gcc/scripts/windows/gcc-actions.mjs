// CI-only adapter. No imports from this file are used by the application.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, platform, release, tmpdir, totalmem, cpus } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const idPattern = /^(?:first-[ABC]|warm-(?:[1-9][0-9]?|100)-[ABC])$/
const hash = data => createHash('sha256').update(data).digest('hex')
const positive = value => Number.isInteger(value) && value > 0 ? value : null
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value) ? value : null
const marker = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value) ? value : null
const provenance = () => ({ commit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null,
  runId: /^\d{1,20}$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : null,
  runAttempt: /^\d{1,5}$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') ? process.env.GITHUB_RUN_ATTEMPT : null,
  repository: process.env.GITHUB_REPOSITORY === 'Vaddi-Srisanth/Ion_IDE' ? 'Vaddi-Srisanth/Ion_IDE' : null })
const inside = (root, file) => { const rel = relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) }

async function digestFile(file) {
  const result = createHash('sha256')
  for await (const chunk of createReadStream(file)) result.update(chunk)
  return result.digest('hex')
}
async function loadCore(packageDirectory) {
  const root = await realpath(packageDirectory)
  return { root, core: await import(pathToFileURL(join(root, 'scripts/windows/gcc-diagnostic.mjs')).href) }
}
async function safeRead(root, file, limit, budget) {
  assert.ok(inside(root, file), 'Evidence path escaped workspace.')
  const relativeName = relative(root, file)
  let cursor = root
  for (const part of relativeName.split(sep)) {
    if (!part) continue
    cursor = join(cursor, part)
    assert.ok(!(await lstat(cursor)).isSymbolicLink(), 'Evidence symlink is forbidden.')
  }
  assert.ok((await lstat(file)).isFile(), 'Evidence must be an ordinary file.')
  assert.equal(await realpath(file), file, 'Evidence path redirects outside its declared location.')
  const info = await stat(file)
  assert.ok(info.size <= limit, 'Evidence size limit exceeded.')
  budget.read += info.size
  assert.ok(budget.read <= 96 * 1024 * 1024, 'Total evidence read budget exceeded.')
  return readFile(file)
}
function phaseOf(id) { return id.startsWith('first-') ? 'first-compile-exposure' : 'warm' }
function laneOf(id) { return id.at(-1) }

/** Only installation/OS-derived metadata is published. Compiler text stays private. */
export async function metadata(options) {
  assert.equal(platform(), 'win32', 'Metadata execution requires genuine Windows x64.')
  assert.equal(arch(), 'x64')
  assert.ok(win32.isAbsolute(options.gcc) && win32.isAbsolute(options.helper))
  const { root, core } = await loadCore(options.package)
  const output = resolve(options.out)
  await mkdir(dirname(output), { recursive: true })
  const receipt = { schemaVersion: 1, github: provenance(), runner: 'windows-2022', architecture: arch(), osBuild: release(), nodeVersion: process.versions.node,
    imageOS: marker(process.env.ImageOS), imageVersion: marker(process.env.ImageVersion),
    runnerArchitecture: marker(process.env.RUNNER_ARCH), powershellVersion: version(options.pwshVersion ?? process.env.ION_GCC_PWSH_VERSION),
    electronVersion: null, expectedGccVersion: options.expectedGcc ?? '14.2.0', gccVersion: null, compilerTarget: null,
    compilerPath: null, compilerSha256: null, helperSha256: null, adapterSha256: null,
    memoryBytes: totalmem(), logicalCpuCount: cpus().length,
    compilerPrimedBeforeSchedule: true, firstExposureIsOsCold: false,
    compilerDeadlineMs: 15000, probes: [], cleanupVerified: false, metadataVerified: false, failureClass: null, issueFixed: false, releaseStatus: 'held' }
  let privateRoot
  try {
    assert.match(receipt.expectedGccVersion, /^\d+\.\d+\.\d+$/)
    const compiler = await realpath(options.gcc), helper = await realpath(options.helper)
    assert.ok(/^C:\\mingw64\\bin\\gcc\.exe$/i.test(compiler)
      || /^C:\\ProgramData\\chocolatey\\lib\\mingw\\tools\\install\\mingw64\\bin\\gcc\.exe$/i.test(compiler),
    'Only the documented installed runner GCC path is accepted.')
    assert.ok(!inside(root, compiler), 'Compiler cannot come from diagnostic source files.')
    assert.ok((await stat(compiler)).size <= 256 * 1024 * 1024)
    const manifest = JSON.parse(await readFile(join(root, 'scripts/windows/gcc-package.json'), 'utf8'))
    receipt.compilerPath = compiler; receipt.compilerSha256 = await digestFile(compiler)
    receipt.helperSha256 = await digestFile(helper)
    const adapter = join(root, 'scripts/windows/gcc-production-adapter.cjs')
    receipt.adapterSha256 = await digestFile(adapter)
    assert.equal(receipt.adapterSha256, manifest.adapterSha256)
    const electronPackage = JSON.parse(await readFile(options.electronPackage, 'utf8'))
    receipt.electronVersion = version(electronPackage.version)
    assert.equal(receipt.electronVersion, '45.2.3')
    privateRoot = await mkdtemp(join(tmpdir(), 'ion-gcc-metadata-'))
    for (const directory of ['home', 'home/Local', 'home/Roaming', 'temp']) await mkdir(join(privateRoot, directory), { recursive: true })
    const environment = core.safeEnvironment(privateRoot, compiler, process.env.SystemRoot || 'C:\\Windows')
    receipt.requestedCompilerEnvironment = { ...core.safeEnvironment('C:\\ION_WORKSPACE', compiler, environment.SystemRoot) }
    for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) {
      receipt.requestedCompilerEnvironment[key] = receipt.requestedCompilerEnvironment[key].replace('C:\\ION_WORKSPACE', '$WORKSPACE')
    }
    const tools = createRequire(import.meta.url)(adapter)
    tools.configureWindowsProcessHelper(helper)
    const controller = new AbortController(), cancel = () => controller.abort()
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
    try {
      const probe = async args => {
        const began = performance.now(), events = []
        let result, traceOverflow = false
        try {
          result = await tools.execute(compiler, args, { cwd: privateRoot, input: '', signal: controller.signal,
            timeoutMs: 15000, budget: { remaining: 65536 }, environment, splitOutput: true,
            trace: (stage, event, value) => {
              if (events.length >= 256) { traceOverflow = true; return }
              const entry = { ms: performance.now() - began, stage, event }
              if (typeof value === 'number' && Number.isFinite(value)) entry.value = value
              if (typeof value === 'number' && ['first-callback', 'last-callback'].includes(event)) entry.callbackAtMs = value - began
              events.push(entry)
            } })
          return result
        } finally {
          const states = new Set(['exited', 'timeout', 'cancelled', 'error', 'output-limit'])
          receipt.probes.push({ operation: args[0] === '--version' ? 'version' : 'target', elapsedMs: performance.now() - began,
            state: states.has(result?.state) ? result.state : 'adapter-error', exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
            outputComplete: result?.outputComplete === true, cleanupVerified: result?.outputComplete === true
              && events.some(e => e.stage === 'compiler-job' && e.event === 'clean-observed')
              && events.some(e => e.stage === 'compiler-process' && e.event === 'close'),
            traceOverflow, metrics: core.stageDurations({ lane: 'B', events }), events: core.sanitizeEvents(events),
            stdoutBytes: Buffer.byteLength(result?.stdout ?? ''), stderrBytes: Buffer.byteLength(result?.stderr ?? ''),
            clock: 'per-probe monotonic clock; Node callback observations, not kernel exit time' })
        }
      }
      const result = await probe(['--version'])
      await writeFile(join(privateRoot, 'version-private.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 })
      assert.equal(result.state, 'exited'); assert.equal(result.exitCode, 0)
      assert.equal(result.outputComplete, true)
      receipt.cleanupVerified = result.outputComplete === true
      receipt.gccVersion = version(String(result.stdout ?? '').split(/\r?\n/, 1)[0].match(/\b(\d+\.\d+\.\d+)\b/)?.[1])
      assert.equal(receipt.gccVersion, receipt.expectedGccVersion, 'Hosted image GCC changed; record it rather than silently changing the experiment.')
      const target = await probe(['-dumpmachine'])
      receipt.cleanupVerified = receipt.cleanupVerified && target.outputComplete === true
      await writeFile(join(privateRoot, 'target-private.json'), JSON.stringify(target), { flag: 'wx', mode: 0o600 })
      assert.equal(target.state, 'exited'); assert.equal(target.exitCode, 0)
      assert.equal(target.outputComplete, true)
      const targetName = String(target.stdout ?? '').trim()
      assert.match(targetName, /^x86_64-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+){0,4}$/)
      receipt.compilerTarget = targetName
      assert.ok(receipt.probes.every(row => row.cleanupVerified && !row.traceOverflow), 'Metadata probe evidence is incomplete.')
      receipt.metadataVerified = true
    } finally { controller.abort(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
  } catch (error) {
    receipt.failureClass = error?.code === 'ENOENT' ? 'required-tool-or-file-missing' : 'native-metadata-check-failed'
    // Never publish exception messages, paths or raw tool output.
  }
  receipt.cleanupVerified = receipt.probes.length > 0 && receipt.probes.every(probe => probe.cleanupVerified)
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return receipt
}

/** Recover safe evidence even if the main process never wrote its final report. */
export async function collect(options) {
  const sampleCount = Number(options.samples)
  assert.ok([30, 100].includes(sampleCount)); assert.ok(['A', 'B', 'C'].includes(options.firstLane))
  const { core } = await loadCore(options.package)
  const output = resolve(options.out)
  // Entire directory is exclusively collector-owned. Never merge with a folder
  // that could contain arbitrary files later matched by upload-artifact.
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output)
  await mkdir(join(output, 'samples'))
  const budget = { read: 0, written: 0 }, gaps = [], starts = new Set(), completed = new Set(), rows = new Map(), partial = new Map(), recovered = new Map()
  const allowedIds = new Set(['A', 'B', 'C'].flatMap(lane => ['first-' + lane,
    ...Array.from({ length: sampleCount }, (_, i) => 'warm-' + (i + 1) + '-' + lane)]))
  const gap = code => { if (gaps.length < 1024) gaps.push(code) }
  const write = async (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
    assert.ok(bytes.length <= 4 * 1024 * 1024 && budget.written + bytes.length <= 16 * 1024 * 1024, 'Sanitized artifact budget exceeded.')
    budget.written += bytes.length
    await writeFile(join(output, name), bytes, { flag: 'wx', mode: 0o600 })
  }
  let workspace, finalReport, reportSanitized, hostVersions = {}, rawEntries = 0
  const cleanRow = (raw, expectedId) => {
    assert.ok(allowedIds.has(expectedId) && raw.runId === expectedId && raw.lane === laneOf(expectedId))
    assert.ok(finite(raw.elapsedMs) !== null, 'Missing time is not a measured zero.')
    const validated = core.validateSample(raw, { id: expectedId, lane: laneOf(expectedId) })
    const sanitized = core.sanitizeReport({ samples: [{ ...validated, phase: phaseOf(expectedId) }], planned: 3 * (sampleCount + 1) }).samples[0]
    assert.ok(sanitized)
    return sanitized
  }
  try {
    workspace = await realpath(options.workspace)
    assert.ok(!(await lstat(options.workspace)).isSymbolicLink())
  } catch { gap('workspace-missing-or-redirected') }
  if (workspace) {
    try {
      const bytes = await safeRead(workspace, join(workspace, 'report-private.json'), 4 * 1024 * 1024, budget)
      finalReport = JSON.parse(bytes)
      assert.ok(Array.isArray(finalReport.samples) && finalReport.samples.length <= 303)
      reportSanitized = core.sanitizeReport(finalReport)
    } catch { gap('final-report-missing-or-invalid') }
    try {
      const bytes = await safeRead(workspace, join(workspace, 'attempts.jsonl'), 3 * 1024 * 1024, budget)
      const ledger = [], postludeEvents = []
      for (const line of bytes.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const item = JSON.parse(line)
          if (item.kind === 'host-ready' && ['B', 'C'].includes(item.lane)) {
            hostVersions[item.lane] = { node: version(item.node), electron: version(item.electron), pid: positive(item.pid) }
          }
          if (item.kind === 'version-event' && postludeEvents.length < 256) postludeEvents.push(...core.sanitizeEvents([item.event]))
          if (!['attempt-start', 'attempt-complete'].includes(item.kind)) continue
          const id = item.runId ?? item.id
          assert.ok(allowedIds.has(id) && item.lane === laneOf(id))
          const row = { kind: item.kind, runId: id, lane: laneOf(id), phase: phaseOf(id) }
          if (item.kind === 'attempt-start') starts.add(id)
          else { completed.add(id); row.cleanupVerified = item.cleanupVerified === true; row.success = item.success === true; row.elapsedMs = finite(item.elapsedMs) }
          ledger.push(row)
          assert.ok(ledger.length <= 606)
        } catch { gap('ledger-record-invalid-or-truncated') }
      }
      await write('attempt-ledger.json', { records: ledger, postludeEvents, originalSha256: hash(bytes) })
    } catch { gap('attempt-ledger-missing-or-invalid') }
    try {
      const raw = join(workspace, 'raw')
      assert.ok(!(await lstat(raw)).isSymbolicLink())
      for (const entry of (await readdir(raw, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++rawEntries > 915) { gap('raw-entry-count-exceeded'); break }
        const match = /^(first-[ABC]|warm-(?:[1-9][0-9]?|100)-[ABC])\.(json|events\.jsonl|invalid-result\.json)$/.exec(entry.name)
        if (!match) {
          if (!/^(version-postlude|host-shutdown-[BC])\.json$/.test(entry.name)) { gap('unknown-raw-entry-not-published'); continue }
          try {
            const bytes = await safeRead(workspace, join(raw, entry.name), 768 * 1024, budget), value = JSON.parse(bytes)
            const messages = Array.isArray(value.lateMessages) ? value.lateMessages.slice(0, 256) : [value]
            const events = [], results = []
            for (const message of messages) {
              if (message.kind === 'event') events.push(...core.sanitizeEvents([message]))
              else if (message.kind === 'result' && allowedIds.has(message.runId)) {
                results.push(cleanRow(message, message.runId))
                events.push(...core.sanitizeEvents(message.events))
              }
            }
            await write(entry.name, { postludeOrShutdown: true, originalSha256: hash(bytes),
              normal: value.normal === true, exited: value.exited === true, code: Number.isInteger(value.code) ? value.code : null,
              pid: positive(value.pid), events: events.slice(0, 256), results })
          } catch { gap('postlude-or-shutdown-evidence-invalid') }
          continue
        }
        const [id, kind] = match.slice(1)
        if (!allowedIds.has(id)) { gap('raw-attempt-outside-schedule'); continue }
        try {
          const bytes = await safeRead(workspace, join(raw, entry.name), kind === 'events.jsonl' ? 1024 * 1024 : 256 * 1024, budget)
          if (kind === 'json') {
            const value = JSON.parse(bytes)
            const safe = cleanRow(value, id), events = core.sanitizeEvents(value.events)
            rows.set(id, safe)
            await write('samples/' + id + '.result.json', { ...safe, events, originalSha256: hash(bytes), clock: 'per-attempt local monotonic; no cross-process subtraction' })
          } else if (kind === 'invalid-result.json') {
            const value = JSON.parse(bytes)
            await write('samples/' + id + '.invalid-result.json', { runId: id, invalidResultRetained: true,
              events: core.sanitizeEvents(Array.isArray(value.events) ? value.events : []), originalSha256: hash(bytes) })
            gap('invalid-result-retained')
          } else {
            let malformedLines = 0, resultSeen = false, records = 0
            const events = [], liveResults = [], hostErrors = []
            for (const line of bytes.toString('utf8').split('\n')) {
              if (!line.trim()) continue
              if (++records > 258) { malformedLines++; break }
              try {
                const item = JSON.parse(line)
                if (item.kind === 'host-error') {
                  assert.equal(item.lane, laneOf(id))
                  const e = item.error ?? {}, allowed = ['ERR_ASSERTION', 'ENOENT', 'EACCES', 'EPERM', 'MODULE_NOT_FOUND', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'HOST_ERROR']
                  assert.ok(hostErrors.length < 2)
                  hostErrors.push({ code: allowed.includes(e.code) ? e.code : 'HOST_ERROR', line: positive(e.line), column: positive(e.column),
                    messageSha256: /^[a-f0-9]{64}$/.test(e.messageSha256 ?? '') ? e.messageSha256 : null })
                  gap('diagnostic-host-error-retained'); continue
                }
                assert.equal(item.runId, id); assert.equal(item.lane, laneOf(id))
                if (item.kind === 'event') events.push(...core.sanitizeEvents([item]))
                else if (item.kind === 'result') {
                  resultSeen = true
                  const result = cleanRow(item, id)
                  if (liveResults.length >= 2) throw new Error('Duplicate result messages exceeded budget.')
                  liveResults.push(result)
                  if (recovered.has(id)) gap('duplicate-live-result-message')
                  else recovered.set(id, result)
                }
                else if (item.kind !== 'preflight-error') malformedLines++
              } catch { malformedLines++ }
            }
            assert.ok(events.length <= 256)
            partial.set(id, events)
            await write('samples/' + id + '.timeline.json', { runId: id, events, resultSeen, liveResults, hostErrors, malformedLines,
              originalSha256: hash(bytes), clock: 'per-attempt local monotonic; no cross-process subtraction' })
            if (malformedLines) gap('partial-trace-malformed-or-truncated')
          }
        } catch { gap('raw-evidence-invalid-or-oversized'); await write('samples/' + id + '.' + kind.replaceAll('.', '-') + '.unavailable.json', { runId: id, evidenceUnavailable: true }) }
      }
    } catch { gap('raw-directory-missing-or-invalid') }
  }
  // A final summary cannot erase a missing raw trace or an unfinished ledger
  // entry. Preserve these separately; never invent a zero duration.
  for (const [id, result] of recovered) if (!rows.has(id)) {
    rows.set(id, { ...result, recoveredFromLiveMessage: true })
    gap('result-recovered-from-live-trace-without-final-row')
  }
  for (const [id, row] of rows) {
    if (!partial.has(id)) gap('live-trace-missing')
    const live = recovered.get(id)
    if (live && ['elapsedMs', 'state', 'exitCode', 'cleanupVerified', 'outputComplete'].some(key => live[key] !== row[key])) gap('live-and-final-result-disagree')
  }
  const observedIds = new Set([...starts, ...completed, ...rows.keys(), ...partial.keys()])
  const unfinished = [...observedIds].filter(id => !rows.has(id)).sort().map(id => ({ runId: id, lane: laneOf(id), phase: phaseOf(id),
    elapsedMs: null, cleanupVerified: false, state: partial.get(id)?.some(e => e.stage === 'compiler-process' && e.event === 'timeout') ? 'timeout-observed-without-result' : 'unfinished',
    events: partial.get(id) ?? [] }))
  for (const id of starts) if (!completed.has(id)) gap('attempt-start-without-completion')
  for (const id of completed) if (!starts.has(id)) gap('completion-without-start')
  for (const id of rows.keys()) if (!starts.has(id)) gap('raw-result-without-start')
  for (const id of rows.keys()) if (!partial.has(id)) gap('live-trace-missing-for-result')
  if (unfinished.length) gap('unfinished-attempts-retained')
  const measured = [...rows.values()]
  const summary = core.summarize(measured, 3 * (sampleCount + 1))
  const results = { schemaVersion: 1, github: provenance(), source: 'GitHub-hosted Windows diagnostic artifacts; not proof of native execution without run context',
    declaredFirstLane: options.firstLane, expectedWarmPerLane: sampleCount,
    ...summary, observedAttemptCount: observedIds.size, measuredResultCount: rows.size, unfinishedAttempts: unfinished,
    samples: measured, hostVersions, hostCleanupVerified: reportSanitized?.hostCleanupVerified === true,
    binariesUnchanged: reportSanitized?.binariesUnchanged === true, sourceUnchanged: reportSanitized?.sourceUnchanged === true,
    finalReportFailurePresent: reportSanitized?.failurePresent === true,
    diagnosticBudgetExpired: finalReport?.diagnosticBudgetExpired === true,
    hostShutdown: (Array.isArray(finalReport?.hostShutdown) ? finalReport.hostShutdown : []).slice(0, 2).flatMap(host => ['B', 'C'].includes(host.lane) ? [{
      lane: host.lane, pid: positive(host.pid), normal: host.normal === true, exited: host.exited === true,
      closedBeforeQuit: host.closedBeforeQuit === true,
      code: Number.isInteger(host.code) ? host.code : null,
      signal: ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGBREAK', 'SIGHUP'].includes(host.signal) ? host.signal : null,
    }] : []),
    finalReportPresentAndValid: !!reportSanitized, diagnosticVerification: 'incomplete-or-failed',
    failuresPresent: measured.some(row => !row.success) || unfinished.length > 0,
    evidenceGaps: gaps, issueFixed: false, releaseStatus: 'held' }
  if (summary.complete && summary.allCleanupVerified && results.hostCleanupVerified && results.binariesUnchanged && results.sourceUnchanged
    && !results.failuresPresent && gaps.length === 0 && !reportSanitized?.failurePresent) results.diagnosticVerification = 'completed-review-required'
  await write('results.json', results)
  await write('collection.json', { schemaVersion: 1, status: results.diagnosticVerification, originalReadBytes: budget.read,
    sanitizedWrittenBytes: budget.written, observedAttemptCount: observedIds.size, plannedAttemptCount: summary.planned,
    evidenceGapCount: gaps.length, rawTextPublished: false, automaticIssueResolution: false, releaseStatus: 'held' })
  return results
}

async function main() {
  const operation = process.argv[2]
  const { values } = parseArgs({ args: process.argv.slice(3), options: { package: { type: 'string' }, helper: { type: 'string' },
    gcc: { type: 'string' }, out: { type: 'string' }, workspace: { type: 'string' }, samples: { type: 'string', default: '100' },
    'first-lane': { type: 'string', default: 'A' }, 'expected-gcc': { type: 'string', default: '14.2.0' },
    'electron-package': { type: 'string' }, 'pwsh-version': { type: 'string' } } })
  assert.ok(values.package && values.out)
  if (operation === 'metadata') {
    const result = await metadata({ ...values, electronPackage: values['electron-package'], pwshVersion: values['pwsh-version'], expectedGcc: values['expected-gcc'] })
    if (!result.metadataVerified) process.exitCode = 1
  } else if (operation === 'collect') {
    assert.ok(values.workspace)
    const result = await collect({ ...values, firstLane: values['first-lane'] })
    if (result.diagnosticVerification !== 'completed-review-required') process.exitCode = 1
  } else throw new Error('Choose metadata or collect.')
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  await main().catch(() => { process.stderr.write('GCC diagnostic CI adapter failed; preserve existing sanitized files and inspect workflow step status.\n'); process.exitCode = 1 })
}
