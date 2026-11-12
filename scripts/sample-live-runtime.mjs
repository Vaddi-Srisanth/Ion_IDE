#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir, arch, cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import { ProcessFamily, parseProcessRows, parseIdentities, parseProbe, completeSnapshot,
  applyCpuDelta, summarize, csvHeader, csvRow, markdownReport, htmlReport, safeScenario,
  printable, applicationName, usableResourceSample, nativePsLocale, nativePsEnvironment } from './live-runtime-metrics.mjs'

const runFile = promisify(execFile)
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const help = `Usage: node scripts/sample-live-runtime.mjs --pid MAIN_PID [options]

Observe an already-running packaged Ion IDE on macOS. Never launches or changes Ion.
  --seconds N             Capture duration, 5–1800 seconds (default: 120)
  --interval-ms N         Sampling interval, 500–10000 ms (default: 1000)
  --label TEXT            Baseline/candidate or descriptive label (default: live-runtime)
  --scenario TEXT         Initial workload marker (default: current-workload)
  --profile PATH          Exact profile path for reparented same-bundle Chromium helpers
  --interactive-markers   Enter a workload marker on stdin while sampling
  --out PATH              Output parent directory (default: performance-results/runtime)
  --probe PATH            Existing compiled benchmark-resources-probe, optional
  --help                  Show this help

At most 1800 samples; the command stops on Ctrl+C or when Ion exits. It never stops
Ion or its programs. Live console and latest.json update during capture. Final
capture.json, CSV, NDJSON, report.md and an offline report.html remain on disk.
This does not measure typing latency, startup, actual GPU utilization or FPS.
`

