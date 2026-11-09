import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { median } from './benchmark-resource-metrics.mjs'
import {
  artifact, atPath, close, createProject, editorShows, launch, openFolder,
  resourceSnapshot, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  label: { type: 'string', default: 'candidate' },
  mode: { type: 'string', default: 'same' },
  rounds: { type: 'string', default: '8' },
  trials: { type: 'string', default: '1' },
  'idle-ms': { type: 'string', default: '10000' },
  'open-ms': { type: 'string', default: '200' },
  help: { type: 'boolean' },
} })
if (values.help) {
  console.log('node scripts/benchmark-editor-residency.mjs [--target dist] [--label candidate] [--mode same|distinct] [--rounds 8] [--trials 1] [--idle-ms 10000] [--open-ms 200]')
  process.exit(0)
}

assert.equal(process.platform, 'darwin', 'Use macOS process accounting for this diagnostic.')
assert.match(values.label, /^[\w-]+$/, 'Label may contain letters, numbers, dashes, and underscores.')
assert.match(values.mode, /^(same|distinct)$/, 'Use --mode same or --mode distinct.')
const count = (key, max) => {
  const value = Number(values[key])
  assert.ok(Number.isInteger(value) && value > 0 && value <= max, `--${key} must be between 1 and ${max}.`)
  return value
}
const rounds = count('rounds', 100)
const trials = count('trials', 20)
const idleMs = count('idle-ms', 300_000)
const openMs = count('open-ms', 60_000)
const settleMs = 200
const execute = promisify(execFile)
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use production bundles with the Electron test harness.')
const timestamp = new Date().toISOString()
const output = `performance-results/editor-residency-${values.label}-${values.mode}-${timestamp.replaceAll(':', '-')}.json`
const probeSource = fileURLToPath(new URL('./benchmark-resources-probe.c', import.meta.url))
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

async function sampleProcesses(session, probe) {
  const sample = await resourceSnapshot(session, { details: true })
  const { stdout } = await execute(probe, sample.members.map(({ pid }) => String(pid)))
  const kernel = new Map(stdout.trim().split('\n').filter(Boolean).map((row) => {
    const [pid, footprintBytes, cpuNs] = row.split(' ').map(Number)
    return [pid, { footprintBytes, cpuNs }]
  }))
  const members = sample.members.map((member) => ({ ...member, ...kernel.get(member.pid) }))
  const renderers = members.filter(({ kind }) => kind === 'renderer')
  assert.ok(renderers.length, 'The editor renderer is still running.')
  const footprint = (processes) => processes.every(({ footprintBytes }) => Number.isFinite(footprintBytes))
    ? processes.reduce((sum, { footprintBytes }) => sum + footprintBytes, 0) : null
  return {
    timeMs: sample.timeMs,
    rssMiB: sample.rssMiB,
    rendererRssMiB: renderers.reduce((sum, { rssMiB }) => sum + rssMiB, 0),
    footprintBytes: footprint(members),
    rendererFootprintBytes: footprint(renderers),
    members,
  }
}

function cpuMs(before, after) {
  const byPid = new Map(before.members.map(({ pid, cpuNs }) => [pid, cpuNs]))
  if (byPid.size !== after.members.length) return null
  let total = 0
  for (const { pid, cpuNs } of after.members) {
    const previous = byPid.get(pid)
    if (!Number.isFinite(previous) || !Number.isFinite(cpuNs) || cpuNs < previous) return null
    total += cpuNs - previous
  }
  return total / 1e6
}

async function writeSources(directory) {
  const sources = []
  for (let index = 1; index <= (values.mode === 'same' ? 1 : rounds); index++) {
    const number = String(index).padStart(3, '0')
    const name = values.mode === 'same' ? 'large-source.c' : `large-source-${number}.c`
    const marker = values.mode === 'same' ? 'ION-EDITOR-RESIDENCY' : `ION-EDITOR-FILE${number}XX`
    const comment = values.mode === 'same' ? 'fixture' : `file${number}`
    const contents = `/* ${marker} */\n` + Array.from({ length: 28_000 }, (_, line) =>
      `static const unsigned item_${line} = ${line}u; /* ${comment} */\n`).join('')
    const path = join(directory, name)
    const bytes = Buffer.byteLength(contents)
    assert.equal(bytes, 1_573_807, 'Both workloads use the original fixture size.')
    await writeFile(path, contents)
    sources.push({ path, marker, bytes })
  }
  return sources
}

async function openEditor(page, path, marker) {
  const start = performance.now()
  await atPath(page, 'explorer-entry', path).click()
  await atPath(page, 'tab', path).waitFor()
  const ready = await editorShows(page, marker)
  const elapsed = performance.now() - start
  await ready.dispose()
  return elapsed
}

