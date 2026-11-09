import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  artifact, atPath, close, cpuPercent, createProject, editorShows, eventually, launch, openFolder,
  openFromExplorer, resourceSnapshot, runProgram, sleep, stubDialogs, waitForFile, withScratch,
} from './desktop-harness.mjs'
import { extendedResourceMetrics, median } from './benchmark-resource-metrics.mjs'

const { values: options } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  label: { type: 'string', default: 'candidate' },
  'compare-report': { type: 'string' },
  'idle-seconds': { type: 'string', default: '75' },
  'settle-ms': { type: 'string', default: '1500' },
  launches: { type: 'string', default: '5' },
  cycles: { type: 'string', default: '12' },
  executions: { type: 'string', default: '6' },
  'extended-rounds': { type: 'string' },
  'strict-targets': { type: 'boolean' },
  'window-close-only': { type: 'boolean' },
  out: { type: 'string', default: 'performance-results' },
  help: { type: 'boolean' },
} })

if (options.help) {
  console.log('node scripts/benchmark-resources.mjs [--target dist] [--label candidate] [--compare-report baseline.json] [--idle-seconds 75] [--settle-ms 1500] [--launches 5] [--cycles 12] [--executions 6] [--extended-rounds 30] [--window-close-only] [--strict-targets] [--out performance-results]')
  process.exit(0)
}
assert.equal(process.platform, 'darwin', 'This benchmark uses macOS process accounting.')
assert.match(options.label, /^[\w-]+$/, 'Label may contain letters, numbers, dashes, and underscores.')
const count = (key, max) => {
  const value = Number(options[key])
  assert.ok(Number.isInteger(value) && value > 0 && value <= max, `--${key} must be between 1 and ${max}.`)
  return value
}
const protocol = {
  idleSeconds: count('idle-seconds', 3600), settleMs: count('settle-ms', 15_000),
  launches: count('launches', 100), optionalCycles: count('cycles', 300),
  executions: count('executions', 100), idleIntervalMs: 5000, compilerIntervalMs: 25,
  ...(options['extended-rounds'] !== undefined && { extendedRounds: count('extended-rounds', 300) }),
}
assert.ok(!options['window-close-only'] || !protocol.extendedRounds, '--window-close-only and --extended-rounds are separate workloads.')
const execute = promisify(execFile)
const system = (command, ...args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const mib = (bytes) => bytes === null ? null : bytes / 1024 ** 2
const target = await artifact(options.target)
assert.ok(!target.path.endsWith('.app'), 'Use an unpackaged production build so Playwright can attach to Electron.')
const timestamp = new Date().toISOString()
const output = resolve(options.out, `resources-${options.label}-${timestamp.replaceAll(':', '-')}.json`)
await mkdir(resolve(options.out), { recursive: true })

const report = {
  schemaVersion: 1, label: options.label, timestamp, protocol, mode: options['window-close-only'] ? 'window-close' : 'workload',
  artifact: {
    target: options.target,
    mainSha256: sha(await readFile(join(target.path, 'main/index.cjs'))),
    rendererHtmlSha256: sha(await readFile(join(target.path, 'renderer/index.html'))),
  },
  host: {
    macOS: system('/usr/bin/sw_vers'), processor: system('/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'),
    ramBytes: Number(system('/usr/sbin/sysctl', '-n', 'hw.memsize')),
    arch: process.arch, node: process.version, power: system('/usr/bin/pmset', '-g', 'batt').split('\n')[0],
    thermal: system('/usr/bin/pmset', '-g', 'therm'),
  },
  notes: {
    startup: 'Playwright process launch to visible Welcome. Fresh or reused disposable profile. OS caches untouched.',
    rss: 'Sum of per-process resident sets, including Electron descendants and profile-marked helpers. Shared pages may be counted repeatedly.',
    footprint: 'Sum of macOS kernel phys_footprint ledger charges for the same process family. Attributed process charges, not a de-duplicated measurement of physical RAM.',
    cpu: 'Percent of one logical core. Delta of own-process kernel user and system CPU time, with ps CPU-time fallback. Short-lived compiler CPU is also read from main-process reaped child counters.',
    typing: 'Chromium keydown to second animation callback, with visible content and autosave verified. Excludes OS input delivery and physical display presentation.',
    stages: 'One 650-line plain-text fixture per note, one native C source, and 40 subfolders of 25 files each. Stages are cumulative within one process, and memory snapshots are post-settle.',
    ...(protocol.extendedRounds && { extended: 'Separate offline profile. Each round selects five tabs, edits and saves a note, completes a C run and stops a waiting C program. First five rounds reopen the large source. Extended tree CPU adds main-process reaped child CPU to the CPU of stable processes.' }),
    targetUnits: 'Provisional budgets use decimal MB. Raw measurements report bytes for footprint and MiB for RSS.',
  },
  launches: [], stages: {}, panels: {}, runs: {},
}
const record = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
let probe

async function snapshot(session) {
  const sample = await resourceSnapshot(session, { details: true })
  const ids = sample.members.map(({ pid }) => String(pid))
  const rows = probe && ids.length
    ? (await execute(probe, ids)).stdout.trim().split('\n').filter(Boolean)
    : []
  const byPid = new Map(rows.map((row) => {
    const [pid, footprintBytes, cpuNs, reapedChildCpuNs, idleWakeups] = row.split(' ').map(Number)
    return [pid, { footprintBytes, cpuNs, reapedChildCpuNs, idleWakeups }]
  }))
  const members = sample.members.map((member) => ({ ...member, ...byPid.get(member.pid) }))
  const summedFootprint = (list) => probe && list.every(({ footprintBytes }) => Number.isFinite(footprintBytes))
    ? list.reduce((total, { footprintBytes }) => total + footprintBytes, 0) : null
  return {
    timeMs: sample.timeMs, rssMiB: sample.rssMiB, ideRssMiB: sample.ideRssMiB, childRssMiB: sample.childRssMiB,
    footprintBytes: summedFootprint(members),
    ideFootprintBytes: summedFootprint(members.filter(({ kind }) => kind !== 'child')),
    childFootprintBytes: summedFootprint(members.filter(({ kind }) => kind === 'child')),
    members,
  }
}

function usageCpu(first, last) {
  const before = new Map(first.members.map((member) => [member.pid, member]))
  const stable = last.members.filter(({ pid }) => before.has(pid))
  const elapsedSeconds = (last.timeMs - first.timeMs) / 1000
  if (stable.every(({ cpuNs, pid }) => Number.isFinite(cpuNs) && Number.isFinite(before.get(pid).cpuNs))) {
    const ns = stable.reduce((total, { pid, cpuNs }) => total + Math.max(0, cpuNs - before.get(pid).cpuNs), 0)
    return ns / 1e9 / elapsedSeconds * 100
  }
  return cpuPercent(
    { ...first, cpuSecondsByPid: Object.fromEntries(first.members.map(({ pid, cpuSeconds }) => [pid, cpuSeconds])) },
    { ...last, cpuSecondsByPid: Object.fromEntries(last.members.map(({ pid, cpuSeconds }) => [pid, cpuSeconds])) },
  )
}

async function idleWindow(session) {
  await sleep(protocol.settleMs)
  const samples = [await snapshot(session)]
  const until = performance.now() + protocol.idleSeconds * 1000
  while (performance.now() < until) {
    await sleep(Math.min(protocol.idleIntervalMs, Math.max(0, until - performance.now())))
    samples.push(await snapshot(session))
  }
  return { samples, cpuPercent: usageCpu(samples[0], samples.at(-1)) }
}

async function stage(session, key) {
  await sleep(protocol.settleMs)
  report.stages[key] = await snapshot(session)
}

const panelInfo = {
  learn: { name: 'Learn', id: 'learning-pane' },
  projects: { name: 'Projects', id: 'projects-panel' },
  practice: { name: 'Practice', id: 'practice-pane' },
}

function panelTimings(panels) {
  return Object.fromEntries(Object.entries(panels).flatMap(([mode, { firstMs, cycles }]) => [
    [`${mode}FirstMs`, firstMs],
    [`${mode}ReopenMs`, median(cycles.map(({ reopenMs }) => reopenMs))],
    [`${mode}CloseMs`, median(cycles.map(({ closeMs }) => closeMs))],
  ]))
}

async function switchWorkspace(page, mode) {
  await page.getByRole('button', { name: 'Welcome', exact: true }).click()
  const start = performance.now()
  await page.getByTestId(`workspace-${mode}`).click()
  await page.getByTestId(panelInfo[mode].id).waitFor()
  return performance.now() - start
}

async function populatePanel(session, mode) {
  const { page } = session
  if (mode === 'learn') {
    if (await page.evaluate(() => Boolean(window.ion.learningPacks))) {
      const firstMs = await page.getByTestId('learning-open-marketplace').evaluate((trigger) => new Promise((resolve, reject) => {
        const start = performance.now()
        const timer = setTimeout(() => {
          changes.disconnect()
          reject(new Error('Marketplace did not show its catalog.'))
        }, 8000)
        const changes = new MutationObserver(() => {
          if (!document.querySelector('[data-testid="marketplace-install"]')) return
          changes.disconnect()
          clearTimeout(timer)
          resolve(performance.now() - start)
        })
        changes.observe(document.body, { childList: true, subtree: true })
        trigger.click()
      }))
      const install = page.locator('[data-testid="marketplace-install"][data-pack="c"]')
      report.learningMarketplace = { firstMs }
      await stage(session, 'marketplace')
      const installStarted = performance.now()
      await install.click()
      const choose = page.locator('[data-testid="marketplace-use"][data-pack="c"]')
      await choose.waitFor()
      report.learningMarketplace.installMs = performance.now() - installStarted
      await choose.click()
      const first = page.getByTestId('learning-topic').first()
      await first.waitFor()
      const lessonStarted = performance.now()
      await first.click()
      await page.getByTestId('learning-pack-lesson').waitFor()
      report.learningMarketplace.openLessonMs = performance.now() - lessonStarted
      return
    }
    await page.getByTestId('learning-topics').click()
    await page.locator('.learning-topic-list button').first().click()
    await page.getByTestId('learning-concept').waitFor()
  } else if (mode === 'projects') {
    await page.getByTestId('project-title').fill('Resource benchmark')
    await page.getByTestId('project-description').fill('Exercise the local roadmap view.')
    await page.getByTestId('project-create').click()
    await page.getByTestId('project-edit').waitFor()
  } else {
    if (await page.evaluate(() => Boolean(window.ion.practice.browse))) {
      await page.getByTestId('practice-language').selectOption('python')
      const filterStart = performance.now()
      await page.getByTestId('practice-difficulty').selectOption('Easy')
      const first = page.getByTestId('practice-challenge').first().getByTestId('practice-start')
      await first.waitFor()
      const filterMs = performance.now() - filterStart
      const started = performance.now()
      await first.click()
      await page.getByTestId('practice-run-samples').waitFor()
      const starter = await editorShows(page, 'Write your solution here.')
      await starter.dispose()
      report.practiceCatalog = { filterMs, startMs: performance.now() - started }
      return
    }
    await page.getByTestId('practice-new').click()
    await page.getByTestId('practice-title').fill('Resource benchmark')
    await page.getByTestId('practice-statement').fill('Print a marker on standard output.')
    await page.getByTestId('practice-save').click()
    await page.getByTestId('practice-new-attempt').waitFor()
  }
}

async function measureTyping(page, file) {
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 360, y: 7 } })
  await page.evaluate(() => {
    const timings = []
    const listener = (event) => {
      if (event.key !== 'x') return
      const start = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => timings.push(performance.now() - start)))
    }
    document.addEventListener('keydown', listener, true)
    window.ionResourceTyping = { timings, dispose: () => document.removeEventListener('keydown', listener, true) }
  })
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press('x')
    await page.waitForFunction((count) => window.ionResourceTyping.timings.length >= count, index + 1)
  }
  const samples = await page.evaluate(() => {
    const { timings, dispose } = window.ionResourceTyping
    dispose()
    delete window.ionResourceTyping
    return timings
  })
  await editorShows(page, 'x'.repeat(20))
  await waitForFile(readFile, file, 'x'.repeat(20))
  return samples
}

