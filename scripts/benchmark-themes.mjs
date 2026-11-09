import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { artifact, editorShows, resourceSnapshot, withScratch } from './desktop-harness.mjs'

const { values: options } = parseArgs({ options: {
  target: { type: 'string' },
  baseline: { type: 'string' },
  runs: { type: 'string', default: '3' },
  sizes: { type: 'string', default: '5,20,100' },
  switches: { type: 'string', default: '100' },
  checkpoint: { type: 'string', default: '20' },
  out: { type: 'string', default: 'performance-results' },
  help: { type: 'boolean' },
} })
if (options.help) {
  console.log('npm run bench:themes -- [--target packaged.app] [--baseline legacy.app] [--runs 3] [--sizes 5,20,100] [--switches 100] [--checkpoint 20] [--out performance-results]')
  process.exit(0)
}
assert.equal(process.platform, 'darwin', 'Theme benchmark uses the packaged macOS app and macOS process accounting.')
function positiveInteger(option, limit) {
  const value = Number(options[option])
  assert.ok(Number.isInteger(value) && value >= 1 && value <= limit, `--${option} must be an integer from 1 to ${limit}.`)
  return value
}
const repetitions = positiveInteger('runs', 10)
const switches = positiveInteger('switches', 10_000)
const checkpointInterval = Math.min(switches, positiveInteger('checkpoint', 10_000))
const scenarios = options.sizes.split(',').map(Number)
assert.ok(scenarios.every((size) => [5, 20, 100].includes(size)) && new Set(scenarios).size === scenarios.length,
  '--sizes must be a comma-separated subset of 5,20,100 without duplicates.')
const release = JSON.parse(await readFile('package.json', 'utf8'))
const execute = promisify(execFile)
const system = (command, ...args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
const sha256 = (contents) => createHash('sha256').update(contents).digest('hex')
const target = await artifact(options.target ?? `release/Ion IDE-${release.version}-darwin-${process.arch}/Ion IDE.app`)
const legacyTarget = options.baseline ? await artifact(options.baseline) : null
for (const bundle of [target, legacyTarget].filter(Boolean)) {
  assert.ok(bundle.path.endsWith('.app'), 'Provide a packaged .app path.')
}

const timestamp = new Date().toISOString()
const output = resolve(options.out, `themes-${timestamp.replaceAll(':', '-')}.json`)
const settleMs = 600
const idleWindowMs = 1200
const source = '#include <stdio.h>\n\nint main(void) {\n    puts("Theme benchmark");\n    return 0;\n}\n'
const marker = 'theme-bench-unsaved'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ION_DEV_URL

async function metadata(bundle) {
  return {
    path: bundle.path,
    asarSha256: sha256(await readFile(join(bundle.path, 'Contents/Resources/app.asar'))),
    architecture: system('/usr/bin/lipo', '-archs', bundle.executablePath),
  }
}
const report = {
  timestamp,
  artifacts: { target: await metadata(target), ...(legacyTarget && { baseline: await metadata(legacyTarget) }) },
  host: {
    macOS: system('/usr/bin/sw_vers'),
    processor: system('/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'),
    ramBytes: Number(system('/usr/sbin/sysctl', '-n', 'hw.memsize')),
    arch: process.arch,
    node: process.version,
    electron: release.devDependencies.electron,
    monaco: release.dependencies['monaco-editor'],
    power: system('/usr/bin/pmset', '-g', 'batt').split('\n')[0],
    thermal: system('/usr/bin/pmset', '-g', 'therm'),
  },
  protocol: { scenarios, switches, repetitions, settleMs, idleWindowMs, checkpointInterval },
  notes: {
    startup: 'Spawn to visible Welcome with active classic Dark. Fresh profiles and warm relaunches; OS caches left intact. Includes CDP attach. Signed bundle copied out of the synced workspace with Finder metadata removed.',
    registry: 'Exactly 5, 20, or 100 themes including built-ins. Customs created through the app, then copied as fixture files to each fresh disposable profile.',
    latency: 'Browser capture-phase click/change to a matching workbench palette plus two animation frames. A paint proxy, excluding OS delivery and physical display presentation.',
    memory: 'RSS sums all attributed descendants/profile-tagged helpers and can repeat shared pages. Footprint sums per-process kernel phys_footprint charges.',
    heap: 'Runtime.getHeapUsage and DOM counters before and after diagnostic HeapProfiler.collectGarbage. GC checkpoints are outside latency intervals.',
    idle: 'Percent of one logical core over a settled 1.2-second editor window, from macOS per-process kernel CPU time.',
    baseline: 'Optional legacy build with its original two theme buttons. Same fixture, sample schedule, and paint proxy. Catalog opening latency has no equivalent.',
  },
  runs: [],
}
await mkdir(resolve(options.out), { recursive: true })
const record = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')

async function verifiedCopy(bundle, scratch) {
  const path = join(scratch, 'Ion IDE.app')
  await mkdir(scratch)
  await execute('/usr/bin/ditto', ['--norsrc', '--noextattr', bundle.path, path])
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', path])
  return artifact(path)
}

async function shutdown(session) {
  const { child, browser } = session
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(2500, undefined, { ref: false })])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
  if (browser) await Promise.race([browser.close().catch(() => {}), sleep(2500, undefined, { ref: false })])
}

