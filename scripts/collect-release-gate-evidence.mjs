// Test infrastructure only. Never loaded by Ion; no processes or network access.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const limits = Object.freeze({ files: 128, entries: 512, fileBytes: 8 * 1024 ** 2, readBytes: 64 * 1024 ** 2,
  writeBytes: 16 * 1024 ** 2, depth: 24, array: 4096, nodes: 200000 })
const digest = value => createHash('sha256').update(value).digest('hex')
const filename = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/
const knownKeys = new Set(('schemaVersion version complete completed verified success passed failed failure failures errors errorCount failureCount skipped skippedCount unsuccessful timeoutCount status state phase kind language platform arch architecture mode label scope name test tests result results samples members summary protocol builds candidate baseline comparison production source commit sha sha256 sourceSha256 compilerSha256 helperSha256 adapterSha256 mainSha256 mainHash candidateHash baselineHash artifactSha256 sourceCommit runId runAttempt generatedAt time host cpu ramBytes memoryBytes release node compiler value count index trial trials attempted planned unexecuted allCleanupVerified hostCleanupVerified cleanupVerified outputComplete startupMs freshMs warmMs freshStartupMs warmStartupMs oneFile tenTabs welcome terminal closed afterClose afterCleanup idle ready enabled disabled durationMs elapsedMs medianMs p95Ms p99Ms maxMs minMs meanMs rssMiB footprintMiB workingSetMiB privateMiB cpuPercent cpuSeconds timeMs openSourceMs typingMs tabMs scrollMs durationSeconds labelCounts peakMiB firstFileMs fileOpenMs terminalOverheadMiB cleanupMs pid parent exitCode code signal byteLength bytes imageVersion environment sourceCommit target resourceProfile cold warm fresh diagnostics observations snapshots checks acceptance acceptanceCriteria reason limitation limitations').split(' '))
for (const key of 'medium pdf running soak terminalClosed repoClosed input gitOpen largeDiff gitClosed gitRepeatedClosed savedConfigIdle testDialogIdle suiteActive suiteClosed gitCycles afterCycles editor open two hidden runs metrics totals memory process processes returned pidCount firstSourceMs runMs soakSeconds'.split(' ')) knownKeys.add(key)
const stringEnums = new Set(('success failure failed pass passed fail error timeout cancelled rejected unavailable unverified unknown pending skipped skip complete completed incomplete not-verified incomplete-or-failed completed-review-required held exited compile-error runtime-error output-limit not-started in-progress ready stopped preparing compiling running fresh-launch warm-launch welcome one-file ten-tabs terminal-open terminal-closed after-close after-cleanup darwin win32 linux arm64 x64 ia32 c cpp java python javascript typescript json markdown html css sql light dark automatic minimal balanced full main renderer gpu child browser utility node baseline candidate comparison production observed verified not-evaluated not-run unsupported not-applicable failed-verification unable-to-verify verified-by-tests completed-manually').split(' '))
const sensitive = /(?:password|secret|token|api_?key)|^(?:environment|env|argv|args|command|commands|commandLine|stdout|stderr|stdoutTail|stderrTail|output|transcript|transcripts|message|messages|detail|details|stack|exception|exceptions|password|secret|token|apiKey|api_key|content|contents|notes|title|url|urls|path|paths|directory|directories|home|username|userData|profilePath)$|(?:Path|Paths|Directory|CommandLine|Transcript|Password|Secret|Token|ApiKey)$/i
const boolFailureKeys = /^(?:failed|failure|error|hasFailure|failurePresent|failuresPresent)$/i
const countFailureKeys = /^(?:failures|failed|errors|errorCount|failureCount|unsuccessful|timeoutCount)$/i
const badStates = new Set(['failure', 'failed', 'fail', 'error', 'timeout', 'cancelled', 'rejected', 'unavailable', 'unverified', 'not-verified', 'incomplete', 'incomplete-or-failed', 'compile-error', 'runtime-error', 'output-limit', 'failed-verification', 'unable-to-verify', 'not-run'])