async function measureNativeRuns(session, project) {
  const { page } = session
  await openFromExplorer(page, project.sampled, '#define')
  const before = await snapshot(session)
  const active = []
  let running = true
  const sampler = (async () => {
    while (running) {
      active.push(await snapshot(session))
      await sleep(protocol.compilerIntervalMs)
    }
  })()
  try {
    await runProgram(page)
  } finally {
    running = false
    await sampler
  }
  const after = await snapshot(session)
  const previous = before.members.find(({ kind }) => kind === 'main')?.reapedChildCpuNs
  const current = after.members.find(({ kind }) => kind === 'main')?.reapedChildCpuNs
  const reapedChildCpuMs = Number.isFinite(previous) && Number.isFinite(current) ? (current - previous) / 1e6 : null
  const timings = []
  await openFromExplorer(page, project.program, '#include')
  for (let index = 0; index < protocol.executions; index += 1) timings.push(await runProgram(page))
  await sleep(protocol.settleMs)
  const settled = await snapshot(session)
  assert.equal(settled.members.filter(({ kind }) => kind === 'child').length, 0, 'No native child residue after verified runs')
  return { before, active, after, settled, reapedChildCpuMs, timings }
}

async function workload(session, project) {
  const { app, page } = session
  await stubDialogs(app, { folder: project.directory, allowRun: true })
  report.coreProfile = await page.evaluate(async () => (await window.ion.getPreferences()).settings.resourceProfile ?? 'legacy')
  report.idle = await idleWindow(session)
  report.initialOptionalAssets = await page.evaluate(() => performance.getEntriesByType('resource')
    .map(({ name }) => name.split('/').at(-1)).filter((name) => /^(LearningPane|MarketplacePane|ProjectsPanel|PracticePane)-/.test(name)))
  assert.deepEqual(report.initialOptionalAssets, [], 'Welcome did not load an optional workspace renderer chunk')
  await openFolder(page, project)
  report.firstFileMs = await openFromExplorer(page, project.program, '#include')
  await stage(session, 'oneCFile')
  report.nextFilesMs = []
  for (const file of project.files.slice(0, 9)) {
    report.nextFilesMs.push(await openFromExplorer(page, file, `Ion fixture ${basename(file)}`))
  }
  assert.equal(await page.getByTestId('tab').count(), 10)
  await stage(session, 'tenTabs')
  report.typingMs = await measureTyping(page, project.files[8])
  for (const directory of project.directories.slice(0, 6)) {
    await atPath(page, 'explorer-entry', directory).click()
    await atPath(page, 'explorer-entry', join(directory, 'source-00.txt')).waitFor()
  }
  await stage(session, 'mediumProject')
  report.runs = await measureNativeRuns(session, project)
  await page.getByTestId('settings').click()
  const profile = page.getByTestId('resource-profile')
  if (await profile.count()) await profile.selectOption('full')
  await page.getByRole('dialog', { name: 'Preferences' }).getByRole('button', { name: 'Done' }).click()
  report.modulesProfile = await page.evaluate(async () => (await window.ion.getPreferences()).settings.resourceProfile ?? 'legacy')
  await stage(session, 'beforeOptionalPanels')
  for (const [index, mode] of Object.keys(panelInfo).entries()) {
    const { name, id } = panelInfo[mode]
    const panel = page.getByTestId(id)
    const firstMs = await switchWorkspace(page, mode)
    await populatePanel(session, mode)
    await stage(session, mode)
    const toggle = page.getByRole('button', { name: `Toggle ${name} panel` })
    const cycles = []
    const cycleCount = Math.floor(protocol.optionalCycles / 3) + (index < protocol.optionalCycles % 3 ? 1 : 0)
    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      const closing = performance.now()
      await toggle.click()
      await panel.waitFor({ state: 'detached' })
      const closeMs = performance.now() - closing
      await sleep(Math.min(protocol.settleMs, 500))
      const closed = await snapshot(session)
      const start = performance.now()
      await toggle.click()
      await panel.waitFor()
      cycles.push({ closed, closeMs, reopenMs: performance.now() - start })
    }
    await toggle.click()
    await panel.waitFor({ state: 'detached' })
    await stage(session, `${mode}Closed`)
    report.panels[mode] = { firstMs, cycles }
    await record()
  }
  await page.getByRole('button', { name: 'Welcome', exact: true }).click()
  await page.getByTestId('welcome').waitFor()
  await stage(session, 'returnedToWelcome')
  assert.equal(report.stages.returnedToWelcome.members.filter(({ kind }) => kind === 'child').length, 0)
}

