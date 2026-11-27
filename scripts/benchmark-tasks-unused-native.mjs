import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { control, launch, stop, cleanupFailed, rpc, tree, sleep, eventEvidence } from './core-native/session.mjs'
import { median } from './benchmark-resource-metrics.mjs'
import { identityCpuPercent } from './process-family.mjs'

assert.equal(process.env.CI, 'true', 'Native metrics are restricted to an approved CI host')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use the approved isolated GitHub Actions host')

const execute = promisify(execFile)
const baseline = resolve(process.argv[2])
const candidate = resolve(process.argv[3] ?? 'dist')
const baselineSha = process.env.ION_TASKS_BASELINE_SHA
const candidateSha = process.env.ION_TASKS_APPLICATION_SHA
assert.match(baselineSha ?? '', /^[0-9a-f]{40}$/)
assert.match(candidateSha ?? '', /^[0-9a-f]{40}$/)

const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-tasks-unused-')))
const token = randomUUID()
const outputDirectory = resolve('performance-results/phase2-tasks')
const output = join(outputDirectory, 'paired-unused-resources.json')
await mkdir(outputDirectory, { recursive: true })
await writeFile(join(root, 'owner'), token, { flag: 'wx', mode: 0o600 })

const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null
}
const summary = values => {
  const finite = values.filter(Number.isFinite)
  return { median: median(finite), p95: percentile(finite, 0.95), max: finite.length ? Math.max(...finite) : null }
}
const deltaPercent = (before, after) => before > 0 ? (after - before) / before * 100 : null
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')

const report = {
  schemaVersion: 1,
  complete: false,
  source: process.env.GITHUB_SHA,
  baselineSha,
  candidateSha,
  host: {
    platform: process.platform,
    release: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model,
    logicalCores: cpus().length,
    ramBytes: totalmem(),
  },
  protocol: {
    pairs: 4,
    ordering: 'AB/BA alternating and serialized',
    profile: 'Fresh disposable profile per build attempt; Minimal resource mode; identical 80-line C source',
    startup: 'Cold process launch, clean shutdown, then same-profile warm launch. Startup ends when the production Settings control is observable.',
    firstFile: 'Open-file action to visible source text in Monaco.',
    typing: 'Monaco model-change event to the second animation-frame callback for 20 individual characters. This is a renderer presentation proxy, not physical key-to-photon latency.',
    idle: 'Six process-family samples over ten seconds after one file is open; no task picker or task is opened.',
    memory: 'macOS reports summed phys_footprint and RSS. Windows reports summed private bytes and working sets. RSS/working-set sums may count shared pages repeatedly.',
    cpu: 'Percent of one core from stable native process identities.',
    limits: 'Hosted native runner evidence, not laptop battery or physical-display evidence. No failed or slow sample is discarded.',
  },
  artifacts: {
    baselineMainSha256: await hash(join(baseline, 'main/index.cjs')),
    candidateMainSha256: await hash(join(candidate, 'main/index.cjs')),
  },
  attempts: [],
}
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
await save()

const probe = join(root, 'rusage')
if (process.platform === 'darwin') {
  await execute('/usr/bin/clang', ['-O2', '-std=c11', 'scripts/benchmark-resources-probe.c', '-o', probe])
}

let current
async function processSample(session) {
  const before = await tree(session)
  const record = { ...before }
  assert.ok(before.rootAlive && before.members.length, 'Cannot measure an exited application as zero RAM')
  if (process.platform === 'win32') {
    return Object.assign(record, {
      cpuSecondsByIdentity: Object.fromEntries(before.members.map(item => [item.pid + ':' + item.started, item.cpuSeconds])),
    })
  }
  const { stdout } = await execute(probe, before.members.map(item => String(item.pid)), { timeout: 8_000, maxBuffer: 65_536 })
  const native = new Map(stdout.trim().split('\n').filter(Boolean).map(row => {
    const [pid, footprint, cpuNs] = row.split(/\s+/).map(Number)
    return [pid, { footprint, cpuNs }]
  }))
  const after = await tree(session)
  const identities = new Map(after.members.map(item => [item.pid, item.started]))
  assert.ok(before.members.length === after.members.length
    && before.members.every(item => identities.get(item.pid) === item.started && native.has(item.pid)),
  'Native process identity changed during a resource sample')
  return Object.assign(record, {
    footprintMiB: before.members.reduce((total, item) => total + native.get(item.pid).footprint / 1024 ** 2, 0),
    cpuSecondsByIdentity: Object.fromEntries(before.members.map(item => [item.pid + ':' + item.started, native.get(item.pid).cpuNs / 1e9])),
  })
}

