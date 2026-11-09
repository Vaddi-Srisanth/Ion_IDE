import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { median } from './benchmark-resource-metrics.mjs'
import { artifact, atPath, close, createProject, editorShows, launch, openFolder, openFromExplorer,
  resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { savedPlotPng } from './notebook-fixtures.mjs'

const { values } = parseArgs({ options: {
  baseline: { type: 'string', default: 'performance-results/ion-0.7.0-before-markdown-preview-dist' },
  candidate: { type: 'string', default: 'dist' },
  trials: { type: 'string', default: '3' }, cycles: { type: 'string', default: '32' },
  'settle-ms': { type: 'string', default: '250' }, 'idle-ms': { type: 'string', default: '5000' },
  out: { type: 'string', default: 'performance-results' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('node scripts/benchmark-markdown-preview.mjs [--baseline BUILD] [--candidate BUILD] [--trials 3] [--cycles 32] [--settle-ms 250] [--idle-ms 5000] [--out DIR]')
  process.exit(0)
}
assert.equal(process.platform, 'darwin', 'This benchmark measures macOS process footprint.')
function integer(option, minimum, maximum) {
  const number = Number(values[option])
  assert.ok(Number.isInteger(number) && number >= minimum && number <= maximum, `Invalid --${option}.`)
  return number
}
const trials = integer('trials', 1, 10)
const cycles = integer('cycles', 1, 160)
const settleMs = integer('settle-ms', 100, 5000)
const idleMs = integer('idle-ms', 1000, 60_000)
const execute = promisify(execFile)
const source = [
  '# Markdown performance fixture', '', '![Markdown chart](chart.png)', '',
  '```java', 'public class Preview { private int answer = 42; }', '```', '',
  ...Array.from({ length: 95 }, (_, index) => [
    `## Topic ${index + 1}`, '', 'A paragraph with **bold**, *emphasis*, and `inline code`.', '',
    '- First point', '- Second point', '', '| Column A | Column B |', '| --- | --- |', `| Cell ${index + 1} | A value |`, '',
    ...((index + 1) % 12 === 0 ? ['```java', `public class Example${index + 1} { private int answer = 42; }`, '```', ''] : []),
  ]).flat(),
].join('\n')
const heading = 'Markdown performance fixture'
const stamp = new Date().toISOString()
const out = resolve(values.out, `markdown-preview-${stamp.replaceAll(':', '-')}.json`)
const probeSource = fileURLToPath(new URL('./benchmark-resources-probe.c', import.meta.url))

function timedCpu(before, after) {
  const byPid = new Map(before.processes.map(({ pid, cpuNs }) => [pid, cpuNs]))
  if (byPid.size !== after.processes.length || before.timeMs >= after.timeMs) return null
  const deltas = after.processes.map(({ pid, cpuNs }) => cpuNs - byPid.get(pid))
  return deltas.every((delta) => Number.isFinite(delta) && delta >= 0)
    ? deltas.reduce((sum, delta) => sum + delta, 0) / ((after.timeMs - before.timeMs) * 10_000) : null
}

async function runTrial({ target, folder, profile, documentPath, probe, candidate }) {
  const session = await launch(target, profile)
  const { app, page } = session
  const cdp = await page.context().newCDPSession(page)
  async function sample() {
    const memory = await resourceSnapshot(session, { details: true })
    const [{ stdout }, heap, dom, view] = await Promise.all([
      execute(probe, memory.members.map(({ pid }) => String(pid))),
      cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters'),
      page.evaluate(() => {
        const previews = [...document.querySelectorAll('[data-testid="markdown-preview"]')]
        return { monacoInstances: document.querySelectorAll('.monaco-editor').length,
          previewPanes: previews.length, visiblePreviewPanes: previews.filter((node) => node.getClientRects().length > 0).length,
          previewImages: document.querySelectorAll('[data-testid="markdown-preview"] img').length }
      }),
    ])
    const usage = new Map(stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [pid, bytes, cpuNs] = line.split(' ').map(Number)
      return [pid, { footprintMiB: bytes / 1024 ** 2, cpuNs }]
    }))
    const processes = memory.members.map((process) => ({ ...process, ...usage.get(process.pid) }))
    const footprintMiB = processes.every((process) => Number.isFinite(process.footprintMiB))
      ? processes.reduce((sum, process) => sum + process.footprintMiB, 0) : null
    return { timeMs: memory.timeMs, rssMiB: memory.rssMiB, footprintMiB, childRssMiB: memory.childRssMiB,
      rendererHeapMiB: heap.usedSize / 1024 ** 2, rendererHeapCommittedMiB: heap.totalSize / 1024 ** 2, dom, view, processes }
  }

  const preview = page.getByTestId('markdown-preview')
  const editor = page.getByTestId('editor')
  async function enter(mode) {
    const button = page.getByTestId(`markdown-${mode}-toggle`)
    const began = performance.now()
    await button.click()
    await preview.getByRole('heading', { name: heading }).waitFor()
    const image = preview.getByRole('img', { name: 'Markdown chart' })
    await image.waitFor()
    const decoded = await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="markdown-preview"] img')]
      .some((element) => element.complete && element.naturalWidth === 640))
    await decoded.dispose()
    return performance.now() - began
  }

  async function leave(mode) {
    const began = performance.now()
    await page.getByTestId(`markdown-${mode}-toggle`).click()
    await preview.waitFor({ state: 'hidden' })
    await preview.locator('img').first().waitFor({ state: 'detached' })
    await editor.waitFor({ state: 'visible' })
    const visible = await editorShows(page, heading)
    await visible.dispose()
    return performance.now() - began
  }

  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: folder.directory })
    await sleep(settleMs)
    const idleStart = await sample()
    await sleep(1500)
    const idle = await sample()
    await openFolder(page, folder)
    await openFromExplorer(page, folder.program, '#include')
    await sleep(settleMs)
    const code = await sample()
    const start = performance.now()
    await atPath(page, 'explorer-entry', documentPath).click()
    await atPath(page, 'tab', documentPath).waitFor()
    const visible = await editorShows(page, heading)
    await visible.dispose()
    const sourceOpenMs = performance.now() - start
    await sleep(settleMs)
    const markdown = await sample()
    assert.equal(markdown.view.monacoInstances, 1)
    assert.equal(markdown.view.previewPanes, 0)

    const views = {}
    const toggles = []
    if (candidate) {
      for (const mode of ['preview', 'split']) {
        const openMs = await enter(mode)
        await sleep(settleMs)
        const opened = await sample()
        assert.equal(opened.view.monacoInstances, 1, `${mode} should reuse the source editor.`)
        assert.equal(opened.view.previewPanes, 1)
        assert.equal(opened.view.visiblePreviewPanes, 1)
        const closeMs = await leave(mode)
        await sleep(settleMs)
        views[mode] = { openMs, opened, closeMs, closed: await sample() }
      }

      for (let index = 1; index <= cycles; index++) {
        const mode = index % 2 ? 'preview' : 'split'
        const openMs = await enter(mode)
        const closeMs = await leave(mode)
        await sleep(settleMs)
        const closed = index === 1 || index % 4 === 0 || index === cycles ? await sample() : null
        if (closed) {
          assert.ok(closed.view.previewPanes <= 1, 'Source mode should retain at most the active document’s preview.')
          assert.equal(closed.view.visiblePreviewPanes, 0)
          assert.equal(closed.view.previewImages, 0)
          assert.equal(closed.view.monacoInstances, 1)
          assert.equal(closed.childRssMiB, 0, 'Toggling should start no native process.')
        }
        toggles.push({ index, mode, openMs, closeMs, closed })
      }
    } else {
      assert.equal(await page.getByTestId('markdown-preview-toggle').count(), 0, 'The baseline cannot display rendered preview.')
    }

    await sleep(idleMs)
    const settled = await sample()
    await cdp.send('HeapProfiler.collectGarbage')
    await sleep(settleMs)
    const diagnosticGc = await sample()
    await atPath(page, 'tab', folder.program).locator('.tab-name').click()
    await preview.waitFor({ state: 'detached' })
    const codeAgain = await editorShows(page, '#include')
    await codeAgain.dispose()
    await sleep(settleMs)
    const switchedToCode = await sample()
    assert.equal(switchedToCode.view.previewPanes, 0, 'Switching to code must dispose of the Markdown preview pane.')
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    return { startupMs: session.startupMs, idleCpuPercentOfOneCore: timedCpu(idleStart, idle), idleStart, idle,
      code, sourceOpenMs, markdown, views, toggles, settled, diagnosticGc, switchedToCode }
  } finally {
    await cdp.detach().catch(() => {})
    await close(session)
  }
}

