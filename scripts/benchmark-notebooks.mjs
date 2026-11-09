import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { median } from './benchmark-resource-metrics.mjs'
import {
  artifact, atPath, close, createProject, editorShows, eventually, launch, openFromExplorer,
  resourceSnapshot, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'
import { cellNotebook, chooseNotebookPython, encodeNotebook, kernelBenchmarkNotebook, plotNotebook, revealNotebookCell,
  smallNotebook, stubNotebookTrust } from './notebook-fixtures.mjs'

const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, candidate: { type: 'string', default: 'dist' },
  trials: { type: 'string', default: '3' }, cycles: { type: 'string', default: '10' },
  settle: { type: 'string', default: '450' }, out: { type: 'string', default: 'performance-results' },
  'kernel-python': { type: 'string' },
} })
assert.equal(process.platform, 'darwin', 'Process footprint measurement uses macOS kernel counters.')
assert.ok(values.baseline, 'Provide --baseline followed by the preserved production build directory.')
const trials = Number(values.trials)
const cycles = Number(values.cycles)
const settle = Number(values.settle)
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 10)
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 30)
assert.ok(Number.isInteger(settle) && settle >= 100 && settle <= 5000)
const execute = promisify(execFile)
const timestamp = new Date().toISOString()
const output = resolve(values.out, `notebooks-${timestamp.replaceAll(':', '-')}.json`)
const probeSource = fileURLToPath(new URL('./benchmark-resources-probe.c', import.meta.url))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function sample(session, probe) {
  const { timeMs, rssMiB, childRssMiB, members } = await resourceSnapshot(session, { details: true })
  const { stdout } = await execute(probe, members.map(({ pid }) => String(pid)))
  const charges = new Map(stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [pid, bytes, cpuNs] = line.split(' ').map(Number)
    return [pid, { footprintMiB: bytes / 1024 ** 2, cpuNs }]
  }))
  const processes = members.map((member) => ({ ...member, ...charges.get(member.pid) }))
  const footprint = (items) => items.every((item) => Number.isFinite(item.footprintMiB))
    ? items.reduce((sum, item) => sum + item.footprintMiB, 0) : null
  const visual = await session.page.evaluate(() => ({
    mountedNotebookCells: document.querySelectorAll('[data-testid="notebook-cell"]').length,
    decodedNotebookImages: [...document.querySelectorAll('[data-testid="notebook-view"] img')]
      .filter((image) => image.complete && image.naturalWidth > 0).length,
    monacoInstances: document.querySelectorAll('.monaco-editor').length,
  }))
  return { timeMs, rssMiB, childRssMiB, footprintMiB: footprint(processes),
    childFootprintMiB: footprint(processes.filter(({ kind }) => kind === 'child')), processes, ...visual }
}

function percentOfOneCore(before, after) {
  const elapsedMs = after.timeMs - before.timeMs
  const earlier = new Map(before.processes.map(({ pid, cpuNs }) => [pid, cpuNs]))
  if (elapsedMs <= 0 || earlier.size !== after.processes.length) return null
  const deltas = after.processes.map(({ pid, cpuNs }) => cpuNs - earlier.get(pid))
  if (deltas.some((delta) => !Number.isFinite(delta) || delta < 0)) return null
  return deltas.reduce((sum, delta) => sum + delta, 0) / (elapsedMs * 10_000)
}