function redacted(value, sourceHash) {
  if (typeof value === 'string') return { redacted: true, sha256: digest(value) }
  return { redacted: true, sourceSha256: sourceHash }
}
export function sanitizeReleaseJson(input, sourceHash = digest('unbound synthetic unit input')) {
  const context = { nodes: 0, limited: false, reportedFailure: false, redactedValues: 0 }
  function visit(value, key, depth) {
    context.nodes++
    if (context.nodes > limits.nodes || depth > limits.depth) { context.limited = true; return { redacted: true, limit: true } }
    if ((boolFailureKeys.test(key) && value === true) || (countFailureKeys.test(key) && typeof value === 'number' && value > 0)
      || (['success', 'passed', 'complete', 'completed', 'verified', 'cleanupVerified', 'hostCleanupVerified', 'allCleanupVerified', 'outputComplete'].includes(key) && value === false)
      || (['status', 'state', 'result', 'phase'].includes(key) && badStates.has(value))) context.reportedFailure = true
    if (/^(?:failure|error|errors|failures|exception|exceptions)$/i.test(key) && value && typeof value !== 'number'
      && (typeof value !== 'object' || (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0))) context.reportedFailure = true
    // Do this before primitive handling: even numeric credentials are private.
    if (sensitive.test(key)) { context.redactedValues++; return redacted(value, sourceHash) }
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string') {
      if ((['status', 'state', 'phase', 'kind', 'language', 'platform', 'arch', 'architecture', 'mode', 'label', 'resourceProfile', 'signal'].includes(key)
        && (stringEnums.has(value) || /^SIG(?:INT|TERM|KILL|HUP|BREAK)$/.test(value)))
        || (/^(?:sha|sha256|commit|sourceCommit|sourceSha256|compilerSha256|helperSha256|adapterSha256|mainSha256|mainHash|candidateHash|baselineHash|artifactSha256)$/.test(key) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value))
        || (/^(?:version|node|release|imageVersion)$/.test(key) && /^v?\d+(?:\.\d+){1,3}(?:-[a-z0-9.-]{1,32})?$/i.test(value))) return value
      context.redactedValues++; return redacted(value, sourceHash)
    }
    if (Array.isArray(value)) {
      if (value.length > limits.array) context.limited = true
      const items = value.slice(0, limits.array).map(item => visit(item, key, depth + 1))
      return value.length > limits.array ? { items, originalLength: value.length, incomplete: true } : items
    }
    if (typeof value === 'object') {
      const out = Object.create(null)
      for (const [childKey, child] of Object.entries(value)) {
        if (context.nodes > limits.nodes) { context.limited = true; out.sanitizerLimit = true; break }
        // Unknown labels may themselves contain private names. Hash them too.
        const safeKey = knownKeys.has(childKey)
          ? childKey : 'field_' + digest(childKey)
        out[safeKey] = visit(child, childKey, depth + 1)
      }
      return out
    }
    context.redactedValues++; return { redacted: true }
  }
  const value = visit(input, '', 0)
  return { value, ...context }
}