function summary(samples) {
  const memory = (points) => Object.fromEntries(['rssMiB', 'footprintMiB', 'rendererHeapMiB'].map((key) =>
    [key, median(points.map((point) => point?.[key]))]))
  const stages = Object.fromEntries(['idle', 'code', 'markdown', 'settled', 'diagnosticGc', 'switchedToCode'].map((name) =>
    [name, memory(samples.map((sample) => sample[name]))]))
  const views = Object.fromEntries(['preview', 'split'].flatMap((mode) => {
    const samplesWithView = samples.filter(({ views }) => views[mode])
    if (!samplesWithView.length) return []
    const modeSamples = samplesWithView.map(({ views }) => views[mode])
    const modes = samples.flatMap(({ toggles }) => toggles.filter((toggle) => toggle.mode === mode))
    return [[mode, { firstOpenMs: median(modeSamples.map(({ openMs }) => openMs)),
      firstCloseMs: median(modeSamples.map(({ closeMs }) => closeMs)), opened: memory(modeSamples.map(({ opened }) => opened)),
      closed: memory(modeSamples.map(({ closed }) => closed)),
      medianRepeatedOpenMs: median(modes.map(({ openMs }) => openMs)), medianRepeatedCloseMs: median(modes.map(({ closeMs }) => closeMs)) }]]
  }))
  const closedSamples = samples.map(({ toggles }) => toggles.flatMap(({ closed }) => closed ? [closed] : []))
  const allClosed = closedSamples.flat()
  const peaks = allClosed.length ? Object.fromEntries(['rssMiB', 'footprintMiB', 'rendererHeapMiB'].map((key) => {
    const values = allClosed.map((point) => point[key]).filter(Number.isFinite)
    return [key, values.length ? Math.max(...values) : null]
  })) : null
  const closedGrowth = allClosed.length ? Object.fromEntries(['rssMiB', 'footprintMiB', 'rendererHeapMiB'].map((key) =>
    [key, median(closedSamples.map((points) => {
      if (points.length < 4) return null
      const early = median(points.slice(1, 3).map((point) => point[key]))
      const late = median(points.slice(-2).map((point) => point[key]))
      return early === null || late === null ? null : late - early
    }))])) : null
  return { startupMs: median(samples.map(({ startupMs }) => startupMs)), sourceOpenMs: median(samples.map(({ sourceOpenMs }) => sourceOpenMs)),
    idleCpuPercentOfOneCore: median(samples.map(({ idleCpuPercentOfOneCore }) => idleCpuPercentOfOneCore)),
    ...stages, views, highestRepeatedClosedSample: peaks, repeatedClosedMedianGrowth: closedGrowth }
}

