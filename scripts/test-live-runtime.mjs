import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ProcessFamily, parseProcessRows, parseIdentities, parseProbe, completeSnapshot,
  applyCpuDelta, statistics, summarize, csvRow, markdownReport, htmlReport, safeScenario, usableResourceSample,
  nativePsEnvironment } from './live-runtime-metrics.mjs'
import { parseOptions, verifyNativeLocale } from './sample-live-runtime.mjs'

const bundle = '/Applications/Ion IDE.app'
const started = 'Thu Nov 12 07:20:11 2026'
const later = 'Thu Nov 12 07:20:12 2026'
const row = (pid, parent, command, start = started) => ({ pid, parent, command, started: start, rssMiB: 10 })
const root = () => row(100, 1, bundle + '/Contents/MacOS/Ion IDE')
const helper = (pid, parent, flags = '') => row(pid, parent, bundle + '/Contents/Frameworks/Ion IDE Helper.app/Contents/MacOS/Ion IDE Helper ' + flags)
const nativeSample = (pid, cpu = '1000000000', children = '0') => `${pid} 10485760 ${cpu} ${children} 2`

test('ps parser preserves spaced bundle paths and normalizes launch identities', () => {
  const parsed = parseProcessRows(` 100 1 20480 Thu Nov 12 07:20:11 2026 ${bundle}/Contents/MacOS/Ion IDE\n 101 100 10240 Thu Nov  2 07:20:11 2026 /bin/zsh -l\ninvalid`)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].command, root().command)
  assert.equal(parsed[0].rssMiB, 20)
  assert.equal(parsed[1].started, 'Thu Nov 2 07:20:11 2026')
  assert.equal(parseIdentities('  100 Thu Nov 12 07:20:11 2026\n').get(100), started)
})

test('family ownership includes descendants, retains surviving children, and rejects recycled PIDs', () => {
  const family = new ProcessFamily(root())
  const shell = row(102, 101, '/bin/zsh -l')
  const renderer = helper(101, 100, '--type=renderer')
  const selection = family.select([root(), renderer, shell, row(700, 1, '/bin/unrelated')])
  assert.deepEqual(selection.members.map(member => member.pid), [100, 101, 102])
  assert.equal(family.kind(shell), 'native-child')
  assert.equal(family.kind(renderer), 'renderer')
  assert.deepEqual(family.select([root(), { ...shell, parent: 1 }]).members.map(member => member.pid), [100, 102])
  const recycled = family.select([row(100, 1, '/bin/unrelated', later), row(102, 1, '/bin/unrelated', later), row(999, 100, '/bin/unrelated')])
  assert.equal(recycled.rootAlive, false)
  assert.equal(recycled.members.length, 0)
})

test('orphan helper discovery requires exact bundle/profile and root identity', () => {
  const profile = '/Users/test/Library/Application Support/Ion IDE'
  const family = new ProcessFamily(root(), profile)
  const valid = helper(101, 1, `--type=renderer --user-data-dir=${profile} --lang=en-US`)
  const prefix = helper(102, 1, `--type=renderer --user-data-dir=${profile}-other --lang=en-US`)
  const otherBundle = { ...helper(103, 1, `--user-data-dir=${profile}`), command: '/tmp/Other.app/Contents/Frameworks/helper --user-data-dir=' + profile }
  const fakeRole = row(104, 100, '/usr/bin/node --type=renderer')
  const selected = family.select([root(), valid, prefix, otherBundle, fakeRole])
  assert.deepEqual(selected.members.map(member => member.pid), [100, 101, 104])
  assert.equal(family.kind(fakeRole), 'native-child')
  assert.equal(new ProcessFamily(root(), profile).select([valid]).members.length, 0)
  assert.throws(() => new ProcessFamily(row(1, 0, '/usr/bin/Electron')), /packaged/)
  assert.throws(() => new ProcessFamily(helper(101, 1, '--type=renderer')), /main process/)
})

test('canonical Unicode spellings are scoped to the exact known macOS bundle/profile', () => {
  const unicodeBundle = '/Applications/Ion café 学习.app'
  const unicodeRoot = row(100, 1, unicodeBundle + '/Contents/MacOS/Ion IDE')
  const profile = '/Users/test/Library/Application Support/Ion café 学习'
  const family = new ProcessFamily(unicodeRoot, profile)
  const command = unicodeBundle.normalize('NFD') + '/Contents/Frameworks/Ion Helper --type=renderer --user-data-dir=' + profile.normalize('NFD')
  const valid = row(101, 1, command)
  const prefix = row(102, 1, command + '-other')
  const different = row(103, 1, command.replace('/Applications/', '/Unrelated/'))
  assert.deepEqual(family.select([unicodeRoot, valid, prefix, different]).members.map(member => member.pid), [100, 101])
  assert.equal(family.kind(valid), 'renderer')
})