async function measureLastWindow(session) {
  const { app, page } = session
  await page.getByTestId('settings').click()
  const profile = page.getByTestId('resource-profile')
  if (await profile.count()) await profile.selectOption('minimal')
  await page.getByRole('dialog', { name: 'Preferences' }).getByRole('button', { name: 'Done' }).click()
  const current = await page.evaluate(async () => (await window.ion.getPreferences()).settings.resourceProfile ?? 'legacy')
  const window = await app.browserWindow(page)
  const gone = page.waitForEvent('close', { timeout: 5000 })
  const start = performance.now()
  const [closed] = await Promise.allSettled([gone, window.evaluate((native) => native.close())])
  if (closed.status === 'rejected') throw closed.reason
  const windowClosedMs = performance.now() - start
  await sleep(protocol.settleMs)
  const processFamily = await snapshot(session)
  assert.equal(processFamily.members.filter(({ kind }) => kind === 'child').length, 0, 'No native child remains after closing the window')
  return { profile: current, windowClosedMs, appExited: processFamily.members.length === 0, processFamily }
}

async function selectSource(page, path, marker) {
  const tab = atPath(page, 'tab', path)
  const start = performance.now()
  await tab.locator('button.tab-name').click()
  await tab.locator('[aria-current="true"]').waitFor()
  const rendered = await editorShows(page, marker)
  await rendered.dispose()
  return performance.now() - start
}