export function parseOptions(argv) {
  const result = { seconds: 120, intervalMs: 1000, label: 'live-runtime', scenario: 'current-workload',
    out: resolve('performance-results/runtime'), interactiveMarkers: false }
  const values = { '--pid': 'pid', '--seconds': 'seconds', '--interval-ms': 'intervalMs', '--label': 'label',
    '--scenario': 'scenario', '--out': 'out', '--profile': 'profile', '--probe': 'probe' }
  const seen = new Set()
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--help') return { help: true }
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`)
    seen.add(flag)
    if (flag === '--interactive-markers') { result.interactiveMarkers = true; continue }
    const name = values[flag]
    if (!name || index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`Invalid option or missing value: ${flag}`)
    result[name] = argv[++index]
  }
  for (const name of ['pid', 'seconds', 'intervalMs']) result[name] = Number(result[name])
  if (!Number.isSafeInteger(result.pid) || result.pid <= 0) throw new Error('--pid must identify the running packaged Ion main process.')
  if (!Number.isInteger(result.seconds) || result.seconds < 5 || result.seconds > 1800) throw new Error('--seconds must be an integer from 5 to 1800.')
  if (!Number.isInteger(result.intervalMs) || result.intervalMs < 500 || result.intervalMs > 10000) throw new Error('--interval-ms must be an integer from 500 to 10000.')
  if (Math.ceil(result.seconds * 1000 / result.intervalMs) + 1 > 1800) throw new Error('Capture exceeds the 1800-sample limit; increase the interval or reduce the duration.')
  result.label = safeScenario(result.label)
  result.scenario = safeScenario(result.scenario)
  for (const name of ['out', 'profile', 'probe']) if (result[name]) result[name] = resolve(result[name])
  return result
}

async function command(file, args, { allowMissingProcess = false, timeout = 5000 } = {}) {
  try {
    return (await runFile(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2, timeout,
      env: nativePsEnvironment() })).stdout
  } catch (error) {
    // ps exits 1 when none of the specifically requested processes still exist.
    if (allowMissingProcess && error.code === 1) return error.stdout || ''
    throw new Error(`${file.split('/').at(-1)} measurement failed: ${error.message}`, { cause: error })
  }
}

export async function verifyNativeLocale() {
  const output = (await runFile('/usr/bin/locale', ['-a'], { encoding: 'utf8', maxBuffer: 64 * 1024,
    timeout: 5000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })).stdout
  if (!output.split(/\r?\n/).includes(nativePsLocale)) {
    throw new Error(`Required macOS locale ${nativePsLocale} is unavailable; Unicode-safe process sampling cannot proceed.`)
  }
  return nativePsLocale
}

async function processRows() {
  return parseProcessRows(await command('/bin/ps', ['-axww', '-o', 'pid=,ppid=,rss=,lstart=,command=']))
}

async function optional(file, args) {
  try { return (await command(file, args)).trim() } catch { return null }
}

async function metadata(family) {
  const [version, os, processor, ram, power] = await Promise.all([
    optional('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleShortVersionString', join(family.bundle, 'Contents/Info.plist')]),
    optional('/usr/bin/sw_vers', []), optional('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
    optional('/usr/sbin/sysctl', ['-n', 'hw.memsize']), optional('/usr/bin/pmset', ['-g', 'batt'])
  ])
  return { application: { name: applicationName(family.bundle), version },
    host: { arch: arch(), processor, logicalCpus: cpus().length, ramBytes: ram ? Number(ram) : null,
      os, powerSource: power?.split('\n')[0] ?? null } }
}

async function atomicJson(path, data) {
  const temporary = path + '.tmp'
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

const method = [
  'An explicit already-running packaged Ion main PID and its ps launch-time identity anchor ownership. Descendants and previously observed surviving descendants are included. With --profile, exact same-bundle Chromium helpers with that exact profile are also included. Known bundle/profile paths permit macOS canonically equivalent Unicode spellings; option and directory boundaries remain exact. Other Ion instances and unrelated processes are excluded. ps uses verified en_US.UTF-8 and UTC so paths remain Unicode and launch dates remain English.',
  'The macOS production application is observed without launching, focusing, changing or terminating it. This command performs no network requests, installs no services, and stops sampling when it exits. Capture files are local and include no document content or command-line arguments.',
  'Summed RSS is ps resident size, summed over the selected process family. Shared resident pages can be counted in several processes. Attributed footprint is the sum of macOS proc_pid_rusage ri_phys_footprint counters using benchmark-resources-probe.c; it is a separate metric, not an interchangeable RAM estimate.',
  'Main, renderer, GPU helper, utility, Crashpad and native-child memory are separated by process ownership and Chromium role. GPU-helper footprint is not actual GPU utilization, dedicated VRAM, frame rate or render latency.',
  'CPU is the delta of native user+system counters for the same PID and launch identity in adjacent samples, divided by actual monotonic elapsed time. 100% is one fully busy logical CPU core, and multithreaded activity can exceed 100%. The first sample has no CPU delta.',
  'Observed-process CPU can miss newly spawned or short-lived children between probes. Reaped-child CPU deltas are recorded separately for the main process but never added to the process-tree CPU total, which could double-count previously sampled children. Use targeted execution instrumentation to measure very short commands.',
  'ps launch timestamps have one-second resolution. A second narrow ps identity check after the native probe discards vanished or recycled PIDs; no external sampler can remove every possible sub-second process-identity race. A footprint total is omitted if any selected PID lacks a stable native reading.',
  'Snapshots are sequential observations, not an atomic kernel-wide sample. Observer duration is measured. The observer and its short-lived ps/native-probe processes are excluded from Ion totals, but their system overhead can perturb results. Keep comparison workloads, window size, scaling, power, profile and host load matched.',
  'Samples with an exited main process or empty owned process family remain in raw evidence as lifecycle events. They are excluded from running-application resource summaries and charts. Application exit is never reported as a zero-MiB idle-memory improvement.',
  'This report measures only the recorded workload and time window. Startup time, typing/input latency, scrolling latency, tab-switch latency, JavaScript heap and GPU hardware utilization are not measured by this PID-only sampler. A finalized capture is historical evidence; latest.json is refreshed only while this explicit command runs.'
]

export async function capture(options) {
  if (process.platform !== 'darwin') throw new Error('This native footprint sampler requires macOS. Windows measurements need a native Windows collector.')
  await verifyNativeLocale()
  if (options.profile) options.profile = await realpath(options.profile)
  const root = (await processRows()).find(row => row.pid === options.pid)
  if (!root) throw new Error('The selected main PID is no longer running.')
  const family = new ProcessFamily(root, options.profile)
  let temporaryProbeDirectory
  let probe = options.probe
  let captureDirectory
  let readline
  let stopReason
  let failure
  let wake
  const requestStop = reason => { stopReason ??= reason; wake?.() }
  const interrupt = () => requestStop('interrupted-by-user')
  const terminate = () => requestStop('observer-terminated')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    if (!probe) {
      temporaryProbeDirectory = await mkdtemp(join(tmpdir(), 'ion-live-resources-'))
      probe = join(temporaryProbeDirectory, 'probe')
      await command('/usr/bin/xcrun', ['clang', '-O2', '-std=c11', join(scriptDirectory, 'benchmark-resources-probe.c'), '-o', probe], { timeout: 60000 })
    }
    const info = await metadata(family)
    const filenameLabel = options.label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 48) || 'capture'
    captureDirectory = join(options.out, `runtime-${filenameLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
    await mkdir(options.out, { recursive: true })
    await mkdir(captureDirectory, { mode: 0o700 })
    await writeFile(join(captureDirectory, 'samples.csv'), csvHeader, { mode: 0o600 })
    await writeFile(join(captureDirectory, 'samples.ndjson'), '', { mode: 0o600 })
    const startedAt = new Date().toISOString()
    const start = performance.now()
    let scenario = options.scenario
    const markers = [{ elapsedMs: 0, timestamp: startedAt, label: scenario }]
    if (options.interactiveMarkers) {
      readline = createInterface({ input: process.stdin, crlfDelay: Infinity })
      readline.on('line', line => {
        if (!line.trim() || markers.length >= 1000) return
        scenario = safeScenario(line)
        markers.push({ elapsedMs: performance.now() - start, timestamp: new Date().toISOString(), label: scenario })
      })
    }
    const samples = []
    let rawBytes = 0
    let target = start
    console.log(`Observing Ion ${info.application.version ?? 'unknown'} PID ${root.pid}. Output: ${captureDirectory}`)
    console.log('Footprint and RSS are different memory measures. CPU 100% = one logical core. Ctrl+C stops only the observer.')
    try {
      while (!stopReason) {
        const sampleStart = performance.now()
        const selection = family.select(await processRows())
        const pids = selection.members.map(row => String(row.pid))
        const native = pids.length ? parseProbe(await command(probe, pids)) : new Map()
        const identities = pids.length ? parseIdentities(await command('/bin/ps', ['-ww', '-p', pids.join(','), '-o', 'pid=,lstart='], { allowMissingProcess: true })) : new Map()
        const sampleEnd = performance.now()
        const sample = completeSnapshot(family, selection, native, identities, { timestamp: new Date().toISOString(),
          monotonicMs: (sampleStart + sampleEnd) / 2, elapsedMs: (sampleStart + sampleEnd) / 2 - start,
          observerDurationMs: sampleEnd - sampleStart, scenario })
        applyCpuDelta(samples.at(-1), sample)
        const row = JSON.stringify(sample) + '\n'
        const csv = csvRow(sample)
        rawBytes += Buffer.byteLength(row) + Buffer.byteLength(csv)
        if (rawBytes > 32 * 1024 ** 2) { requestStop('output-size-limit'); break }
        samples.push(sample)
        await appendFile(join(captureDirectory, 'samples.ndjson'), row)
        await appendFile(join(captureDirectory, 'samples.csv'), csv)
        await atomicJson(join(captureDirectory, 'latest.json'), { live: true, finalized: false, ...sample })
        console.log(usableResourceSample(sample)
          ? `${sample.timestamp}  ${printable(sample.elapsedMs / 1000, 1)}s  footprint ${printable(sample.footprintMiB)} MiB  RSS ${printable(sample.rssMiB)} MiB  CPU ${printable(sample.cpuPercentOneCore)}%  ${sample.members.length} processes  [${sample.scenario}]`
          : `${sample.timestamp}  Application exited or owned process family is empty; terminal event excluded from resource statistics.`)
        if (!sample.rootAlive) { requestStop('application-exited'); break }
        if (sampleEnd - start >= options.seconds * 1000) { requestStop('duration-reached'); break }
        if (samples.length >= 1800) { requestStop('sample-count-limit'); break }
        target += options.intervalMs
        if (target < performance.now()) target = performance.now() + options.intervalMs
        target = Math.min(target, start + options.seconds * 1000)
        await new Promise(resolveWait => {
          const timer = setTimeout(() => { wake = undefined; resolveWait() }, Math.max(0, target - performance.now()))
          wake = () => { clearTimeout(timer); wake = undefined; resolveWait() }
        })
      }
    } catch (error) {
      failure = error
      requestStop('measurement-error')
    }
    const report = { schemaVersion: 1, label: options.label, complete: stopReason === 'duration-reached',
      finalized: true, stopReason, startedAt, endedAt: new Date().toISOString(), elapsedSeconds: (performance.now() - start) / 1000,
      requestedSeconds: options.seconds, intervalMs: options.intervalMs, root: family.root, ...info,
      samples, markers, summary: summarize(samples), method, ...(failure ? { error: failure.message } : {}) }
    await atomicJson(join(captureDirectory, 'capture.json'), report)
    await writeFile(join(captureDirectory, 'report.md'), markdownReport(report), { mode: 0o600 })
    await writeFile(join(captureDirectory, 'report.html'), htmlReport(report), { mode: 0o600 })
    await atomicJson(join(captureDirectory, 'latest.json'), { live: false, finalized: true, complete: report.complete,
      stopReason, ...(samples.at(-1) ?? {}), endedAt: report.endedAt })
    console.log(`${report.complete ? 'Completed' : 'Ended early'}: ${stopReason}. ${samples.length} actual samples.`)
    console.log(`Offline report: ${join(captureDirectory, 'report.html')}`)
    if (failure) throw failure
    return { captureDirectory, report }
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
    readline?.close()
    if (options.interactiveMarkers) process.stdin.pause()
    if (temporaryProbeDirectory) await rm(temporaryProbeDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) console.log(help)
    else await capture(options)
  } catch (error) {
    console.error(`Runtime capture failed: ${error.message}`)
    process.exitCode = 1
  }
}
