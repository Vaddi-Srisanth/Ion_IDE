import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, atPath, close, cpuPercent, createProject, editorShows, launch, openFolder,
  openFromExplorer, resourceSnapshot, runProgram, sleep, stubDialogs, waitForFile, withScratch,
} from './desktop-harness.mjs'

const { values: options } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  compare: { type: 'string' },
  'target-installer': { type: 'string' },
  'compare-installer': { type: 'string' },
  trials: { type: 'string', default: '5' },
  scenarios: { type: 'string', default: '3' },
  'idle-seconds': { type: 'string', default: '8' },
  executions: { type: 'string', default: '12' },
  'open-files': { type: 'string', default: '10' },
  'tab-cycles': { type: 'string', default: '1' },
  'renderer-profile': { type: 'boolean' },
  out: { type: 'string', default: 'performance-results' },
  help: { type: 'boolean' },
} })

if (options.help) {
  console.log('npm run bench:desktop -- [--target dist] [--compare dist-baseline] [--trials 5] [--scenarios 3] [--idle-seconds 8] [--executions 12] [--open-files 10] [--tab-cycles 1] [--renderer-profile] [--out performance-results]')
  process.exit(0)
}
assert.equal(process.platform, 'darwin', 'This benchmark uses macOS process accounting.')
const positiveInteger = (key) => {
  const value = Number(options[key])
  assert.ok(Number.isInteger(value) && value > 0 && value < 301, `--${key} must be an integer from 1 through 300.`)
  return value
}
const trials = positiveInteger('trials')
const scenarios = positiveInteger('scenarios')
const idleSeconds = positiveInteger('idle-seconds')
const executions = positiveInteger('executions')
const tabCycles = positiveInteger('tab-cycles')
const openFiles = positiveInteger('open-files')
assert.ok(openFiles >= 10 && openFiles <= 64, '--open-files must be between 10 and 64.')
assert.ok(scenarios <= trials, '--scenarios cannot exceed --trials.')

const out = resolve(options.out)
await mkdir(out, { recursive: true })
const generatedAt = new Date().toISOString()
const evidencePath = join(out, `desktop-${generatedAt.replaceAll(':', '-')}.json`)
const candidates = [
  ...(options.compare ? [{ label: 'comparison', target: options.compare, installer: options['compare-installer'] }] : []),
  { label: 'production', target: options.target, installer: options['target-installer'] },
]
const execute = (path, ...args) => execFileSync(path, args, { encoding: 'utf8' }).trim()
const report = {
  generatedAt,
  host: {
    macOS: execute('/usr/bin/sw_vers'),
    processor: execute('/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'),
    ramBytes: Number(execute('/usr/sbin/sysctl', '-n', 'hw.memsize')),
    architecture: process.arch,
    node: process.version,
    power: execute('/usr/bin/pmset', '-g', 'batt').split('\n')[0],
    thermal: execute('/usr/bin/pmset', '-g', 'therm'),
  },
  protocol: {
    trials, scenarios, idleSeconds, executions, tabCycles, openFiles, idleSettleSeconds: 3,
    rendererProfilingEnabled: Boolean(options['renderer-profile']),
    startup: 'Process launch under Playwright to visible Welcome in DOM. New disposable profile, then same-profile relaunch. OS caches untouched.',
    ram: 'Summed RSS from macOS ps, including app descendants and profile-marked helpers. Shared pages may be counted in multiple processes.',
    cpu: 'Process CPU-time deltas; 100% = one logical CPU. Subprocesses that exit between samples can be missed.',
    typing: 'Chromium keydown to second requestAnimationFrame, 30 verified characters per scenario. Presentation/compositor latency is not measured.',
    fixtures: `${openFiles} text files of 650 lines each, four C programs, and 40 subfolders with 25 files each. Six expanded on demand. Each subsequent tab cycle opens and closes three files.`,
  },
  artifacts: {},
  samples: {},
}
const round = (value) => Math.round(value * 100) / 100
const describe = (values) => {
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return { n: values.length, median: round(median), min: round(sorted[0]), max: round(sorted.at(-1)) }
}

