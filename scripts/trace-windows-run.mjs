// Reproduce the benchmark's first Run with bounded, event-driven attribution.
// This is diagnostic evidence, never an ordinary performance sample.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, launch, openFolder, openFromExplorer,
  runProgram, sleep, stubDialogs, temporaryDirectory } from './desktop-harness.mjs'
import { windowsProcessTree } from './windows/process-tree.mjs'
import { pdfFixture } from './viewer-fixtures.mjs'

assert.equal(process.platform, 'win32')
const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' },
  out: { type: 'string', default: 'performance-results/windows-run-diagnostic.json' } } })
const output = resolve(values.out), target = await artifact(values.target)
const scratch = await temporaryDirectory('windows-run-diagnostic')
const report = { complete: false, classification: 'Diagnostic-only; no retries or performance aggregation.',
  source: { commit: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null },
  mainSha256: createHash('sha256').update(await readFile(target.args[0])).digest('hex'),
  observer: { boundedRecords: 1024, boundedPending: 256, boundedLifecycleEvents: 2049, noArgumentsPathsContentsOrEnvironment: true,
    timingChanged: 'Diagnostic promise boundaries return derived promises with original values/errors; not performance samples.',
    mechanism: 'AsyncLocalStorage IPC owner, child spawn/status/exit/close, fs promise completion, long timers and main-only correlated internal lifecycle spans.' } }
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
let session, failure
try {
  const project = await createProject(join(scratch, 'benchmark workspace'), { medium: true })
  const pdf = join(project.directory, 'local study.pdf')
  await writeFile(pdf, pdfFixture(2))
  const profile = join(scratch, 'profile')
  const first = await launch(target, profile)
  await close(first)
  const wrapper = join(scratch, 'main-trace.cjs')
  await writeFile(wrapper, 'globalThis.ionRunTrace=require('
    + JSON.stringify(resolve('scripts/windows/run-trace-prelude.cjs')) + ').install();require('
    + JSON.stringify(target.args[0]) + ');')
  session = await launch({ ...target, args: [wrapper] }, profile)
  const { app, page } = session
  await page.context().setOffline(true)
  await stubDialogs(app, { folder: project.directory, allowRun: true })
  async function settle() {
    await sleep(650)
    await windowsProcessTree(session)
    await sleep(3000)
    await windowsProcessTree(session)
  }
  // Preserve every pre-Run workload and fixed settle used by the original trial.
  await settle()
  await openFolder(page, project)
  await openFromExplorer(page, project.program, 'ION-DESKTOP-RUN-OK')
  await settle()
  for (const path of project.files.slice(0, 9)) await openFromExplorer(page, path, 'Ion fixture')
  await settle()
  for (const directory of project.directories.slice(0, 6)) await atPath(page, 'explorer-entry', directory).click()
  await settle()
  await atPath(page, 'explorer-entry', pdf).click()
  await page.locator('[data-rendered=true] [data-testid=pdf-page-canvas]').first().waitFor()
  await settle()
  await atPath(page, 'close-tab', pdf).click()
  await atPath(page, 'tab', project.program).locator('.tab-name').click()
  await app.evaluate(() => globalThis.ionRunTrace.start())
  report.phase = 'run-program'
  await persist()
  // Current outcome-driven, IPC-correlated stage watchdog. No retry; this new
  // diagnostic is not pooled with historical 15-second success-only samples.
  report.runMs = await runProgram(page)
  report.runSucceeded = true
} catch (error) {
  failure = error
  report.error = { name: error.name, message: String(error.message).slice(0, 1000) }
} finally {
  if (session) {
    try {
      report.trace = await session.app.evaluate(() => globalThis.ionRunTrace.snapshot())
      assert.ok(report.trace.lifecycle.length > 0, 'Expected correlated internal lifecycle evidence')
      assert.equal(report.trace.lifecycleOverflow, false, 'Internal lifecycle evidence was truncated')
      if (report.runSucceeded) {
        const groups = Map.groupBy(report.trace.lifecycle, event => event.id)
        assert.equal(groups.size, 1)
        for (const events of groups.values()) {
          assert.ok(events.every((event, n) => !n || event.ms >= events[n - 1].ms))
          assert.equal(events.at(-1).stage, 'request')
          assert.equal(events.at(-1).event, 'end')
          assert.ok(events.some(event => event.stage === 'engine-result' && event.value === 'success'))
        }
        report.internalTraceVerified = true
      }
    } catch (error) { report.traceUnavailable = String(error.message).slice(0, 500); failure ??= error }
    try {
      report.ui = await session.page.evaluate(() => {
        const node = document.querySelector('[data-testid="output"]')
        return { phase: node?.getAttribute('data-phase'), status: node?.getAttribute('data-status') }
      })
      report.nativeBeforeCleanup = await windowsProcessTree(session)
    } catch (error) { report.nativeUnavailable = String(error.message).slice(0, 500) }
    await persist()
    try { await session.app.evaluate(() => globalThis.ionRunTrace.dispose()); report.traceDisposed = true }
    catch (error) { report.traceDisposeError = String(error.message).slice(0, 500); failure ??= error }
    try {
      await close(session)
      report.exit = { code: session.appProcess.exitCode, signal: session.appProcess.signalCode }
      assert.deepEqual(report.exit, { code: 0, signal: null })
      report.afterCleanup = await windowsProcessTree(session)
      assert.equal(report.afterCleanup.members.length, 0)
      report.cleanupVerified = true
    } catch (error) {
      report.cleanupError = String(error.message).slice(0, 500)
      failure ??= error
    }
  }
  report.complete = Boolean(report.runSucceeded && report.cleanupVerified && !failure)
  if (report.complete) { await rm(scratch, { recursive: true, force: true }); report.scratchRemoved = true }
  else report.syntheticScratchRetained = true
  report.endedAt = new Date().toISOString()
  await persist()
}
console.log(JSON.stringify({ complete: report.complete, phase: report.phase, error: report.error, output }))
if (failure) throw failure