function processExited(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
}

async function measureStop(session) {
  const { page } = session
  const consolePanel = page.getByTestId('output')
  await page.getByTestId('run').click()
  await page.locator('[data-testid="output"][data-phase="running"]').waitFor()
  const marker = await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="run-console-terminal"] .xterm-rows')?.textContent
    return Number(/ION-BENCH-STOP:(\d+)/.exec(text)?.[1]) || false
  })
  const program = await marker.jsonValue()
  await marker.dispose()
  const active = await snapshot(session)
  const pids = active.members.filter(({ kind }) => kind === 'child').map(({ pid }) => pid)
  assert.equal(pids.length, 2, 'The stop fixture runs with one PTY helper')
  assert.ok(pids.includes(program), 'The program PID belongs to this app')
  const started = performance.now()
  await page.getByTestId('run-console-stop').click()
  await consolePanel.and(page.locator('[data-status="cancelled"]')).waitFor()
  await eventually(() => pids.every(processExited), 'The stopped program and helper must exit')
  return { ms: performance.now() - started, active }
}

async function measureExtended(scratch) {
  const project = await createProject(join(scratch, 'extended coding project'), { fileCount: 5 })
  const largePath = join(project.directory, 'large-source.c')
  const largeMarker = 'ION-BENCH-LARGE-SOURCE'
  const largeSource = `/* ${largeMarker} */\n` + Array.from({ length: 28_000 }, (_, index) =>
    `static const unsigned item_${index} = ${index}u; /* fixture */\n`).join('')
  const largeBytes = Buffer.byteLength(largeSource)
  assert.ok(largeBytes > 1.4 * 1024 ** 2 && largeBytes < 2 * 1024 ** 2)
  await Promise.all([
    writeFile(largePath, largeSource),
    writeFile(project.loop, '#include <stdio.h>\n#include <unistd.h>\n'
      + 'int main(void) { printf("ION-BENCH-STOP:%ld\\n", (long)getpid()); fflush(stdout); getchar(); return 0; }\n'),
  ])
  const profile = join(scratch, 'extended-profile')
  await mkdir(profile)
  const session = await launch(target, profile)
  const { app, page } = session
  const noteMarker = (path) => `Ion fixture ${basename(path)}`
  const closeLarge = () => atPath(page, 'close-tab', largePath).click()
  try {
    await app.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    await openFolder(page, project)
    const firstLargeMs = await openFromExplorer(page, largePath, largeMarker)
    const largeOpen = await snapshot(session)
    await closeLarge()
    await openFromExplorer(page, project.program, '#include')
    await openFromExplorer(page, project.loop, '#include')
    for (const path of project.files) await openFromExplorer(page, path, noteMarker(path))
    const warmup = await snapshot(session)
    const rounds = []
    for (let index = 0; index < protocol.extendedRounds; index += 1) {
      const round = { rotationSwitchMs: [] }
      if (index < 5) {
        round.largeReopenMs = await openFromExplorer(page, largePath, largeMarker)
        await closeLarge()
      }
      for (const path of project.files) round.rotationSwitchMs.push(await selectSource(page, path, noteMarker(path)))
      const editPath = project.files.at(-2)
      round.cachedSwitchMs = await selectSource(page, editPath, noteMarker(editPath))
      const edit = 'ION-BENCH-SAVE-' + String(index).padStart(3, '0')
      await page.locator('.monaco-editor .view-line').nth(1).click({ position: { x: 3, y: 5 } })
      await page.keyboard.insertText(edit + ' ')
      const rendered = await editorShows(page, edit)
      await rendered.dispose()
      await page.getByTestId('save-file').click()
      await waitForFile(readFile, editPath, edit)
      await selectSource(page, project.program, '#include')
      round.runMs = await runProgram(page)
      await selectSource(page, project.loop, '#include')
      round.stop = await measureStop(session)
      await sleep(Math.min(protocol.settleMs, 250))
      round.settled = await snapshot(session)
      assert.equal(round.settled.members.filter(({ kind }) => kind === 'child').length, 0)
      rounds.push(round)
    }
    assert.deepEqual(session.errors, [], 'No renderer errors in the extended workload')
    assert.deepEqual(session.requests, [], 'No renderer network requests in the extended workload')
    return { largeBytes, firstLargeMs, largeOpen, warmup, rounds }
  } finally {
    await close(session)
    await eventually(async () => !(await snapshot(session)).members.length, 'The extended process family must exit')
  }
}