async function launch(bundle, profile, legacy = false) {
  const markerFile = join(profile, 'DevToolsActivePort')
  await rm(markerFile, { force: true })
  const start = performance.now()
  const child = spawn(bundle.executablePath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], { env, stdio: 'ignore' })
  const session = { child, pid: child.pid, profile }
  try {
    let port
    for (let attempts = 0; attempts < 400 && child.exitCode === null && child.signalCode === null; attempts += 1) {
      port = await readFile(markerFile, 'utf8').then((text) => Number(text.split('\n')[0]), () => null)
      if (port) break
      await sleep(10)
    }
    assert.ok(port, 'Packaged app started the disposable CDP endpoint')
    session.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8000 })
    const context = session.browser.contexts()[0]
    session.page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 8000 })
    const { page } = session
    page.setDefaultTimeout(8000)
    await page.getByTestId('welcome').waitFor()
    if (!legacy) await page.locator('.app-shell[data-theme-id="dark"]').waitFor()
    session.startupMs = performance.now() - start
    assert.equal(page.url(), 'app://workbench/index.html')
    await context.setOffline(true)
    session.cdp = await context.newCDPSession(page)
    return session
  } catch (error) {
    await shutdown(session)
    throw error
  }
}

async function processSample(session, probe) {
  const { timeMs, rssMiB, members } = await resourceSnapshot(session, { details: true })
  const { stdout } = await execute(probe, members.map(({ pid }) => String(pid)))
  const perPid = Object.fromEntries(stdout.trim().split('\n').filter(Boolean).map((row) => {
    const [pid, footprintBytes, cpuNs] = row.split(' ').map(Number)
    return [pid, { footprintBytes, cpuNs }]
  }))
  const processes = members.map(({ pid, kind, rssMiB }) => ({ pid, kind, rssMiB, ...perPid[pid] }))
  return {
    timeMs, rssMiB,
    footprintBytes: processes.every(({ footprintBytes }) => Number.isFinite(footprintBytes))
      ? processes.reduce((total, { footprintBytes }) => total + footprintBytes, 0) : null,
    processes,
  }
}

async function heapSample(cdp) {
  const { usedSize, totalSize } = await cdp.send('Runtime.getHeapUsage')
  const counters = await cdp.send('Memory.getDOMCounters')
  return { usedBytes: usedSize, allocatedBytes: totalSize, ...counters }
}

async function memoryCheckpoint(session, probe, completed) {
  const normal = await processSample(session, probe)
  const heap = await heapSample(session.cdp)
  await session.cdp.send('HeapProfiler.collectGarbage')
  const collectedHeap = await heapSample(session.cdp)
  const collectedProcess = await processSample(session, probe)
  return { completed, normal, heap, collectedHeap, collectedProcess }
}