async function idlePhase(session) {
  const samples = []
  await sleep(2_000)
  for (let index = 0; index < 6; index++) {
    samples.push(await processSample(session))
    await save()
    if (index < 5) await sleep(2_000)
  }
  const memory = {}
  for (const field of ['rssMiB', 'footprintMiB', 'workingSetMiB', 'privateMiB']) {
    if (samples.every(sample => Number.isFinite(sample[field]))) {
      memory[field] = summary(samples.map(sample => sample[field]))
    }
  }
  return {
    samples,
    memory,
    cpuPercentOneCore: identityCpuPercent(samples[0], samples.at(-1)),
    processCount: samples.map(sample => sample.members.length),
    childProcessCount: samples.map(sample => sample.members.filter(member => member.kind === 'child').length),
  }
}

async function typingSamples(session, editorApiAsset) {
  const page = session.page
  await page.evaluate(async asset => {
    const url = new URL(`assets/${asset}`, document.baseURI).href
    const { editor } = await import(url)
    const widget = editor.getEditors().find(item => item.getDomNode()?.closest('[data-testid="editor"]'))
    const model = widget?.getModel()
    if (!widget || !model) throw new Error('The active Monaco editor is unavailable')
    widget.setPosition({ lineNumber: model.getLineCount(), column: model.getLineMaxColumn(model.getLineCount()) })
    widget.focus()
    globalThis.__ionTasksTyping = { widget, model, initialLength: model.getValueLength() }
  }, editorApiAsset)
  const values = []
  for (let index = 0; index < 20; index++) {
    await page.evaluate(() => {
      globalThis.__ionNextInput = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          subscription.dispose()
          reject(new Error('The editor model did not observe inserted text within five seconds'))
        }, 5_000)
        const subscription = globalThis.__ionTasksTyping.model.onDidChangeContent(() => {
          subscription.dispose()
          clearTimeout(timeout)
          const changedAt = performance.now()
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - changedAt)))
        })
      })
    })
    await page.keyboard.insertText('x')
    values.push(await page.evaluate(() => globalThis.__ionNextInput))
  }
  const finalLength = await page.evaluate(() => globalThis.__ionTasksTyping.model.getValueLength())
  assert.equal(finalLength, await page.evaluate(() => globalThis.__ionTasksTyping.initialLength) + 20)
  return values
}