async function sumBytes(path) {
  const file = await lstat(path)
  if (!file.isDirectory()) return file.isFile() ? file.size : 0
  const sizes = await Promise.all((await readdir(path)).map((name) => sumBytes(join(path, name))))
  return sizes.reduce((total, size) => total + size, 0)
}

for (const candidate of candidates) {
  candidate.build = await artifact(candidate.target)
  const isBundle = candidate.build.path.endsWith('.app')
  const fingerprintPath = isBundle
    ? join(candidate.build.path, 'Contents/Resources/app.asar')
    : join(candidate.build.path, 'renderer', 'index.html')
  const fingerprint = await readFile(fingerprintPath).catch(() => null)
  report.artifacts[candidate.label] = {
    path: candidate.target,
    logicalBytes: await sumBytes(candidate.build.path),
    includesElectron: isBundle,
    fingerprint: fingerprint && { file: basename(fingerprintPath), sha256: createHash('sha256').update(fingerprint).digest('hex') },
    installerBytes: candidate.installer ? (await lstat(candidate.installer)).size : null,
  }
  report.samples[candidate.label] = []
}

async function measureIdle(session) {
  await sleep(3000)
  const samples = [await resourceSnapshot(session)]
  for (let second = 0; second < idleSeconds; second += 1) {
    await sleep(1000)
    samples.push(await resourceSnapshot(session))
  }
  return {
    rssMiB: describe(samples.map((sample) => sample.rssMiB)),
    cpuPercent: round(cpuPercent(samples[0], samples.at(-1))),
    endRssMiB: samples.at(-1).ideRssMiB,
    durationMs: round(samples.at(-1).timeMs - samples[0].timeMs),
    samples,
  }
}

async function measureTyping(session, path) {
  const { page } = session
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 380, y: 7 } })
  await page.evaluate(() => {
    window.ionBenchmarkFrames = []
    const listener = (event) => {
      if (event.key !== 'x') return
      const start = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => window.ionBenchmarkFrames.push(performance.now() - start)))
    }
    document.addEventListener('keydown', listener, { capture: true })
    window.ionBenchmarkCleanup = () => document.removeEventListener('keydown', listener, { capture: true })
  })
  const before = await resourceSnapshot(session)
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press('x')
    await page.waitForFunction((count) => window.ionBenchmarkFrames.length >= count, index + 1)
  }
  const after = await resourceSnapshot(session)
  const inputMs = await page.evaluate(() => {
    window.ionBenchmarkCleanup()
    const frames = window.ionBenchmarkFrames
    delete window.ionBenchmarkFrames
    delete window.ionBenchmarkCleanup
    return frames
  })
  await editorShows(page, 'x'.repeat(30))
  await waitForFile(readFile, path, 'x'.repeat(30))
  return { inputMs, cpuPercent: cpuPercent(before, after), rssMiB: Math.max(before.rssMiB, after.rssMiB) }
}

async function closeFixtureTabs(page, files) {
  for (const file of files.toReversed()) await atPath(page, 'close-tab', file).click()
  await page.getByTestId('tab').first().waitFor({ state: 'detached' })
}

async function measureTabCycles(session, files) {
  const { page } = session
  const devtools = await page.context().newCDPSession(page)
  const takeSample = async () => {
    const resources = await resourceSnapshot(session)
    const heap = await devtools.send('Runtime.getHeapUsage')
    return { timeMs: resources.timeMs, rssMiB: resources.rssMiB, rendererHeapMiB: heap.usedSize / 1024 ** 2 }
  }
  try {
    const samples = [await takeSample()]
    for (let cycle = 1; cycle < tabCycles; cycle += 1) {
      for (const file of files) await openFromExplorer(page, file, `Ion fixture ${basename(file)}`)
      await closeFixtureTabs(page, files)
      await sleep(1250)
      samples.push(await takeSample())
    }
    await devtools.send('HeapProfiler.collectGarbage')
    const afterForcedGarbageCollection = await takeSample()
    return { samples, afterForcedGarbageCollection }
  } finally {
    await devtools.detach()
  }
}