async function catalogFixture(bundle, scratch, customCount) {
  const profile = join(scratch, 'catalog')
  await mkdir(profile)
  const session = await launch(bundle, profile)
  try {
    const { page } = session
    const builtins = await page.evaluate(() => window.ion.themes.list())
    assert.equal(builtins.length, 5, 'Fixture assumes exactly five built-in themes')
    const custom = await page.evaluate(async (count) => {
      const palettes = await Promise.all(['dark', 'light'].map(async (id) => {
        const { id: _id, source: _source, ...definition } = await window.ion.themes.load(id)
        return definition
      }))
      const results = []
      for (let index = 0; index < count; index += 1) {
        const name = `Benchmark ${String(index + 1).padStart(3, '0')}`
        const base = palettes[index % palettes.length]
        const dark = base.appearance === 'dark'
        const value = ((dark ? 160 : 48) + Math.floor(index / 2)).toString(16).padStart(2, '0')
        const comment = (dark ? '#9dbe' : '#3945') + value
        results.push(await window.ion.themes.create({ ...base, name, syntax: { ...base.syntax, comment } }))
      }
      return results
    }, customCount)
    return { profile, builtins, custom }
  } finally {
    await shutdown(session)
  }
}

async function seed(profile, project, themes, fixture) {
  await mkdir(profile)
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({
    version: 1,
    settings: { theme: 'dark', autoSave: false, showExplorer: true, showOutput: true },
    recents: [{ path: project.directory, name: basename(project.directory), kind: 'folder', lastOpened: 1 }],
  }))
  if (themes.length <= 5) return
  const directory = join(profile, 'themes')
  await mkdir(directory)
  const source = join(fixture.profile, 'themes')
  const registry = JSON.parse(await readFile(join(source, 'registry.json'), 'utf8'))
  const included = new Set(themes.map(({ id }) => id))
  const installed = registry.themes.filter(({ id }) => included.has(id))
  assert.equal(installed.length, themes.length - 5)
  await Promise.all(installed.map(({ id }) => cp(join(source, `${id}.json`), join(directory, `${id}.json`))))
  await writeFile(join(directory, 'registry.json'), JSON.stringify({ ...registry, themes: installed }))
}

async function armPaint(page, { event, testId, targetSelector }) {
  await page.evaluate(({ event, testId, targetSelector }) => {
    globalThis.ionThemePaint = new Promise((resolve, reject) => {
      let observer
      const listeners = new AbortController()
      const timer = setTimeout(() => {
        listeners.abort()
        observer?.disconnect()
        reject(new Error(`Timed out measuring ${targetSelector}`))
      }, 7000)
      document.addEventListener(event, (input) => {
        if (!input.target.closest(`[data-testid="${testId}"]`)) return
        listeners.abort()
        const start = performance.now()
        const complete = () => {
          if (!document.querySelector(targetSelector)) return
          observer.disconnect()
          requestAnimationFrame(() => requestAnimationFrame(() => {
            clearTimeout(timer)
            resolve(performance.now() - start)
          }))
        }
        observer = new MutationObserver(complete)
        observer.observe(document.querySelector('.app-shell'), { subtree: true, attributes: true, childList: true })
        complete()
      }, { capture: true, signal: listeners.signal })
    })
  }, { event, testId, targetSelector })
}

async function readPaint(page) {
  return page.evaluate(async () => {
    const ms = await globalThis.ionThemePaint
    delete globalThis.ionThemePaint
    return ms
  })
}

async function selectTheme(page, id, legacy) {
  const quick = id === 'dark' || id === 'light'
  const testId = quick ? `theme-${id}` : 'theme-picker'
  const targetSelector = legacy ? `.app-shell[data-theme="${id}"]` : `.app-shell[data-theme-id="${id}"]`
  await armPaint(page, { event: quick ? 'click' : 'change', testId, targetSelector })
  if (quick) await page.getByTestId(testId).click()
  else await page.getByTestId(testId).selectOption(id)
  return readPaint(page)
}