test('native macOS ps preserves real Unicode arguments and English UTC launch identities', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(await verifyNativeLocale(), 'en_US.UTF-8')
  const args = ['ION-NFC-café-学习', 'ION-NFD-café-学习'.normalize('NFD')]
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()', '--', ...args], { stdio: ['pipe', 'ignore', 'ignore'] })
  const closed = once(child, 'close')
  try {
    await once(child, 'spawn')
    const { stdout } = await promisify(execFile)('/bin/ps', ['-ww', '-p', String(child.pid), '-o', 'pid=,ppid=,rss=,lstart=,command='],
      { encoding: 'utf8', env: nativePsEnvironment(), timeout: 3000 })
    const [actual] = parseProcessRows(stdout)
    assert.equal(actual?.pid, child.pid)
    for (const argument of args) assert.ok(actual.command.includes(argument), 'ps escaped or lost a real Unicode argument.')
    assert.match(actual.started, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} /)
  } finally {
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await closed
  }
})

test('native readings require stable process identities after probing', () => {
  const family = new ProcessFamily(root())
  const selection = family.select([root(), helper(101, 100, '--type=renderer')])
  const probes = parseProbe(nativeSample(100) + '\n' + nativeSample(101))
  const sample = completeSnapshot(family, selection, probes, new Map([[100, started], [101, later]]), { monotonicMs: 1000 })
  assert.equal(sample.footprintMiB, null)
  assert.equal(sample.missingProbeProcesses, 1)
  assert.equal(sample.roles.main.footprintMiB, 10)
  assert.equal(sample.roles.renderer.footprintMiB, null)
  assert.equal(sample.members[1].measured, false)
  assert.equal(sample.rssMiB, 20)
  assert.equal(sample.rootAlive, true)
})

test('CPU uses precise native deltas, real elapsed time and matching start identities', () => {
  const family = new ProcessFamily(root())
  const rows = [root(), helper(101, 100, '--type=renderer')]
  const selection = family.select(rows)
  const identities = new Map(rows.map(member => [member.pid, member.started]))
  const snapshot = (time, main, renderer, reaped = '0') => completeSnapshot(family, selection,
    parseProbe(nativeSample(100, main, reaped) + '\n' + nativeSample(101, renderer)), identities, { monotonicMs: time })
  const before = snapshot(1000, '900000000000000001', '2000000000')
  const after = snapshot(2000, '900000000500000001', '3500000000', '100000000')
  applyCpuDelta(before, after)
  assert.equal(after.cpuPercentOneCore, 200)
  assert.equal(after.roles.main.cpuPercentOneCore, 50)
  assert.equal(after.roles.renderer.cpuPercentOneCore, 150)
  assert.equal(after.reapedChildCpuPercentOneCore, 10)
  assert.equal(after.cpuComparedProcesses, 2)
  after.members.forEach(member => { member.started = later })
  applyCpuDelta(before, after)
  assert.equal(after.cpuPercentOneCore, null)
})

test('stats omit unreliable small-sample p95 and weight observed CPU by actual intervals', () => {
  assert.equal(statistics([1, 2, null]).p95, null)
  assert.equal(statistics(Array.from({ length: 20 }, (_, index) => index + 1)).p95, 19)
  const samples = [{ rootAlive: true, members: [{}], rssMiB: 10, footprintMiB: null, cpuPercentOneCore: null, observerDurationMs: 2, roles: {} },
    { rootAlive: true, members: [{}], rssMiB: 20, footprintMiB: 8, cpuPercentOneCore: 10, cpuIntervalMs: 1000, observerDurationMs: 2, roles: {} },
    { rootAlive: true, members: [{}], rssMiB: 30, footprintMiB: 9, cpuPercentOneCore: 50, cpuIntervalMs: 3000, observerDurationMs: 2, roles: {} }]
  assert.equal(summarize(samples).cpuPercentOneCore.weightedMean, 40)
  assert.equal(summarize(samples).footprintMiB.count, 2)
})