const report = await withScratch('markdown-preview-bench', async (scratch) => {
  const probe = join(scratch, 'footprint')
  await execute('/usr/bin/clang', ['-O2', '-std=c11', probeSource, '-o', probe])
  const folder = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const documentPath = join(folder.directory, 'preview.md')
  const image = savedPlotPng(640, 400)
  await Promise.all([writeFile(documentPath, source), writeFile(join(folder.directory, 'chart.png'), image)])
  const targets = { baseline: await artifact(values.baseline), candidate: await artifact(values.candidate) }
  const samples = { baseline: [], candidate: [] }
  for (let index = 1; index <= trials; index++) {
    const order = index % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    for (const label of order) {
      console.log(`Measuring ${label} trial ${index} of ${trials}.`)
      samples[label].push(await runTrial({ target: targets[label], folder, profile: join(scratch, `${label}-${index}`),
        documentPath, probe, candidate: label === 'candidate' }))
    }
  }
  const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')
  const artifacts = Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([label, target]) => {
    assert.ok(!target.path.endsWith('.app'), 'Use production bundles with the desktop harness.')
    return [label, { target: target.path, mainSha256: await hash(join(target.path, 'main/index.cjs')),
      rendererHtmlSha256: await hash(join(target.path, 'renderer/index.html')) }]
  })))
  return { timestamp: stamp, trials, cycles, settleMs, idleMs, artifacts,
    host: { macOS: (await execute('/usr/bin/sw_vers', [])).stdout.trim(), arch: process.arch, node: process.version,
      processor: (await execute('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'])).stdout.trim(),
      ramBytes: Number((await execute('/usr/sbin/sysctl', ['-n', 'hw.memsize'])).stdout.trim()) },
    fixture: { markdownBytes: Buffer.byteLength(source), imageBytes: image.length, imageWidth: 640, imageHeight: 400 },
    notes: {
      matched: 'The baseline and candidate use distinct disposable profiles. Idle, ordinary C source, and Markdown source are directly matched. Only the candidate supports preview, split and repeated toggling.',
      rss: 'RSS sums the entire Electron process tree and may count shared pages more than once. macOS physical footprint uses proc_pid_rusage.',
      memory: 'The report separates natural settling from one explicit renderer garbage collection. The latter is diagnostic and does not represent normal app behavior.',
      repeatGrowth: 'Difference between the median of cycles 4 and 8 and the median of the last two sampled closes per trial, then the median across trials. The first close sample is excluded.',
      time: 'Timings cover the automated click through visible Markdown heading and decoded fixture image, or return to visible Monaco source.',
    }, samples, summary: Object.fromEntries(Object.entries(samples).map(([label, results]) => [label, summary(results)])) }
})

await mkdir(resolve(values.out), { recursive: true })
await writeFile(out, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report.summary, null, 2))
console.log(`Markdown preview benchmark report: ${out}`)