async function exercise(session, probe, project, themes, legacy) {
  const { page } = session
  const start = performance.now()
  await page.locator('.recent-entry').filter({ hasText: basename(project.directory) }).click()
  await page.getByTestId('explorer-entry').filter({ hasText: basename(project.file) }).click()
  await editorShows(page, '#include')
  const editorOpenMs = performance.now() - start
  const editorRoot = page.locator('.monaco-editor')
  await editorRoot.evaluate((node) => { node.dataset.themeBenchmarkEditor = 'original' })
  await editorRoot.locator('.view-line').first().click()
  await page.keyboard.press('Meta+ArrowRight')
  await page.keyboard.insertText(` // ${marker}`)
  await editorShows(page, marker)
  await sleep(settleMs)
  const editorIdleStart = await processSample(session, probe)
  const closedHeap = await heapSample(session.cdp)
  await sleep(idleWindowMs)
  const editorIdleEnd = await processSample(session, probe)
  const settings = page.getByTestId('settings')
  let catalogMs = null
  if (!legacy) {
    const optionalId = themes.find(({ id }) => id !== 'dark' && id !== 'light').id
    await armPaint(page, { event: 'click', testId: 'settings',
      targetSelector: `[data-testid="theme-picker"]:not(:disabled) option[value="${optionalId}"]` })
    await settings.click()
    catalogMs = await readPaint(page)
    const shown = await page.getByTestId('theme-picker').locator('option[value]:not([value=""])')
      .evaluateAll((options) => options.map(({ value }) => value).sort())
    const expected = themes.map(({ id }) => id).filter((id) => id !== 'dark' && id !== 'light').sort()
    assert.deepEqual(shown, expected, 'Picker shows every installed palette beyond the two quick choices')
  } else {
    await settings.click()
    await page.getByRole('dialog', { name: 'Preferences' }).waitFor()
  }
  await sleep(settleMs)
  const checkpoints = [await memoryCheckpoint(session, probe, 0)]
  const timings = []
  const ids = themes.map(({ id }) => id).filter((id) => id !== 'dark').concat('dark')
  for (let index = 0; index < switches; index += 1) {
    const id = ids[index % ids.length]
    timings.push({ id, ms: await selectTheme(page, id, legacy) })
    if ((index + 1) % checkpointInterval === 0 || index + 1 === switches) {
      await sleep(settleMs)
      checkpoints.push(await memoryCheckpoint(session, probe, index + 1))
    }
  }
  assert.equal(new Set(timings.map(({ id }) => id)).size, Math.min(switches, themes.length),
    'The workload cycles through distinct installed palettes before repeating')
  assert.equal(await editorRoot.count(), 1)
  assert.equal(await editorRoot.getAttribute('data-theme-benchmark-editor'), 'original', 'The editor DOM instance survived')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await editorShows(page, marker)
  assert.equal(await readFile(project.file, 'utf8'), source, 'Edits stayed in memory with autosave disabled')
  await editorRoot.locator('.view-line').first().click()
  await page.keyboard.press('Meta+z')
  await page.waitForFunction((marker) => !document.querySelector('.monaco-editor .view-lines').textContent.includes(marker), marker)
  await sleep(settleMs)
  const closedAfterSwitches = await memoryCheckpoint(session, probe, switches)
  const cpuBefore = new Map(editorIdleStart.processes.map(({ pid, cpuNs }) => [pid, cpuNs]))
  const idleCpuPercent = 100 * editorIdleEnd.processes.reduce((ns, { pid, cpuNs }) =>
    ns + (Number.isFinite(cpuBefore.get(pid)) && Number.isFinite(cpuNs) ? cpuNs - cpuBefore.get(pid) : 0), 0)
    / 1e6 / (editorIdleEnd.timeMs - editorIdleStart.timeMs)
  return {
    editorOpenMs, catalogMs, display: await page.evaluate(() => ({
      visible: document.visibilityState === 'visible', width: innerWidth, height: innerHeight, scale: devicePixelRatio,
    })),
    editorIdleStart, editorIdleEnd, idleCpuPercent, closedHeap, checkpoints, closedAfterSwitches, timings,
  }
}

function nearestRank(samples, percentile) {
  const sorted = samples.slice().sort((left, right) => left - right)
  return sorted[Math.ceil(percentile * sorted.length) - 1]
}