test('report artifacts encode untrusted labels and contain a valid standalone offline chart', () => {
  const sample = { timestamp: '2026-11-12T07:20:11.000Z', elapsedMs: 1000, scenario: '</script><img src=x onerror=alert(1)>',
    rootAlive: true, footprintMiB: 10, rssMiB: 20, cpuPercentOneCore: null, observerDurationMs: 5, members: [{}], roles: {} }
  const report = { label: '<img src=x onerror=alert(1)>', samples: [sample], summary: summarize([sample]),
    complete: false, stopReason: 'application-exited', elapsedSeconds: 1, requestedSeconds: 30, intervalMs: 1000,
    startedAt: sample.timestamp, endedAt: sample.timestamp, application: { version: '0.9.6' },
    host: { arch: 'arm64', ramBytes: 8 * 1024 ** 3, os: 'macOS', processor: 'fixture' }, root: { pid: 100 },
    method: ['GPU utilization is not measured.'], markers: [{ elapsedMs: 0, label: sample.scenario }] }
  const html = htmlReport(report)
  assert.equal((html.match(/<script>/g) ?? []).length, 1)
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1)
  assert.ok(html.includes("default-src 'none'"))
  assert.ok(html.includes('\\u003c/script>'))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(!/<(?:script|link|img)[^>]+(?:src|href)=https?:/i.test(html))
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  new vm.Script(script)
  assert.match(markdownReport(report), /Capture ended early: application-exited/)
  assert.match(markdownReport(report), /1 real samples\/events/)
  assert.ok(csvRow({ ...sample, scenario: 'a,"b"\nc' }).includes('"a,""b""\nc"'))
  assert.equal(safeScenario('  a\n\tb\x00 '), 'a  b')
})

test('application exit and empty process families never become zero-RAM summary readings', () => {
  const active = { rootAlive: true, members: [{ pid: 100 }], timestamp: '2026-11-12T13:00:00Z', elapsedMs: 0,
    scenario: 'idle', footprintMiB: 184.18, rssMiB: 556, cpuPercentOneCore: null, observerDurationMs: 4,
    roles: { main: { count: 1, rssMiB: 556, footprintMiB: 184.18 } } }
  // Covers raw captures produced by the earlier sampler, where an exit event
  // contained numeric zero totals. Old evidence must also summarize correctly.
  const exited = { ...active, elapsedMs: 1000, rootAlive: false, members: [], footprintMiB: 0, rssMiB: 0,
    cpuPercentOneCore: 0, cpuIntervalMs: 1000, roles: {} }
  const summary = summarize([active, exited])
  assert.equal(summary.recordedSampleCount, 2)
  assert.equal(summary.sampleCount, 1)
  assert.equal(summary.excludedSampleCount, 1)
  assert.equal(summary.footprintMiB.median, 184.18)
  assert.equal(summary.rssMiB.median, 556)
  assert.equal(summary.cpuPercentOneCore.count, 0)
  assert.equal(summary.cpuPercentOneCore.weightedMean, null)
  assert.equal(usableResourceSample({ ...active, members: [] }), false)
  assert.equal(usableResourceSample({ ...active, rootAlive: false }), false)
  assert.equal(usableResourceSample({ ...active, rootAlive: undefined }), false)
  const empty = completeSnapshot(new ProcessFamily(root()), { rootAlive: false, members: [] }, new Map(), new Map(), { monotonicMs: 1 })
  assert.equal(empty.rssMiB, null)
  assert.equal(empty.footprintMiB, null)
  assert.equal(empty.eligibleForResourceSummary, false)
  const report = { label: 'exited capture', samples: [active, exited], summary, complete: false, stopReason: 'application-exited',
    elapsedSeconds: 1, requestedSeconds: 30, intervalMs: 1000, startedAt: active.timestamp, endedAt: active.timestamp,
    application: { version: '0.9.6' }, host: { arch: 'arm64', ramBytes: 8 * 1024 ** 3 }, root: { pid: 100 }, method: [], markers: [] }
  assert.match(markdownReport(report), /\*\*1\*\* exited\/empty events are excluded/)
  const html = htmlReport(report)
  assert.ok(!html.includes('"footprint":0'))
  assert.ok(html.includes('1 usable samples'))
  assert.ok(html.includes('184.18 MiB'))
})

test('CLI validates bounded explicit captures and stays inactive when imported or asked for help', () => {
  assert.throws(() => parseOptions([]), /--pid/)
  assert.throws(() => parseOptions(['--pid', '100', '--seconds', '0']), /--seconds/)
  assert.throws(() => parseOptions(['--pid', '100', '--seconds', '1800', '--interval-ms', '500']), /sample limit/)
  assert.throws(() => parseOptions(['--pid', '100', '--pid', '101']), /Repeated/)
  assert.deepEqual(parseOptions(['--help']), { help: true })
  assert.equal(parseOptions(['--pid', '100', '--label', 'baseline']).label, 'baseline')
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./sample-live-runtime.mjs', import.meta.url)), '--help'], { encoding: 'utf8' })
  assert.match(output, /Never launches or changes Ion/)
  assert.match(output, /does not measure typing latency/)
})