async function canonicalDirectory(path) {
  const selected = resolve(path)
  assert.ok((await lstat(selected)).isDirectory() && !(await lstat(selected)).isSymbolicLink(), 'Directory redirect is forbidden.')
  const canonical = await realpath(selected)
  // Root aliases such as /var are resolved once; file components cannot redirect.
  return canonical
}
async function boundedRead(root, name, budget) {
  assert.match(name, filename)
  const path = join(root, name), before = await lstat(path)
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Only ordinary JSON receipts are allowed.')
  assert.equal(await realpath(path), path, 'Receipt redirects outside its input folder.')
  assert.ok(before.size <= limits.fileBytes && budget.read + before.size <= limits.readBytes, 'Input evidence budget exceeded.')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    assert.ok(info.isFile() && info.dev === before.dev && info.ino === before.ino && info.size === before.size, 'Receipt changed during opening.')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      assert.ok(bytesRead > 0, 'Incomplete receipt read.'); offset += bytesRead; budget.read += bytesRead
    }
    const after = await file.stat()
    assert.ok(after.size === info.size && after.mtimeMs === info.mtimeMs, 'Receipt changed while reading.')
    return bytes
  } finally { await file.close() }
}
export async function collectReleaseEvidence({ out, rootperformance, imageReceipts }) {
  assert.ok(out && rootperformance)
  const destination = resolve(out)
  await mkdir(dirname(destination), { recursive: true })
  assert.equal(await realpath(dirname(destination)), dirname(destination), 'Output parent redirect is forbidden.')
  await mkdir(destination) // Exclusive ownership; never merge arbitrary files into an upload.
  const budget = { read: 0, written: 0 }, receipts = [], gaps = []
  const gap = code => { if (gaps.length < 256) gaps.push(code) }
  const write = async (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
    assert.ok(budget.written + bytes.length <= limits.writeBytes - (name === 'index.json' ? 0 : 128 * 1024), 'Sanitized output budget exceeded.')
    await writeFile(join(destination, name), bytes, { flag: 'wx', mode: 0o600 }); budget.written += bytes.length
  }
  async function take(root, name, prefix) {
    const publishedName = prefix + name
    try {
      const bytes = await boundedRead(root, name, budget), sha256 = digest(bytes)
      const sanitized = sanitizeReleaseJson(JSON.parse(bytes.toString('utf8')), sha256)
      if (sanitized.limited) gap('sanitizer-limit-reached')
      await write(publishedName, { schemaVersion: 1, sourceSha256: sha256, sourceBytes: bytes.length,
        reportedFailure: sanitized.reportedFailure, redactedValues: sanitized.redactedValues,
        incomplete: sanitized.limited, evidence: sanitized.value })
      receipts.push({ file: publishedName, sourceBytes: bytes.length, sourceSha256: sha256, capturedFailure: sanitized.reportedFailure, captured: true })
    } catch {
      gap('receipt-invalid-redirected-or-over-budget')
      receipts.push({ file: publishedName, captured: false, capturedFailure: null })
    }
  }
  try {
    const root = await canonicalDirectory(rootperformance)
    const directory = await opendir(root)
    let entries = 0, eligible = 0
    try {
      for await (const entry of directory) {
        if (++entries > limits.entries) { gap('input-entry-limit-exceeded'); break }
        if (!filename.test(entry.name)) continue
        if (++eligible > limits.files) { gap('receipt-file-limit-exceeded'); break }
        await take(root, entry.name, 'performance-')
      }
    } finally { await directory.close().catch(() => {}) }
  } catch { gap('performance-folder-missing-or-redirected') }
  if (imageReceipts) {
    try {
      const root = await canonicalDirectory(imageReceipts)
      for (const name of ['commands.json', 'summary.json']) await take(root, name, 'image-')
    } catch { gap('image-receipt-folder-missing-or-redirected') }
  }
  if (!receipts.some(receipt => receipt.captured)) gap('no-json-evidence-captured')
  const index = { schemaVersion: 1, collectionStatus: gaps.length ? 'incomplete' : 'complete',
    releaseDecision: 'not-evaluated', containsReportedFailures: receipts.some(receipt => receipt.capturedFailure),
    sourceReadBytes: budget.read, sanitizedWrittenBytes: budget.written, receipts, gaps,
    rawPathsMessagesEnvironmentAndBinariesPublished: false }
  await write('index.json', index)
  return index
}
async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, rootperformance: { type: 'string' }, 'image-receipts': { type: 'string' } } })
  const result = await collectReleaseEvidence({ ...values, imageReceipts: values['image-receipts'] })
  if (result.collectionStatus !== 'complete') process.exitCode = 1
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  await main().catch(() => { process.stderr.write('Release evidence collection failed; no raw fallback upload is permitted.\n'); process.exitCode = 1 })
}