async function scrollSamples(page, raw) {
  const scroll = raw ? page.locator('.monaco-editor').first() : page.getByTestId('notebook-scroll')
  const bounds = await scroll.boundingBox()
  assert.ok(bounds, 'The selected viewport must be visible.')
  await page.mouse.move(bounds.x + (raw ? bounds.width / 2 : Math.min(10, bounds.width / 2)), bounds.y + bounds.height / 2)
  await scroll.evaluate((node, raw) => {
    const offset = () => {
      if (!raw) return node.scrollTop
      const slider = node.querySelector('.scrollbar.vertical .slider')
      const viewport = node.querySelector('.monaco-scrollable-element')
      const lines = node.querySelector('.view-lines')
      const first = lines?.querySelector('.view-line')
      return [slider?.style.top, slider?.style.transform, slider?.offsetTop, viewport?.scrollTop,
        lines?.style.top, lines?.style.transform, first?.style.top, first?.textContent?.slice(0, 160)].join('|')
    }
    const probe = {
      results: {}, sample: -1, initial: undefined,
      begin(sample) { this.sample = sample; this.initial = offset() },
      dispose: () => node.removeEventListener('wheel', wheel, true),
    }
    const wheel = () => {
      const sample = probe.sample
      if (sample < 0 || sample in probe.results) return
      const started = performance.now()
      const initial = probe.initial
      let frames = 0
      function changed() {
        if (probe.sample !== sample || sample in probe.results) return
        if (offset() !== initial) requestAnimationFrame(() => {
          if (probe.sample === sample) probe.results[sample] = performance.now() - started
        })
        else if (++frames >= 30) probe.results[sample] = null
        else requestAnimationFrame(changed)
      }
      requestAnimationFrame(changed)
    }
    node.addEventListener('wheel', wheel, { capture: true, passive: true })
    window.ionNotebookBenchScroll = probe
  }, raw)
  try {
    for (let index = 0; index < 10; index++) {
      await page.evaluate((sample) => window.ionNotebookBenchScroll.begin(sample), index)
      await page.mouse.wheel(0, index % 2 ? -340 : 340)
      const ready = await page.waitForFunction((sample) => sample in window.ionNotebookBenchScroll.results,
        index, { timeout: 1600 }).catch((error) => {
        if (error.name !== 'TimeoutError') throw error
      })
      await ready?.dispose()
    }
    const timings = await page.evaluate(() => Array.from({ length: 10 }, (_, index) => window.ionNotebookBenchScroll.results[index] ?? null))
    const missing = timings.filter((time) => time === null).length
    if (missing) console.warn(`${raw ? 'Baseline Monaco' : 'Native notebook'}: ${missing} of ${timings.length} wheel inputs had no observed viewport movement.`)
    return timings
  } finally {
    await page.evaluate(() => {
      window.ionNotebookBenchScroll.dispose()
      delete window.ionNotebookBenchScroll
    })
  }
}

async function openFixture(page, path, label, raw) {
  const start = performance.now()
  await atPath(page, 'explorer-entry', path).click()
  await atPath(page, 'tab', path).waitFor()
  const view = page.getByTestId('notebook-view')
  if (raw && label === 'plots') {
    await page.getByText(/Only UTF-8 text files up to 2 MiB/).first().waitFor()
  } else if (raw) {
    const visible = await editorShows(page, 'nbformat')
    await visible.dispose()
  } else if (label === 'small') {
    await view.getByRole('heading', { name: 'Notebook study fixture' }).waitFor()
  } else if (label === 'hundred') {
    await view.getByText('Notebook cell 001', { exact: true }).waitFor()
  } else {
    const ready = await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="notebook-view"] img')]
      .some((image) => image.complete && image.naturalWidth === 960))
    await ready.dispose()
  }
  return performance.now() - start
}

async function closeFixture(page, path) {
  await atPath(page, 'close-tab', path).click()
  await atPath(page, 'tab', path).waitFor({ state: 'detached' })
  const ready = await editorShows(page, '#include')
  await ready.dispose()
}

async function revealPlot(page, index) {
  const view = page.getByTestId('notebook-view')
  await revealNotebookCell(view, index)
  const ready = await page.waitForFunction((index) => {
    const image = document.querySelector(`[data-testid="notebook-cell"][data-cell-index="${index}"] img`)
    return image?.complete && image.naturalWidth === 960
  }, index)
  await ready.dispose()
}