async function trial(scratch, probe, number) {
  const project = await createProject(join(scratch, `large source project ${number}`), { fileCount: 0 })
  const sources = await writeSources(project.directory)
  const session = await launch(target, join(scratch, `profile-${number}`))
  const { app, page } = session
  const checkpoints = []
  let cdp
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    cdp = await page.context().newCDPSession(page)
    const record = async (name, actionMs, waitMs = settleMs) => {
      await sleep(waitMs)
      const [heap, dom, processes] = await Promise.all([
        cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters'), sampleProcesses(session, probe),
      ])
      const sample = { name, actionMs, ...processes, heap, dom }
      checkpoints.push(sample)
      return sample
    }
    await openFolder(page, project)
    const tiny = await record('tiny file open', await openEditor(page, project.program, '#include'))
    const opens = []
    const closes = []
    for (let round = 1; round <= rounds; round++) {
      const { path, marker } = sources[values.mode === 'same' ? 0 : round - 1]
      opens.push(await record(`large file open ${round}`, await openEditor(page, path, marker), openMs))
      const start = performance.now()
      await atPath(page, 'close-tab', path).click()
      const ready = await editorShows(page, '#include')
      const elapsed = performance.now() - start
      await ready.dispose()
      closes.push(await record(`large file closed ${round}`, elapsed))
    }
    const last = closes.at(-1)
    const idle = await record('after natural idle', null, idleMs)
    const idleCpu = cpuMs(last, idle)
    await cdp.send('HeapProfiler.collectGarbage')
    const diagnostic = await record('after diagnostic renderer GC', null)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    const workload = [tiny, ...opens, ...closes]
    const footprintSamples = workload.map(({ footprintBytes }) => footprintBytes).filter(Number.isFinite)
    return {
      number, largeBytes: sources[0].bytes, startupMs: session.startupMs, checkpoints,
      summary: {
        workloadPeakRssMiB: Math.max(...workload.map(({ rssMiB }) => rssMiB)),
        workloadPeakRendererRssMiB: Math.max(...workload.map(({ rendererRssMiB }) => rendererRssMiB)),
        workloadPeakFootprintBytes: footprintSamples.length === workload.length ? Math.max(...footprintSamples) : null,
        idleRssMiB: idle.rssMiB,
        idleFootprintBytes: idle.footprintBytes,
        diagnosticRssMiB: diagnostic.rssMiB,
        diagnosticFootprintBytes: diagnostic.footprintBytes,
        firstOpenMs: opens[0].actionMs,
        medianOpenMs: median(opens.map(({ actionMs }) => actionMs)),
        medianCloseMs: median(closes.map(({ actionMs }) => actionMs)),
        workloadCpuMs: cpuMs(tiny, last),
        idleCpuPercentOfOneCore: idleCpu === null ? null : 100 * idleCpu / (idle.timeMs - last.timeMs),
      },
    }
  } finally {
    await cdp?.detach().catch(() => {})
    await close(session)
  }
}

const report = await withScratch('editor-residency', async (scratch) => {
  const probe = join(scratch, 'rusage')
  await execute('/usr/bin/clang', ['-O2', '-std=c11', probeSource, '-o', probe])
  const host = async (path, ...args) => (await execute(path, args)).stdout.trim()
  const [macOS, processor, ramBytes, mainSha256, rendererHtmlSha256] = await Promise.all([
    host('/usr/bin/sw_vers'),
    host('/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'),
    host('/usr/sbin/sysctl', '-n', 'hw.memsize'),
    sha256(target.args[0]),
    sha256(join(dirname(target.args[0]), '../renderer/index.html')),
  ])
  const runs = []
  for (let number = 1; number <= trials; number++) runs.push(await trial(scratch, probe, number))
  return {
    timestamp, target: basename(target.path), label: values.label, mode: values.mode, rounds, settleMs, openMs, idleMs,
    artifact: { mainSha256, rendererHtmlSha256 },
    host: { macOS, processor, ramBytes: Number(ramBytes), arch: process.arch, node: process.version },
    notes: {
      workload: 'Synthetic files and a fresh disposable offline profile per trial. No terminal or viewers.',
      timing: 'Elapsed wall time from automation issuing the click to the expected text visible in Monaco.',
      rss: 'Sum of the same process-family resident sets. Shared pages may be counted more than once.',
      footprint: 'Sum of macOS kernel phys_footprint charges for the process family.',
      cpu: 'Kernel user and system CPU time for a stable process family. Workload CPU includes checkpoint settling.',
      diagnostic: 'Forced renderer GC runs only after the natural idle checkpoint. It is excluded from workload metrics.',
    },
    trials: runs,
  }
})
await mkdir('performance-results', { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(output)
console.table(report.trials.map(({ number, summary }) => ({ trial: number, ...summary })))