async function measure(scratch) {
  try {
    probe = join(scratch, 'rusage')
    await execute('/usr/bin/clang', ['-O2', '-std=c11', 'scripts/benchmark-resources-probe.c', '-o', probe])
    const { stdout } = await execute(probe, [String(process.pid)])
    assert.match(stdout, /^\d+ [1-9]\d* /)
    report.probe = 'proc_pid_rusage RUSAGE_INFO_V2'
    const { stdout: timebase } = await execute(probe, ['--timebase'])
    const [numerator, denominator] = timebase.trim().split(' ').map(Number)
    report.machTimebase = { numerator, denominator }
  } catch (error) {
    probe = undefined
    report.probe = `Unavailable: ${error.message}`
  }
  if (options['window-close-only']) {
    const profile = join(scratch, 'profile')
    await mkdir(profile)
    const session = await launch(target, profile)
    try {
      report.lastWindowClose = await measureLastWindow(session)
    } finally {
      if (!report.lastWindowClose?.appExited) await close(session)
    }
    return
  }
  const project = await createProject(join(scratch, 'project'), { medium: true })
  for (let index = 0; index < protocol.launches; index += 1) {
    const profile = join(scratch, `profile-${index}`)
    await mkdir(profile)
    const fresh = await launch(target, profile)
    try {
      report.artifact.runtime = await fresh.app.evaluate(() => process.versions.electron + ' / ' + process.versions.chrome)
    } finally {
      await close(fresh)
    }
    await sleep(300)
    const freshResidue = (await snapshot(fresh)).members
    assert.deepEqual(freshResidue, [], 'App process family exited before warm restart')
    const warm = await launch(target, profile)
    let done = false
    try {
      report.launches.push({ freshMs: fresh.startupMs, warmMs: warm.startupMs })
      await record()
      if (index === protocol.launches - 1) {
        await workload(warm, project)
        report.lastWindowClose = await measureLastWindow(warm)
      }
      assert.deepEqual(warm.errors, [])
      assert.deepEqual([...fresh.requests, ...warm.requests], [], 'No renderer network requests observed')
      done = true
    } finally {
      if (!report.lastWindowClose?.appExited) {
        await close(warm).catch((error) => {
          if (done) throw error
          console.error(error.message)
        })
      }
    }
  }
  if (protocol.extendedRounds) report.extended = await measureExtended(scratch)
}