async function scenario(session, project, profilePath) {
  const { app, page } = session
  await stubDialogs(app, { folder: project.directory, allowRun: true })
  const idle = await measureIdle(session)
  const profiler = profilePath ? await page.context().newCDPSession(page) : null
  if (profiler) {
    await profiler.send('Profiler.enable')
    await profiler.send('Profiler.start')
  }
  const folderStart = performance.now()
  await openFolder(page, project)
  const folderOpenMs = performance.now() - folderStart
  const fileOpenMs = []
  const memory = {}
  for (const [index, file] of project.files.entries()) {
    fileOpenMs.push(await openFromExplorer(page, file, `Ion fixture ${basename(file)}`))
    if (index === 0 || index === 9 || index === 29) {
      await sleep(1250)
      const key = index === 0 ? 'oneTabMiB' : index === 9 ? 'tenTabsMiB' : 'thirtyTabsMiB'
      memory[key] = (await resourceSnapshot(session)).ideRssMiB
    }
  }
  const typing = await measureTyping(session, project.files.at(-1))

  const mediumExpandStart = performance.now()
  for (const directory of project.directories.slice(0, 6)) {
    await atPath(page, 'explorer-entry', directory).click()
    await atPath(page, 'explorer-entry', join(directory, 'source-00.txt')).waitFor()
  }
  const mediumExpandMs = performance.now() - mediumExpandStart
  await sleep(1250)
  memory.mediumTreeMiB = (await resourceSnapshot(session)).rssMiB

  await closeFixtureTabs(page, project.files)
  await sleep(1500)
  memory.closedTabsMiB = (await resourceSnapshot(session)).rssMiB
  const repeatedTabs = tabCycles > 1 ? await measureTabCycles(session, project.files.slice(0, 3)) : undefined
  await openFromExplorer(page, project.program, '#include')
  await runProgram(page)
  await runProgram(page)
  await sleep(1000)
  const beforeRuns = await resourceSnapshot(session)
  const repeatRunMs = []
  const repeatedRunSamples = []
  for (let index = 0; index < executions; index += 1) {
    repeatRunMs.push(await runProgram(page))
    if ((index + 1) % 3 === 0) repeatedRunSamples.push(await resourceSnapshot(session))
  }
  await sleep(1500)
  const afterRuns = await resourceSnapshot(session)
  await openFromExplorer(page, project.sampled, '#define')
  let sampling = true
  const runResources = []
  const sampler = (async () => {
    while (sampling) {
      runResources.push(await resourceSnapshot(session))
      await sleep(35)
    }
  })()
  try {
    await runProgram(page)
  } finally {
    sampling = false
    await sampler
  }
  const duration = await page.getByTestId('run-console-duration').or(page.locator('.console-time')).textContent()
  const runnerDurationMs = Number(duration?.match(/(\d+)\s*ms\b/)?.[1])
  assert.ok(Number.isFinite(runnerDurationMs), 'The sampled run displays its duration')
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop')
    await profiler.detach()
    await writeFile(profilePath, JSON.stringify(profile) + '\n')
  }
  return {
    idle, folderOpenMs, fileOpenMs, typing, mediumExpandMs, memory, repeatRunMs, repeatedTabs, runResources, runnerDurationMs,
    repeatExecution: { beforeRuns, afterRuns, samples: repeatedRunSamples },
  }
}

async function record() {
  await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n')
}

await record()
try {
  for (let trial = 0; trial < trials; trial += 1) {
    const order = trial % 2 ? candidates.toReversed() : candidates
    for (const candidate of order) {
      await withScratch('bench', async (scratch) => {
        const profile = join(scratch, 'profile')
        const project = trial < scenarios ? await createProject(join(scratch, 'project'), { medium: true, fileCount: openFiles }) : null
        await mkdir(profile)
        const fresh = await launch(candidate.build, profile)
        const sample = { trial: trial + 1, freshStartupMs: fresh.startupMs }
        try {
          const versions = await fresh.app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }))
          Object.assign(report.artifacts[candidate.label], versions)
        } finally {
          await close(fresh)
        }
        await sleep(300)
        sample.remainingFreshProcesses = (await resourceSnapshot(fresh)).processes
        if (sample.remainingFreshProcesses.length) {
          console.warn(`${candidate.label} retained helpers after quit: ${sample.remainingFreshProcesses.join(', ')}`)
        }
        const warm = await launch(candidate.build, profile)
        let completed = false
        try {
          sample.warmStartupMs = warm.startupMs
          if (project) {
            const profilePath = options['renderer-profile']
              ? join(out, `${candidate.label}-${trial + 1}-${generatedAt.replaceAll(':', '-')}.cpuprofile`)
              : null
            Object.assign(sample, await scenario(warm, project, profilePath))
          }
          assert.deepEqual(warm.errors, [], 'No uncaught renderer errors')
          assert.deepEqual([...fresh.requests, ...warm.requests], [], 'No observed remote renderer requests')
          completed = true
        } finally {
          await close(warm).catch((error) => {
            if (completed) throw error
            console.error(error.message)
          })
        }
        report.samples[candidate.label].push(sample)
        await record()
        console.log(`${candidate.label} ${trial + 1}/${trials}  fresh ${round(sample.freshStartupMs)} ms  warm ${round(sample.warmStartupMs)} ms${project ? '  scenarios verified' : ''}`)
      })
    }
  }
} catch (error) {
  report.error = error.stack
  await record()
  throw error
} finally {
  console.log(`Raw samples: ${evidencePath}`)
}

