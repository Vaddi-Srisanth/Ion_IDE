import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { arch, cpus, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { median } from './benchmark-resource-metrics.mjs'
import { artifact, close, eventually, launch, resourceSnapshot, sleep, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  baseline: { type: 'string' },
  target: { type: 'string', default: 'dist' },
  trials: { type: 'string', default: '3' },
  cleanup: { type: 'boolean' },
  out: { type: 'string', default: 'performance-results/master-onboarding/onboarding.json' },
} })
assert.equal(process.platform, 'darwin', 'This benchmark uses native macOS process accounting.')
assert.ok(values.baseline, 'Pass the preserved pre-onboarding production dist with --baseline.')
const trials = Number(values.trials)
assert.ok(Number.isInteger(trials) && trials > 0 && trials <= 10, 'Run 1–10 trials per build.')
const builds = await Promise.all([values.baseline, values.target].map(artifact))
assert.ok(builds.every(({ path }) => !path.endsWith('.app')), 'Use production dist directories.')
const execute = promisify(execFile)
const system = async (command, ...args) => (await execute(command, args)).stdout.trim()
const MiB = 1024 ** 2
const observationMs = 1600
const settleMs = 1200
const introAsset = /(?:^|\/)(?:CinematicIntro|Onboarding)-[^/]+\.(?:css|js)$/
const intro = (page) => page.getByTestId('onboarding-intro')