const metrics = {
  freshMs: () => median(report.launches.map(({ freshMs }) => freshMs)),
  warmMs: () => median(report.launches.map(({ warmMs }) => warmMs)),
  idleRssMiB: () => median(report.idle.samples.map(({ rssMiB }) => rssMiB)),
  idleFootprintMiB: () => mib(median(report.idle.samples.map(({ footprintBytes }) => footprintBytes))),
  idleCpuPercent: () => report.idle.cpuPercent,
  firstFileMs: () => report.firstFileMs,
  otherFileMs: () => median(report.nextFilesMs),
  typingMs: () => median(report.typingMs),
  runMs: () => median(report.runs.timings),
  peakNativeRssMiB: () => Math.max(0, ...report.runs.active.map(({ childRssMiB }) => childRssMiB)),
  peakNativeFootprintMiB: () => {
    const samples = report.runs.active.filter(({ childRssMiB }) => childRssMiB > 0)
      .map(({ childFootprintBytes }) => childFootprintBytes).filter(Number.isFinite)
    return samples.length ? mib(Math.max(...samples)) : null
  },
  ...Object.fromEntries(['oneCFile', 'tenTabs', 'mediumProject', 'learn', 'projects', 'practice', 'returnedToWelcome']
    .flatMap((key) => [[`${key}RssMiB`, () => report.stages[key].rssMiB],
      [`${key}FootprintMiB`, () => mib(report.stages[key].footprintBytes)]])),
}