async function runTrial({ label, target, profile, fixture, paths, probe, repeatLargePlots }) {
  const raw = label === 'baseline'
  const session = await launch(target, profile)
  const { app, page } = session
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: fixture.directory })
    await sleep(settle)
    const idleStart = await sample(session, probe)
    await sleep(1500)
    const idle = await sample(session, probe)
    await page.getByTestId('open-folder').first().click()
    await atPath(page, 'explorer-entry', fixture.program).waitFor()
    await openFromExplorer(page, fixture.program, '#include')
    await sleep(settle)
    const code = await sample(session, probe)
    const cases = {}
    for (const [name, path] of Object.entries(paths)) {
      const openMs = await openFixture(page, path, name, raw)
      await sleep(settle)
      const viewed = await sample(session, probe)
      const scrollingMs = name === 'hundred' ? await scrollSamples(page, raw) : null
      const otherPlots = []
      if (name === 'plots' && !raw) {
        for (let index = 1; index < 3; index++) {
          await revealPlot(page, index)
          await sleep(settle)
          otherPlots.push(await sample(session, probe))
        }
      }
      await closeFixture(page, path)
      await sleep(settle)
      const closed = await sample(session, probe)
      cases[name] = { openMs, available: !raw || name !== 'plots', viewed, otherPlots, scrollingMs, closed }
    }
    async function repeatedOpen(name) {
      const results = []
      const path = paths[name]
      for (let cycle = 0; cycle < cycles; cycle++) {
        const openMs = await openFixture(page, path, name, raw)
        await sleep(settle)
        const viewed = await sample(session, probe)
        await closeFixture(page, path)
        await sleep(settle)
        const closed = await sample(session, probe)
        results.push({ cycle: cycle + 1, openMs, viewed, closed })
      }
      return results
    }
    const repeat = await repeatedOpen('hundred')
    await sleep(2000)
    const settled = await sample(session, probe)
    const plotRepeat = repeatLargePlots ? await repeatedOpen('plots') : []
    assert.ok([idle, code, settled, ...Object.values(cases).map(({ viewed }) => viewed),
      ...repeat.map(({ viewed }) => viewed), ...plotRepeat.map(({ viewed }) => viewed)]
      .every(({ childRssMiB }) => childRssMiB === 0), 'Viewing should start no native child process.')
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    return { startupMs: session.startupMs, idle, idleStart, idleCpuPercentOfOneCore: percentOfOneCore(idleStart, idle),
      code, cases, repeat, settled, plotRepeat }
  } finally {
    await close(session)
  }
}

function summary(runs) {
  return Object.fromEntries(Object.entries(runs).map(([label, trials]) => [label, {
    startupMs: median(trials.map(({ startupMs }) => startupMs)),
    idleRssMiB: median(trials.map(({ idle }) => idle.rssMiB)),
    idleFootprintMiB: median(trials.map(({ idle }) => idle.footprintMiB)),
    idleCpuPercentOfOneCore: median(trials.map(({ idleCpuPercentOfOneCore }) => idleCpuPercentOfOneCore)),
    codeRssMiB: median(trials.map(({ code }) => code.rssMiB)),
    codeFootprintMiB: median(trials.map(({ code }) => code.footprintMiB)),
    cases: Object.fromEntries(Object.keys(trials[0].cases).map((name) => {
      const cases = trials.map((trial) => trial.cases[name])
      return [name, {
        available: cases.every((item) => item.available),
        openMs: median(cases.map((item) => item.openMs)),
        viewedRssMiB: median(cases.map(({ viewed, otherPlots }) => Math.max(...[viewed, ...otherPlots].map(({ rssMiB }) => rssMiB)))),
        viewedFootprintMiB: median(cases.map(({ viewed, otherPlots }) => {
          const samples = [viewed, ...otherPlots].map(({ footprintMiB }) => footprintMiB).filter(Number.isFinite)
          return samples.length ? Math.max(...samples) : null
        })),
        closedRssMiB: median(cases.map(({ closed }) => closed.rssMiB)),
        closedFootprintMiB: median(cases.map(({ closed }) => closed.footprintMiB)),
        scrollMs: median(cases.flatMap(({ scrollingMs }) => scrollingMs ?? [])),
        scrollObserved: cases.flatMap(({ scrollingMs }) => scrollingMs ?? []).filter(Number.isFinite).length,
        scrollAttempted: cases.flatMap(({ scrollingMs }) => scrollingMs ?? []).length,
      }]
    })),
    repeatedClosedRssMiB: trials.map(({ repeat }) => repeat.map(({ closed }) => closed.rssMiB)),
    repeatedClosedFootprintMiB: trials.map(({ repeat }) => repeat.map(({ closed }) => closed.footprintMiB)),
    plotRepeatedClosedRssMiB: trials.flatMap(({ plotRepeat }) => plotRepeat.map(({ closed }) => closed.rssMiB)),
    plotRepeatedClosedFootprintMiB: trials.flatMap(({ plotRepeat }) => plotRepeat.map(({ closed }) => closed.footprintMiB)),
    settledRssMiB: median(trials.map(({ settled }) => settled.rssMiB)),
    settledFootprintMiB: median(trials.map(({ settled }) => settled.footprintMiB)),
  }]))
}