function summarize(runs) {
  const range = (values) => {
    const samples = values.filter(Number.isFinite)
    return samples.length ? { median: nearestRank(samples, 0.5), min: Math.min(...samples), max: Math.max(...samples) } : null
  }
  const latencies = runs.flatMap(({ timings }) => timings.map(({ ms }) => ms))
  const mib = (bytes) => bytes === null ? null : bytes / (1024 ** 2)
  return {
    runs: runs.length,
    freshStartupMs: range(runs.map(({ freshStartupMs }) => freshStartupMs)),
    warmStartupMs: range(runs.map(({ warmStartupMs }) => warmStartupMs)),
    editorOpenMs: range(runs.map(({ editorOpenMs }) => editorOpenMs)),
    catalogMs: runs[0].catalogMs === null ? null : range(runs.map(({ catalogMs }) => catalogMs)),
    editorIdleRssMiB: range(runs.map(({ editorIdleEnd }) => editorIdleEnd.rssMiB)),
    editorIdleFootprintMiB: range(runs.map(({ editorIdleEnd }) => mib(editorIdleEnd.footprintBytes))),
    editorClosedHeapMiB: range(runs.map(({ closedHeap }) => mib(closedHeap.usedBytes))),
    idleCpuPercent: range(runs.map(({ idleCpuPercent }) => idleCpuPercent)),
    switchMs: { ...range(latencies), p95: nearestRank(latencies, 0.95) },
    checkpoints: runs[0].checkpoints.map(({ completed }, index) => ({
      completed,
      rssMiB: range(runs.map(({ checkpoints }) => checkpoints[index].normal.rssMiB)),
      footprintMiB: range(runs.map(({ checkpoints }) => mib(checkpoints[index].normal.footprintBytes))),
      collectedHeapMiB: range(runs.map(({ checkpoints }) => mib(checkpoints[index].collectedHeap.usedBytes))),
      collectedDomNodes: range(runs.map(({ checkpoints }) => checkpoints[index].collectedHeap.nodes)),
    })),
    closedAfterSwitches: {
      footprintMiB: range(runs.map(({ closedAfterSwitches }) => mib(closedAfterSwitches.normal.footprintBytes))),
      collectedHeapMiB: range(runs.map(({ closedAfterSwitches }) => mib(closedAfterSwitches.collectedHeap.usedBytes))),
      collectedDomNodes: range(runs.map(({ closedAfterSwitches }) => closedAfterSwitches.collectedHeap.nodes)),
    },
  }
}

await withScratch('theme-bench', async (scratch) => {
  const candidate = await verifiedCopy(target, join(scratch, 'candidate'))
  const baseline = legacyTarget && await verifiedCopy(legacyTarget, join(scratch, 'baseline'))
  const probe = join(scratch, 'proc-rusage')
  await execute('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const project = { directory: join(scratch, 'project'), file: join(scratch, 'project/benchmark.c') }
  await mkdir(project.directory)
  await writeFile(project.file, source)
  await record()
  const fixture = await catalogFixture(candidate, scratch, Math.max(...scenarios) - 5)
  const workloads = scenarios.map((count) => ({
    bundle: candidate, count, themes: [...fixture.builtins, ...fixture.custom.slice(0, count - 5)], legacy: false,
  }))
  if (baseline) workloads.unshift({ bundle: baseline, count: 2, themes: [{ id: 'dark' }, { id: 'light' }], legacy: true })
  for (let repeat = 0; repeat < repetitions; repeat += 1) {
    // Rotate scenario order so one catalog size does not always run first or last.
    for (let index = 0; index < workloads.length; index += 1) {
      const { bundle, count, themes, legacy } = workloads[(index + repeat) % workloads.length]
      const profile = join(scratch, `profile-${count}-${repeat}`)
      await seed(profile, project, themes, fixture)
      const fresh = await launch(bundle, profile, legacy)
      await shutdown(fresh)
      const warm = await launch(bundle, profile, legacy)
      try {
        const run = await exercise(warm, probe, project, themes, legacy)
        report.runs.push({
          count, repeat: repeat + 1, freshStartupMs: fresh.startupMs, warmStartupMs: warm.startupMs, ...run,
        })
        await record()
        console.log(`Completed ${count} themes, run ${repeat + 1}/${repetitions}, ${run.timings.length} switches.`)
      } finally {
        await shutdown(warm)
      }
    }
  }
  report.summary = Object.fromEntries(workloads.map(({ count }) => [count, summarize(report.runs.filter((run) => run.count === count))]))
  await record()
  const format = (value) => Number.isFinite(value) ? value.toFixed(2) : '—'
  console.table(Object.fromEntries(Object.entries(report.summary).map(([count, summary]) => [count, {
    'fresh startup (ms)': format(summary.freshStartupMs.median),
    'warm startup (ms)': format(summary.warmStartupMs.median),
    'idle footprint (MiB)': format(summary.editorIdleFootprintMiB?.median),
    'catalog (ms)': format(summary.catalogMs?.median),
    'switch p50 (ms)': format(summary.switchMs.median),
    'switch p95 (ms)': format(summary.switchMs.p95),
    'post-GC heap after switches (MiB)': format(summary.checkpoints.at(-1).collectedHeapMiB.median),
  }])))
  console.log(output)
})