try {
  for (let pair = 0; pair < 4; pair++) {
    for (const label of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      console.log(`Starting matched attempt ${pair + 1}/4 ${label}`)
      const attempt = { pair, label, status: 'running' }
      report.attempts.push(attempt)
      await save()
      const profile = join(root, `${pair}-${label}-profile`)
      const workspace = join(root, `${pair}-${label}-workspace`)
      await mkdir(profile)
      await mkdir(workspace)
      await writeFile(join(profile, 'preferences.json'), JSON.stringify({
        version: 1,
        settings: { autoSave: false, resourceProfile: 'minimal' },
        recents: [],
      }))
      await writeFile(join(workspace, 'main.c'), '#include <stdio.h>\nint main(void) { return 0; }\n' + '/* fixed source line */\n'.repeat(77))
      await control(profile, { workspace })
      const target = label === 'baseline' ? baseline : candidate
      const editorApiAssets = (await readdir(join(target, 'renderer/assets'))).filter(name => /^editor\.api-[^/]+\.js$/.test(name))
      assert.equal(editorApiAssets.length, 1, `Expected one ${label} editor API asset`)

      current = await launch(target, profile, root, token)
      attempt.coldStartupMs = current.startupMs
      attempt.coldStartupStages = current.startupStages
      await stop(current)
      current = await launch(target, profile, root, token)
      attempt.warmStartupMs = current.startupMs
      attempt.warmStartupStages = current.startupStages

      const page = current.page
      const openedAt = performance.now()
      await page.getByTestId('open-file').first().click()
      await page.locator('.monaco-editor .view-lines').getByText('#include', { exact: false }).waitFor()
      attempt.firstFileMs = performance.now() - openedAt
      attempt.typingMs = await typingSamples(current, editorApiAssets[0])
      attempt.idle = await idlePhase(current)
      assert.ok(attempt.idle.childProcessCount.every(count => count === 0), 'Unused tasks started an owned child process')
      if (label === 'candidate') {
        const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name.split('/').at(-1)))
        attempt.loadedRendererResources = loaded
        assert.equal(loaded.some(name => /^TaskPicker-/.test(name ?? '')), false, 'The task picker loaded before use')
        assert.equal(await page.getByRole('dialog', { name: 'Run Task', exact: true }).count(), 0)
      }
      await stop(current)
      current = null
      attempt.cleanup = 'owned family empty'
      attempt.status = 'passed'
      await save()
      console.log(`Completed matched attempt ${pair + 1}/4 ${label}`)
    }
  }

  const byLabel = label => report.attempts.filter(attempt => attempt.label === label)
  const summarizeBuild = label => {
    const attempts = byLabel(label)
    const memoryFields = ['rssMiB', 'footprintMiB', 'workingSetMiB', 'privateMiB']
    const memory = {}
    for (const field of memoryFields) {
      const values = attempts.map(attempt => attempt.idle.memory[field]?.median).filter(Number.isFinite)
      if (values.length) memory[field] = summary(values)
    }
    return {
      coldStartupMs: summary(attempts.map(attempt => attempt.coldStartupMs)),
      warmStartupMs: summary(attempts.map(attempt => attempt.warmStartupMs)),
      firstFileMs: summary(attempts.map(attempt => attempt.firstFileMs)),
      typingMs: summary(attempts.flatMap(attempt => attempt.typingMs)),
      idleCpuPercentOneCore: summary(attempts.map(attempt => attempt.idle.cpuPercentOneCore)),
      memory,
      processCounts: attempts.flatMap(attempt => attempt.idle.processCount),
    }
  }
  report.summary = { baseline: summarizeBuild('baseline'), candidate: summarizeBuild('candidate') }
  report.comparison = {
    coldStartupPercent: deltaPercent(report.summary.baseline.coldStartupMs.median, report.summary.candidate.coldStartupMs.median),
    warmStartupPercent: deltaPercent(report.summary.baseline.warmStartupMs.median, report.summary.candidate.warmStartupMs.median),
    firstFilePercent: deltaPercent(report.summary.baseline.firstFileMs.median, report.summary.candidate.firstFileMs.median),
    typingPercent: deltaPercent(report.summary.baseline.typingMs.median, report.summary.candidate.typingMs.median),
  }
  report.complete = true
  await save()
  assert.ok(report.comparison.coldStartupPercent <= 10, `Cold startup regressed ${report.comparison.coldStartupPercent.toFixed(2)}%`)
  assert.ok(report.comparison.warmStartupPercent <= 10, `Warm startup regressed ${report.comparison.warmStartupPercent.toFixed(2)}%`)
  assert.ok(report.comparison.firstFilePercent <= 10, `First file regressed ${report.comparison.firstFilePercent.toFixed(2)}%`)
} catch (error) {
  const attempt = report.attempts.at(-1)
  if (attempt?.status === 'running') {
    attempt.status = 'failed'
    attempt.failure = error.message
  }
  report.failure = error.message
  await save()
  throw error
} finally {
  let cleanupError
  try {
    if (current) await cleanupFailed(current)
  } catch (error) {
    cleanupError = error
    report.cleanupFailure = error.message
    report.complete = false
  } finally {
    if (current) report.finalEvents = await eventEvidence(current.profile)
    await save()
  }
  if (cleanupError) throw cleanupError
  try {
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    report.cleanupFailure = error.message
    report.complete = false
    await save()
    throw error
  }
}

console.log(JSON.stringify({ summary: report.summary, comparison: report.comparison }, null, 2))