function processExists(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

async function runKernelTrial({ target, profile, fixture, path, probe, python }) {
  const session = await launch(target, profile)
  let completed = false
  try {
    const { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: fixture.directory, file: python })
    await stubNotebookTrust(app, true)
    await page.getByTestId('open-folder').first().click()
    await atPath(page, 'explorer-entry', fixture.program).waitFor()
    await openFromExplorer(page, fixture.program, '#include')
    await atPath(page, 'explorer-entry', path).click()
    const view = page.getByTestId('notebook-view')
    await view.getByText(/ion_benchmark_state/).waitFor()
    await chooseNotebookPython(view)
    await sleep(settle)
    await eventually(async () => (await resourceSnapshot(session)).childRssMiB === 0, 'Interpreter discovery did not finish.')
    const before = await sample(session, probe)
    const began = performance.now()
    await view.getByTestId('notebook-run-cell').click()
    await view.getByTestId('notebook-output').getByText('Ion benchmark kernel is live', { exact: true }).waitFor({ timeout: 30_000 })
    const startAndExecuteMs = performance.now() - began
    await sleep(settle)
    const running = await sample(session, probe)
    const owned = running.processes.filter(({ kind }) => kind === 'child').map(({ pid }) => pid)
    assert.ok(owned.length && running.childRssMiB > 0, 'Benchmark must include the real interpreter process tree.')
    await view.getByTestId('notebook-kernel-stop').click()
    await eventually(() => owned.every((pid) => !processExists(pid)), 'Stop did not reap the measured kernel processes.')
    await sleep(settle)
    const stopped = await sample(session, probe)
    await page.getByTestId('save-file').click()
    await closeFixture(page, path)
    await sleep(settle)
    const closed = await sample(session, probe)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    completed = true
    return { before, running, stopped, closed, startAndExecuteMs }
  } finally {
    await close(session).catch((error) => { if (completed) throw error })
  }
}

function kernelSummary(trials) {
  if (!trials.length) return null
  const phases = Object.fromEntries(['before', 'running', 'stopped', 'closed'].map((phase) => [phase, {
    rssMiB: median(trials.map((item) => item[phase].rssMiB)),
    footprintMiB: median(trials.map((item) => item[phase].footprintMiB)),
    childRssMiB: median(trials.map((item) => item[phase].childRssMiB)),
    childFootprintMiB: median(trials.map((item) => item[phase].childFootprintMiB)),
  }]))
  return { ...phases, startAndExecuteMs: median(trials.map(({ startAndExecuteMs }) => startAndExecuteMs)),
    additionalRssMiB: median(trials.map(({ before, running }) => running.rssMiB - before.rssMiB)),
    additionalFootprintMiB: median(trials.flatMap(({ before, running }) =>
      Number.isFinite(before.footprintMiB) && Number.isFinite(running.footprintMiB) ? [running.footprintMiB - before.footprintMiB] : [])),
  }
}