const summarise = (samples) => {
  const active = samples.filter((sample) => sample.idle)
  const metrics = {
    freshStartupMs: samples.map((sample) => sample.freshStartupMs),
    warmStartupMs: samples.map((sample) => sample.warmStartupMs),
    idleRssMiB: active.map((sample) => sample.idle.rssMiB.median),
    idleEndRssMiB: active.map((sample) => sample.idle.endRssMiB),
    idleCpuPercent: active.map((sample) => sample.idle.cpuPercent),
    oneTabMiB: active.map((sample) => sample.memory.oneTabMiB),
    tenTabsMiB: active.map((sample) => sample.memory.tenTabsMiB),
    thirtyTabsMiB: active.flatMap((sample) => sample.memory.thirtyTabsMiB ?? []),
    mediumTreeMiB: active.map((sample) => sample.memory.mediumTreeMiB),
    closedTabsMiB: active.map((sample) => sample.memory.closedTabsMiB),
    folderOpenMs: active.map((sample) => sample.folderOpenMs),
    firstFileOpenMs: active.map((sample) => sample.fileOpenMs[0]),
    nextFileOpenMs: active.flatMap((sample) => sample.fileOpenMs.slice(1)),
    mediumExpandMs: active.map((sample) => sample.mediumExpandMs),
    typingKeyToSecondFrameMs: active.flatMap((sample) => sample.typing.inputMs),
    typingCpuPercent: active.map((sample) => sample.typing.cpuPercent),
    tabCycleRssDeltaMiB: active.flatMap(({ repeatedTabs }) => repeatedTabs
      ? [repeatedTabs.samples.at(-1).rssMiB - repeatedTabs.samples[0].rssMiB] : []),
    tabCyclePostGcHeapMiB: active.flatMap(({ repeatedTabs }) => repeatedTabs?.afterForcedGarbageCollection.rendererHeapMiB ?? []),
    activeIdePeakMiB: active.map((sample) => Math.max(...sample.runResources.map((row) => row.ideRssMiB))),
    activeChildPeakMiB: active.map((sample) => Math.max(...sample.runResources.map((row) => row.childRssMiB))),
    runMs: active.flatMap((sample) => sample.repeatRunMs),
    runRssBeforeMiB: active.map((sample) => sample.repeatExecution.beforeRuns.rssMiB),
    runRssAfterMiB: active.map((sample) => sample.repeatExecution.afterRuns.rssMiB),
    runRssPeakSampleMiB: active.map((sample) => Math.max(sample.repeatExecution.beforeRuns.rssMiB,
      sample.repeatExecution.afterRuns.rssMiB, ...sample.repeatExecution.samples.map((snapshot) => snapshot.rssMiB))),
    runRssDeltaMiB: active.map((sample) => sample.repeatExecution.afterRuns.rssMiB - sample.repeatExecution.beforeRuns.rssMiB),
  }
  return Object.fromEntries(Object.entries(metrics).filter(([, values]) => values.length).map(([key, values]) => [key, describe(values)]))
}
report.summary = Object.fromEntries(Object.entries(report.samples).map(([key, samples]) => [key, summarise(samples)]))
await record()
for (const [label, summary] of Object.entries(report.summary)) {
  console.log(label)
  console.table(summary)
}