async function payload(target) {
  const files = (await readdir(target.path, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
  const sizes = await Promise.all(files.map(async (entry) => ({
    name: entry.name, bytes: (await stat(join(entry.parentPath, entry.name))).size,
  })))
  const hash = async (relative) => createHash('sha256')
    .update(await readFile(join(target.path, relative))).digest('hex')
  return {
    path: target.path,
    mainSha256: await hash('main/index.cjs'),
    rendererHtmlSha256: await hash('renderer/index.html'),
    distBytes: sizes.reduce((sum, file) => sum + file.bytes, 0),
    onboardingAssets: sizes.filter(({ name }) => introAsset.test(name)).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

async function snapshot(session, probe, cdp) {
  const began = performance.now()
  const { members, rssMiB } = await resourceSnapshot(session, { details: true })
  assert.ok(members.some(({ kind }) => kind === 'main') && members.some(({ kind }) => kind === 'renderer'))
  assert.ok(members.every(({ kind }) => kind !== 'child'), 'Onboarding should start no native child tasks.')
  const { stdout } = await execute(probe, members.map(({ pid }) => String(pid)))
  const byPid = new Map(stdout.trim().split('\n').filter(Boolean).map((row) => {
    const [pid, footprintBytes, cpuNs] = row.split(' ').map(Number)
    return [pid, { footprintBytes, cpuNs }]
  }))
  const processes = members.map((member) => {
    assert.ok(byPid.has(member.pid), 'Process tree must be stable during native sampling.')
    return { ...member, ...byPid.get(member.pid) }
  })
  const timeMs = (began + performance.now()) / 2
  const { usedSize, totalSize } = await cdp.send('Runtime.getHeapUsage')
  const gpu = processes.find(({ kind }) => kind === 'gpu-process')
  return {
    timeMs, rssMiB, processes,
    footprintMiB: processes.reduce((sum, { footprintBytes }) => sum + footprintBytes, 0) / MiB,
    gpuHelperFootprintMiB: gpu ? gpu.footprintBytes / MiB : null,
    rendererHeapUsedMiB: usedSize / MiB,
    rendererHeapAllocatedMiB: totalSize / MiB,
  }
}

function cpu(first, last, kind) {
  const before = new Map(first.processes.map(({ pid, cpuNs }) => [pid, cpuNs]))
  const processes = last.processes.filter((process) => !kind || process.kind === kind)
  assert.deepEqual(last.processes.map(({ pid }) => pid).sort(), [...before.keys()].sort(), 'Stable sampled process tree.')
  if (!processes.length) return null
  const delta = processes.reduce((sum, { pid, cpuNs }) => sum + Math.max(0, cpuNs - before.get(pid)), 0)
  return delta / (last.timeMs - first.timeMs) / 10_000
}

function summarize(samples) {
  const first = samples[0]
  const last = samples.at(-1)
  return {
    rssMiB: median(samples.map((item) => item.rssMiB)),
    peakSampledRssMiB: Math.max(...samples.map((item) => item.rssMiB)),
    footprintMiB: median(samples.map((item) => item.footprintMiB)),
    gpuHelperFootprintMiB: median(samples.map((item) => item.gpuHelperFootprintMiB)),
    rendererHeapUsedMiB: median(samples.map((item) => item.rendererHeapUsedMiB)),
    processCount: last.processes.length,
    cpuPercentOneCore: cpu(first, last),
    gpuHelperCpuPercentOneCore: cpu(first, last, 'gpu-process'),
  }
}

async function sampleWindow(session, probe, cdp, intervals, duringIntro = false) {
  const samples = []
  for (let index = 0; index <= intervals; index++) {
    if (index) await sleep(observationMs)
    if (duringIntro && !(await intro(session.page).isVisible())) break
    samples.push(await snapshot(session, probe, cdp))
  }
  assert.ok(samples.length >= 2, 'Expected at least two resource samples in the observed state.')
  return { ...summarize(samples), samples }
}

function monitorFrames(page) {
  return page.evaluateHandle(() => {
    let visual = document.querySelector('[data-testid="onboarding-intro"]')
    const frameIntervalsMs = []
    let previous
    let frame
    function sample(now) {
      if (!visual?.isConnected || frameIntervalsMs.length >= 750) return
      if (previous !== undefined) frameIntervalsMs.push(now - previous)
      previous = now
      frame = requestAnimationFrame(sample)
    }
    frame = requestAnimationFrame(sample)
    return { stop: () => {
      cancelAnimationFrame(frame)
      visual = null
      return frameIntervalsMs
    } }
  })
}

const introResources = (page) => page.evaluate((pattern) => {
  const matcher = new RegExp(pattern)
  // Resource Timing can omit loads for the app:// protocol. Include Vite's
  // dynamic preload links so the first-run trial provides a positive control.
  const urls = [
    ...performance.getEntriesByType('resource').map(({ name }) => name),
    ...[...document.querySelectorAll('link[href]')].map(({ href }) => href),
  ]
  return [...new Set(urls.map((url) => new URL(url).pathname).filter((path) => matcher.test(path)))]
}, introAsset.source)

async function quit(session) {
  await close(session)
  await eventually(async () => (await resourceSnapshot(session)).processes.length === 0,
    'Ion left processes behind after quitting.')
}

function offline(session) {
  assert.deepEqual(session.requests, [], 'The app must work offline.')
  assert.deepEqual(session.errors, [], 'The renderer reported an unexpected error.')
}

async function sampleTrial(target, profile, probe, candidate) {
  const legacy = await launch(target, profile + '-existing')
  const result = { seededWelcomeMs: legacy.startupMs }
  try {
    await legacy.page.context().setOffline(true)
    await sleep(settleMs)
    assert.equal(await legacy.page.getByTestId('onboarding').count(), 0)
    assert.deepEqual(await introResources(legacy.page), [])
    const learnStarted = performance.now()
    await legacy.page.getByTestId('workspace-learn').click()
    await legacy.page.getByTestId('learning-pane').waitFor()
    result.seededLearnOpenMs = performance.now() - learnStarted
    offline(legacy)
  } finally {
    await quit(legacy)
  }

  const started = performance.now()
  const fresh = await launch(target, profile, { firstRun: true })
  const { page } = fresh
  result.welcomeMountedMs = fresh.startupMs
  try {
    await page.context().setOffline(true)
    if (candidate) {
      await intro(page).waitFor()
      const visible = performance.now()
      result.introVisibleMs = visible - started
      const cdp = await page.context().newCDPSession(page)
      try {
        const frames = await monitorFrames(page)
        try {
          result.firstRun = await sampleWindow(fresh, probe, cdp, 4, true)
          await intro(page).waitFor({ state: 'detached', timeout: 12_000 })
          result.introObservedMs = performance.now() - visible
          result.frameIntervalsMs = await frames.evaluate((monitor) => monitor.stop())
          assert.ok(result.frameIntervalsMs.length > 10, 'Expected a foreground animation callback sample.')
        } finally {
          await frames.evaluate((monitor) => monitor.stop()).catch(() => {})
          await frames.dispose()
        }
        const skip = page.getByTestId('onboarding-skip-setup')
        await skip.waitFor()
        result.setupReadyMs = performance.now() - started
        await skip.click()
        await page.getByTestId('onboarding').waitFor({ state: 'detached' })
        result.introResources = await introResources(page)
        assert.ok(result.introResources.some((path) => /\/CinematicIntro-/.test(path)), 'Actual intro assets should load.')
        await sleep(settleMs)
        result.afterDismissal = await sampleWindow(fresh, probe, cdp, 2)
      } finally {
        await cdp.detach()
      }
    } else {
      const cdp = await page.context().newCDPSession(page)
      try {
        result.firstRun = await sampleWindow(fresh, probe, cdp, 4)
        await sleep(settleMs + 1250)
        result.afterDismissal = await sampleWindow(fresh, probe, cdp, 2)
      } finally {
        await cdp.detach()
      }
    }
    offline(fresh)
  } finally {
    await quit(fresh)
  }

  const warm = await launch(target, profile)
  try {
    await warm.page.context().setOffline(true)
    const cdp = await warm.page.context().newCDPSession(warm.page)
    try {
      await sleep(settleMs)
      result.warmWelcomeMs = warm.startupMs
      result.warmWelcome = await sampleWindow(warm, probe, cdp, 2)
      assert.equal(await warm.page.getByTestId('onboarding').count(), 0, 'A used profile should launch directly.')
      assert.deepEqual(await introResources(warm.page), [], 'Ordinary launches must not load cinematic assets.')
    } finally {
      await cdp.detach()
    }
    offline(warm)
  } finally {
    await quit(warm)
  }
  return result
}

function summarizeBuild(samples) {
  const result = {}
  for (const key of ['seededWelcomeMs', 'seededLearnOpenMs', 'welcomeMountedMs', 'warmWelcomeMs', 'introVisibleMs', 'introObservedMs', 'setupReadyMs']) {
    if (samples.some((sample) => key in sample)) result[key] = median(samples.map((sample) => sample[key]))
  }
  for (const key of ['firstRun', 'afterDismissal', 'warmWelcome']) {
    result[key] = Object.fromEntries(Object.keys(samples[0][key]).filter((metric) => metric !== 'samples')
      .map((metric) => [metric, median(samples.map((sample) => sample[key][metric]))]))
  }
  const intervals = samples.flatMap((sample) => sample.frameIntervalsMs ?? []).sort((a, b) => a - b)
  if (intervals.length) result.frames = {
    callbacks: intervals.length, medianIntervalMs: median(intervals),
    p95IntervalMs: intervals[Math.ceil(intervals.length * 0.95) - 1],
  }
  return result
}

function trackIntroCallbacks(page) {
  return page.evaluateHandle(() => {
    const { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame, setTimeout, clearTimeout } = window
    const origins = new WeakMap()
    const frames = new Set()
    const timeouts = new Set()
    let scheduledFrames = 0
    let scheduledTimeouts = 0
    window.requestAnimationFrame = (callback) => {
      if (!origins.has(callback)) origins.set(callback, /\/CinematicIntro-[^/]+\.js:/.test(new Error().stack))
      if (!origins.get(callback)) return requestFrame.call(window, callback)
      const id = requestFrame.call(window, (time) => {
        frames.delete(id)
        callback(time)
      })
      frames.add(id)
      scheduledFrames++
      return id
    }
    window.cancelAnimationFrame = (id) => {
      frames.delete(id)
      cancelFrame.call(window, id)
    }
    window.setTimeout = (callback, delay, ...args) => {
      // The 2.5 s loading deadline belongs to the onboarding wrapper.
      if (delay !== 2500 || typeof callback !== 'function' || !document.querySelector('[data-testid="onboarding"]')) {
        return setTimeout.call(window, callback, delay, ...args)
      }
      const id = setTimeout.call(window, () => {
        timeouts.delete(id)
        callback(...args)
      }, delay)
      timeouts.add(id)
      scheduledTimeouts++
      return id
    }
    window.clearTimeout = (id) => {
      timeouts.delete(id)
      clearTimeout.call(window, id)
    }
    return {
      read: () => ({ pendingFrames: frames.size, pendingTimeouts: timeouts.size, scheduledFrames, scheduledTimeouts }),
      restore: () => Object.assign(window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame, setTimeout, clearTimeout }),
    }
  })
}

async function cleanupTrial(target, profile, probe) {
  const session = await launch(target, profile)
  const { page } = session
  try {
    await page.context().setOffline(true)
    const cdp = await page.context().newCDPSession(page)
    const callbacks = await trackIntroCallbacks(page)
    const readCallbacks = () => callbacks.evaluate((tracker) => tracker.read())
    async function replay() {
      await page.getByTestId('settings').click()
      await page.getByTestId('onboarding-replay').click()
      await intro(page).waitFor()
      await eventually(async () => (await readCallbacks()).pendingFrames > 0, 'Intro frame callbacks were not observed.')
      return intro(page).locator('canvas').elementHandle()
    }
    async function skip(canvas) {
      try {
        await page.getByTestId('onboarding-skip-intro').click()
        await page.getByTestId('onboarding').waitFor({ state: 'detached' })
        await eventually(() => canvas.evaluate((node) => !node.isConnected && !node.width && !node.height),
          'The intro canvas backing store survived dismissal.')
      } finally {
        await canvas.dispose()
      }
      const state = await readCallbacks()
      assert.equal(state.pendingFrames, 0, 'A frame callback survived dismissal.')
      assert.equal(state.pendingTimeouts, 0, 'A loading timeout survived dismissal.')
      return state
    }
    try {
      const result = { settleAfterSkipMs: 18_000, repeatedSkips: [] }
      await sleep(settleMs)
      result.beforeReplay = await sampleWindow(session, probe, cdp, 2)
      const canvas = await replay()
      result.playing = await sampleWindow(session, probe, cdp, 2, true)
      result.firstSkip = await skip(canvas)
      assert.ok(result.firstSkip.scheduledTimeouts > 0, 'The intro loading deadline was not observed.')
      await sleep(result.settleAfterSkipMs)
      result.afterReplay = await sampleWindow(session, probe, cdp, 2)
      for (let index = 0; index < 5; index++) result.repeatedSkips.push(await skip(await replay()))
      await sleep(result.settleAfterSkipMs)
      result.afterRepeatedReplays = await sampleWindow(session, probe, cdp, 2)
      assert.deepEqual(await readCallbacks(), result.repeatedSkips.at(-1), 'Dismissed intro scheduled more callbacks.')
      offline(session)
      return result
    } finally {
      await callbacks.evaluate((tracker) => { tracker.restore() }).catch(() => {})
      await callbacks.dispose()
      await cdp.detach()
    }
  } finally {
    await quit(session)
  }
}

const [baseline, candidate] = await Promise.all(builds.map(payload))
assert.deepEqual(baseline.onboardingAssets, [], 'The preserved baseline should predate the cinematic.')
assert.ok(candidate.onboardingAssets.some(({ name }) => name.startsWith('CinematicIntro-')), 'Expected lazy production assets.')
const output = resolve(values.out)
const report = {
  schemaVersion: 1, timestamp: new Date().toISOString(), trials, baseline, candidate,
  host: {
    macOS: await system('/usr/bin/sw_vers'), arch: arch(), processor: cpus()[0]?.model, ramBytes: totalmem(),
    power: (await system('/usr/bin/pmset', '-g', 'batt')).split('\n')[0],
    thermal: await system('/usr/bin/pmset', '-g', 'therm'), node: process.version,
    electron: JSON.parse(await readFile('node_modules/electron/package.json', 'utf8')).version,
  },
  method: {
    launch: 'Interleaved production dist builds with disposable profiles and intact OS caches. Startup ends at the Welcome DOM marker, intro visibility or the setup marker as labeled.',
    seeded: 'First launch of a separate disposable profile with ordinary settings already present. Learn click to pane visible after a 1.2 s settle.',
    firstRun: 'Baseline idle Welcome versus candidate playing the intro. Up to five tree samples spaced by 1.6 s sleeps plus sampling overhead. Sampling stops when playback ends.',
    afterDismissal: 'Three samples after a 1.2 s settle after dismissal or a comparable baseline Welcome delay.',
    warmWelcome: 'Launch the same profile again after a clean exit. Three samples after a 1.2 s settle.',
    memory: 'Sum of whole-process RSS (which may count shared pages multiple times), and separate macOS phys_footprint charges. V8 heap measured by CDP without forced GC.',
    cpu: 'Kernel CPU time delta as a percent of one logical core. GPU helper CPU and footprint are process metrics. GPU hardware utilization is not measured.',
    frames: 'Foreground renderer requestAnimationFrame callback intervals during playback. This instrumentation adds one callback per frame and does not measure display presentation or GPU frame rate.',
    payload: 'Logical byte count of production dist files, before Electron packaging or compression.',
  },
  samples: { baseline: [], candidate: [] },
}
await mkdir(dirname(output), { recursive: true })
await withScratch('onboarding-benchmark', async (scratch) => {
  const probe = join(scratch, 'resource-probe')
  await execute('/usr/bin/xcrun', ['clang', '-O2', '-std=c11', 'scripts/benchmark-resources-probe.c', '-o', probe])
  for (let trial = 1; trial <= trials; trial++) {
    for (const index of trial % 2 ? [0, 1] : [1, 0]) {
      const label = index ? 'candidate' : 'baseline'
      report.samples[label].push(await sampleTrial(builds[index], join(scratch, `${label}-${trial}`), probe, index === 1))
      await writeFile(output, JSON.stringify(report, null, 2) + '\n')
      console.log('Recorded', label, trial)
    }
  }
  if (values.cleanup) {
    report.cleanup = await cleanupTrial(builds[1], join(scratch, 'cleanup'), probe)
    console.log('Recorded same-process replay and cleanup.')
  }
})
report.medians = Object.fromEntries(Object.entries(report.samples).map(([label, samples]) => [label, summarizeBuild(samples)]))
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report.medians, null, 2))
console.log(output)