async function summarize() {
  report.summary = { ...Object.fromEntries(Object.entries(metrics).map(([key, read]) => [key, read()])), ...panelTimings(report.panels) }
  if (report.extended) {
    const { firstLargeMs, largeOpen, warmup, rounds } = report.extended
    const first = rounds.slice(0, 3)
    const last = rounds.slice(-3)
    const settledMedian = (samples) => median(samples.map(({ settled }) => settled.rssMiB))
    const extendedCpuPercent = usageCpu(warmup, last.at(-1).settled)
    Object.assign(report.summary, {
      firstLargeMs,
      largeReopenMs: median(rounds.map(({ largeReopenMs }) => largeReopenMs)),
      largeFileRssMiB: largeOpen.rssMiB,
      largeFileFootprintMiB: mib(largeOpen.footprintBytes),
      rotatingTabSwitchMs: median(rounds.flatMap(({ rotationSwitchMs }) => rotationSwitchMs)),
      cachedTabSwitchMs: median(rounds.map(({ cachedSwitchMs }) => cachedSwitchMs)),
      extendedRunMs: median(rounds.map(({ runMs }) => runMs)),
      stopMs: median(rounds.map(({ stop }) => stop.ms)),
      extendedRssGrowthMiB: settledMedian(last) - settledMedian(first),
      extendedRssPeakMiB: Math.max(...rounds.flatMap(({ settled, stop }) => [settled.rssMiB, stop.active.rssMiB])),
      extendedCpuPercent,
      extendedSeconds: (last.at(-1).settled.timeMs - warmup.timeMs) / 1000,
      ...extendedResourceMetrics(report.extended, extendedCpuPercent),
    })
  }
  report.optionalCycleDeltas = Object.fromEntries(Object.entries(report.panels).map(([mode, { cycles }]) => {
    const first = cycles[0]?.closed
    const last = cycles.at(-1)?.closed
    return [mode, {
      rssMiB: first && last ? last.rssMiB - first.rssMiB : null,
      footprintMiB: Number.isFinite(first?.footprintBytes) && Number.isFinite(last?.footprintBytes)
        ? mib(last.footprintBytes - first.footprintBytes) : null,
    }]
  }))
  const budgets = { idle: 300, oneCFile: 400, mediumProject: 600 }
  report.targets = Object.entries(budgets).flatMap(([stage, targetMB]) => ['Rss', 'Footprint'].map((metric) => {
    const measuredMiB = report.summary[`${stage}${metric}MiB`]
    const measuredMB = measuredMiB === null ? null : measuredMiB * 1024 ** 2 / 1e6
    return { stage, metric, targetMB, measuredMB, pass: measuredMB === null ? null : measuredMB < targetMB }
  }))
  const base = options['compare-report'] ? JSON.parse(await readFile(options['compare-report'], 'utf8')) : null
  if (base) {
    assert.equal(base.schemaVersion, report.schemaVersion, 'Comparison schema must match.')
    assert.deepEqual(base.protocol, report.protocol, 'Comparison workload must match.')
    const baselineMetrics = { ...base.summary, ...panelTimings(base.panels) }
    const regressions = [
      ['freshMs', 0.15, 30], ['warmMs', 0.15, 30], ['firstFileMs', 0.20, 35], ['otherFileMs', 0.20, 15],
      ['typingMs', 0.20, 5], ['runMs', 0.20, 35], ['idleCpuPercent', 0, 0.5],
      ...Object.keys(panelInfo).flatMap((mode) => [[`${mode}FirstMs`, 0.20, 75], [`${mode}ReopenMs`, 0.20, 35]]),
      ...['idle', 'oneCFile', 'mediumProject', 'learn', 'projects', 'practice', 'returnedToWelcome'].flatMap((stage) =>
        ['Footprint', 'Rss'].map((metric) => [`${stage}${metric}MiB`, 0.10, 20])),
    ]
    report.comparison = regressions.map(([metric, fraction, absolute]) => {
      const before = baselineMetrics[metric]
      const after = report.summary[metric]
      const allowance = Number.isFinite(before) ? Math.max(before * fraction, absolute) : null
      return { metric, before, after, allowance, regression: Number.isFinite(before) && Number.isFinite(after) ? after - before > allowance : null }
    })
  }
  await record()
  console.table(report.summary)
  console.table(report.targets)
  if (report.comparison) console.table(report.comparison)
  if (options['strict-targets'] && (report.targets.some(({ pass }) => pass !== true)
    || report.comparison?.some(({ regression }) => regression))) process.exitCode = 1
}

try {
  await withScratch('resources', measure)
  if (options['window-close-only']) {
    await record()
    console.log(report.lastWindowClose)
  } else {
    await summarize()
  }
} catch (error) {
  report.error = error.stack
  await record()
  throw error
} finally {
  console.log(`Raw samples: ${output}`)
}