const report = await withScratch('notebook-benchmark', async (scratch) => {
  const probe = join(scratch, 'footprint')
  await execute('/usr/bin/clang', ['-O2', '-std=c11', probeSource, '-o', probe])
  const fixture = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const notebooks = { small: smallNotebook(), hundred: cellNotebook(100), plots: plotNotebook() }
  const paths = {}
  const files = {}
  for (const [name, notebook] of Object.entries(notebooks)) {
    paths[name] = join(fixture.directory, `${name}.ipynb`)
    const contents = Buffer.from(encodeNotebook(notebook))
    await writeFile(paths[name], contents)
    files[name] = { bytes: contents.length, cells: notebook.cells.length, sha256: sha256(contents) }
  }
  const targets = { baseline: await artifact(values.baseline), candidate: await artifact(values.candidate) }
  for (const target of Object.values(targets)) assert.ok(!target.path.endsWith('.app'), 'Use unpackaged production builds.')
  const artifacts = Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([label, target]) => [label, {
    target: target.path,
    mainSha256: sha256(await readFile(target.args[0])),
    rendererHtmlSha256: sha256(await readFile(join(dirname(target.args[0]), '../renderer/index.html'))),
  }])))
  const runs = { baseline: [], candidate: [] }
  for (let trial = 0; trial < trials; trial++) {
    const order = trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']
    for (const label of order) {
      const profile = join(scratch, `profile-${label}-${trial + 1}`)
      runs[label].push(await runTrial({ label, target: targets[label], profile, fixture, paths, probe,
        repeatLargePlots: label === 'candidate' && trial === 0 }))
    }
  }
  const kernelTrials = []
  const python = values['kernel-python']
  if (python) {
    await execute(python, ['-I', '-c', 'import ipykernel, jupyter_client'], { timeout: 20_000 })
    for (let trial = 0; trial < trials; trial++) {
      const path = join(fixture.directory, `kernel-probe-${trial + 1}.ipynb`)
      await writeFile(path, encodeNotebook(kernelBenchmarkNotebook()))
      const profile = join(scratch, `profile-kernel-${trial + 1}`)
      kernelTrials.push(await runKernelTrial({ target: targets.candidate, profile, fixture, path, probe, python }))
    }
  }
  const host = async (path, ...args) => (await execute(path, args)).stdout.trim()
  const [macOS, processor, ramBytes] = await Promise.all([
    host('/usr/bin/sw_vers'), host('/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'), host('/usr/sbin/sysctl', '-n', 'hw.memsize'),
  ])
  return { timestamp, trials, cycles, settleMs: settle, files, artifacts,
    host: { macOS, processor, ramBytes: Number(ramBytes), arch: process.arch, node: process.version },
    notes: {
      workload: 'Fresh offline profiles. Baseline reads the same small and 100-cell notebooks as JSON and refuses the 5.8 MB plot file above its editor limit. Candidate renders the notebook and visits each plot.',
      repeat: 'Both builds repeat the same 100-cell fixture in each trial. The first candidate trial additionally repeats the large plot file to stress its image lifecycle.',
      memory: 'RSS sums resident sets and can count shared pages more than once. Footprint sums macOS phys_footprint charges across the process tree. No forced GC.',
      idleCpu: 'Percentage of one core, using macOS process-tree user and system time over the 1.5-second quiet Welcome window.',
      latency: 'Open latency is measured from the automation issuing an explorer click to the first relevant content or rejection. Scroll latency is a wheel event to a changed viewport offset plus the next animation callback, a paint proxy.',
      kernel: 'Optional candidate-only trials start a real local kernel in fresh profiles. The measured Python cell assigns one value and prints one line without scientific libraries.',
    }, runs, summary: summary(runs), kernel: python ? { python, trials: kernelTrials, summary: kernelSummary(kernelTrials) } : null }
})
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(output)
console.table(Object.entries(report.summary).flatMap(([build, result]) => Object.entries(result.cases)
  .map(([fixture, item]) => ({ build, fixture, ...item }))))
if (report.kernel) console.log('Kernel trials:', JSON.stringify(report.kernel.summary))
