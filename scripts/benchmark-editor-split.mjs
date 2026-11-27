import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, launch, openFolder, resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { median } from './benchmark-resource-metrics.mjs'
import { windowsProcessTree } from './windows/process-tree.mjs'

const execute = promisify(execFile)
const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, label: { type: 'string', default: 'candidate' },
  rounds: { type: 'string', default: '5' }, settle: { type: 'string', default: '1200' },
} })
assert.ok(process.platform === 'darwin' || process.platform === 'win32', 'Run the split benchmark on native macOS or Windows.')
const windows = process.platform === 'win32'
assert.match(values.label, /^[\w-]+$/)
const rounds = Number(values.rounds), settleMs = Number(values.settle)
assert.ok(Number.isInteger(rounds) && rounds >= 3 && rounds <= 20)
assert.ok(Number.isInteger(settleMs) && settleMs >= 500 && settleMs <= 10_000)
const target = await artifact(values.target)
const probeSource = fileURLToPath(new URL('./benchmark-resources-probe.c', import.meta.url))
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

async function sample(session, probe, label, wait = settleMs) {
  await sleep(wait)
  if (windows) {
    const tree = await windowsProcessTree(session)
    return { label, time: tree.timeMs, rssMiB: tree.workingSetMiB, privateMiB: tree.privateMiB,
      footprintMiB: null, cpu: Object.fromEntries(tree.members.map(item => [item.pid + ':' + item.started, item.cpuSeconds])),
      processes: tree.members.map(({ kind }) => kind), processCount: tree.members.length }
  }
  const tree = await resourceSnapshot(session, { details: true })
  const { stdout } = await execute(probe, tree.members.map(({ pid }) => String(pid)))
  const native = new Map(stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [pid, footprint, cpu] = line.split(/\s+/).map(Number)
    return [pid, { footprint, cpu }]
  }))
  const measured = tree.members.map((member) => ({ ...member, ...native.get(member.pid) }))
  assert.ok(measured.length && measured.every(({ footprint, cpu }) => Number.isFinite(footprint) && Number.isFinite(cpu)))
  return { label, time: performance.now(), rssMiB: tree.rssMiB,
    footprintMiB: measured.reduce((sum, item) => sum + item.footprint, 0) / 1024 ** 2,
    cpu: Object.fromEntries(measured.map(({ pid, started, cpu }) => [pid + ':' + started, cpu])),
    processes: measured.map(({ kind }) => kind), processCount: measured.length }
}

function cpuPercent(before, after) {
  const entries = Object.entries(after.cpu)
  if (entries.length !== Object.keys(before.cpu).length || after.time <= before.time) return null
  let delta = 0
  for (const [identity, value] of entries) {
    const previous = before.cpu[identity]
    if (!Number.isFinite(previous) || value < previous) return null
    delta += value - previous
  }
  return windows ? delta / ((after.time - before.time) / 1000) * 100 : delta / 1e6 / (after.time - before.time) * 100
}

const report = await withScratch('editor-split-benchmark', async (scratch) => {
  const probe = windows ? null : join(scratch, 'rusage')
  if (probe) await execute('/usr/bin/clang', ['-O2', '-std=c11', probeSource, '-o', probe])
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const profile = join(scratch, 'profile')
  const session = await launch(target, profile)
  const samples = [], openMs = [], closeMs = []
  try {
    await session.page.context().setOffline(true)
    await stubDialogs(session.app, { folder: project.directory })
    await openFolder(session.page, project)
    const fileStarted = performance.now()
    await atPath(session.page, 'explorer-entry', project.program).click()
    await editorShows(session.page, '#include')
    const firstFileMs = performance.now() - fileStarted
    const baselineA = await sample(session, probe, 'closed-warmup')
    const baseline = await sample(session, probe, 'closed-baseline')
    samples.push(baselineA, baseline)
    for (let round = 0; round < rounds; round++) {
      let started = performance.now()
      await session.page.getByTestId('source-split-toggle').click()
      await session.page.locator('[data-source-split="true"] .secondary-monaco-host .monaco-editor').waitFor()
      openMs.push(performance.now() - started)
      const openedSample = await sample(session, probe, `open-${round + 1}`)
      assert.equal(openedSample.processes.includes('child'), false, 'Opening a split must not start a child process.')
      samples.push(openedSample)
      started = performance.now()
      await session.page.getByTestId('source-split-toggle').click()
      await session.page.locator('.secondary-monaco-host').waitFor({ state: 'detached' })
      closeMs.push(performance.now() - started)
      samples.push(await sample(session, probe, `closed-${round + 1}`))
    }
    const recovered = await sample(session, probe, 'closed-recovered', 5000)
    samples.push(recovered)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    const opened = samples.filter(({ label }) => label.startsWith('open-'))
    const closed = samples.filter(({ label }) => /^closed-\d+$/.test(label))
    return { timestamp: new Date().toISOString(), label: values.label, target: basename(target.path),
      artifact: { main: await hash(target.args[0]) }, host: { platform: process.platform, arch: process.arch },
      rounds, settleMs, startupMs: session.startupMs, firstFileMs, samples, summary: {
        openLatencyMedianMs: median(openMs), closeLatencyMedianMs: median(closeMs),
        baselineFootprintMiB: baseline.footprintMiB, openFootprintMedianMiB: windows ? null : median(opened.map(({ footprintMiB }) => footprintMiB)),
        recoveredFootprintMiB: recovered.footprintMiB, baselineRssMiB: baseline.rssMiB,
        openRssMedianMiB: median(opened.map(({ rssMiB }) => rssMiB)), recoveredRssMiB: recovered.rssMiB,
        baselinePrivateMiB: baseline.privateMiB ?? null, openPrivateMedianMiB: windows ? median(opened.map(({ privateMiB }) => privateMiB)) : null,
        recoveredPrivateMiB: recovered.privateMiB ?? null,
        recoveredFootprintDeltaMiB: windows ? null : recovered.footprintMiB - baseline.footprintMiB,
        recoveredRssDeltaMiB: recovered.rssMiB - baseline.rssMiB,
        recoveredPrivateDeltaMiB: windows ? recovered.privateMiB - baseline.privateMiB : null,
        ownedProcessCounts: samples.map(({ processCount }) => processCount),
        closedIdleCpuPercent: cpuPercent(baselineA, baseline),
        finalClosedCpuPercent: cpuPercent(closed.at(-1), recovered),
      }, notes: [
        'Fresh disposable offline profile and workspace; no user files or installed application were touched.',
        windows ? 'Windows RSS is summed working set and private memory is summed PrivateMemorySize64 for the attributed Electron process family.'
          : 'Footprint is summed macOS phys_footprint for the owned Electron process family; RSS can double-count shared pages.',
        'The split shares the existing text model. The benchmark opens and disposes only the second editor widget.',
      ] }
  } finally { await close(session) }
})

await mkdir('performance-results', { recursive: true })
const output = `performance-results/editor-split-${values.label}-${report.timestamp.replaceAll(':', '-')}.json`
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(output)
console.log(JSON.stringify(report.summary, null, 2))
