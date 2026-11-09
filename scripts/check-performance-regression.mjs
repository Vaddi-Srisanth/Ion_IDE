import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { extendedResourceMetrics, median } from './benchmark-resource-metrics.mjs'

const { values } = parseArgs({ options: {
  'baseline-report': { type: 'string', multiple: true },
  'candidate-report': { type: 'string', multiple: true },
  help: { type: 'boolean' },
} })
if (values.help) {
  console.log('node scripts/check-performance-regression.mjs --baseline-report baseline.json --candidate-report candidate.json [repeat either option for matched observations]')
  process.exit(0)
}
assert.ok(values['baseline-report']?.length && values['candidate-report']?.length, 'Supply baseline and candidate reports.')

async function readReports(paths) {
  const reports = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))))
  assert.equal(new Set(reports.map(({ timestamp }) => timestamp)).size, reports.length, 'Use independent observations within each group.')
  for (const report of reports) {
    assert.ok(report.schemaVersion === 1 && report.mode === 'workload' && report.summary && report.extended && !report.error,
      'A completed resource workload report is required.')
    assert.ok(report.protocol.launches >= 5 && report.protocol.idleSeconds >= 10
      && report.protocol.optionalCycles >= 6 && report.protocol.executions >= 4 && report.protocol.extendedRounds >= 11,
    'Use at least five launches, ten idle seconds, six panel cycles, four executions and eleven extended rounds.')
    assert.equal(report.lastWindowClose?.appExited, true, 'Minimal mode must release its last-window process tree.')
    assert.equal(report.extended.rounds.length, report.protocol.extendedRounds, 'All extended rounds must complete.')
    assert.equal(report.artifact.mainSha256, reports[0].artifact.mainSha256, 'Use the same build within each group.')
    assert.equal(report.artifact.rendererHtmlSha256, reports[0].artifact.rendererHtmlSha256, 'Use the same renderer within each group.')
    Object.assign(report.summary, extendedResourceMetrics(report.extended, report.summary.extendedCpuPercent))
  }
  return reports
}

const [baseline, candidate] = await Promise.all([
  readReports(values['baseline-report']), readReports(values['candidate-report']),
])
const reference = baseline[0]
for (const report of [...baseline, ...candidate]) {
  assert.deepEqual(report.protocol, reference.protocol, 'Benchmark options must match.')
  assert.equal(report.extended.largeBytes, reference.extended.largeBytes, 'Large source fixture size must match.')
  assert.equal(report.artifact.runtime, reference.artifact.runtime, 'Electron and Chromium versions must match.')
  for (const key of ['macOS', 'processor', 'ramBytes', 'arch', 'node', 'power']) {
    assert.equal(report.host[key], reference.host[key], `Benchmark host ${key} must match.`)
  }
}

// Allow room for the measured launch jitter and one or two desktop frame periods.
// Values are in the reported unit, including percentage points for CPU.
const budgets = {
  freshMs: [50, 0.12],
  warmMs: [50, 0.12],
  idleRssMiB: [12, 0.03],
  idleFootprintMiB: [12, 0.08],
  idleCpuPercent: [0.5, 0],
  firstFileMs: [40, 0.20],
  otherFileMs: [20, 0.20],
  typingMs: [12, 0.15],
  runMs: [60, 0.20],
  firstLargeMs: [70, 0.20],
  largeReopenMs: [45, 0.20],
  largeFileRssMiB: [24, 0.05],
  rotatingTabSwitchMs: [25, 0.20],
  cachedTabSwitchMs: [25, 0.20],
  extendedRunMs: [60, 0.20],
  stopMs: [55, 0.25],
  extendedRssGrowthMiB: [18, 0.25],
  extendedPostWarmRssGrowthMiB: [16, 0.25],
  extendedRssPeakMiB: [28, 0.05],
  extendedTreeCpuPercent: [10, 0.25],
  ...Object.fromEntries(['oneCFile', 'tenTabs', 'mediumProject'].map((stage) => [`${stage}RssMiB`, [24, 0.05]])),
  ...Object.fromEntries(['learn', 'projects', 'practice'].flatMap((panel) => [
    [`${panel}FirstMs`, [35, 0.25]],
    [`${panel}CloseMs`, [25, 0.25]],
    [`${panel}ReopenMs`, [25, 0.25]],
  ])),
}
const footprint = ['largeFile', 'oneCFile', 'tenTabs', 'mediumProject', 'learn', 'projects', 'practice']
  .map((stage) => `${stage}FootprintMiB`)
const round = (value) => Number(value.toFixed(2))

function compare(metric, [floor, fraction], volatile = false) {
  const read = (reports) => reports.map(({ summary }) => summary[metric])
  const baselineValues = read(baseline)
  const candidateValues = read(candidate)
  const available = [...baselineValues, ...candidateValues].every(Number.isFinite)
  if (!available && volatile) return { metric, result: 'unavailable' }
  assert.ok(available, `Missing required measurement: ${metric}`)
  const before = median(baselineValues)
  const after = median(candidateValues)
  const spread = Math.max(...baselineValues) - Math.min(...baselineValues)
  const limit = before + Math.max(floor, Math.abs(before) * fraction, 2 * spread)
  const comparable = baseline.length >= 2 && candidate.length >= 2
  let result = after > limit ? 'regression' : 'pass'
  if (volatile && (!comparable || (result === 'regression' && candidateValues.some((sample) => sample <= limit)))) {
    result = 'advisory'
  }
  return { metric, baseline: round(before), candidate: round(after), limit: round(limit), result }
}

const comparison = [
  ...Object.entries(budgets).map(([metric, budget]) => compare(metric, budget)),
  ...footprint.map((metric) => compare(metric, [24, 0.10], true)),
]
console.table(comparison)
if (comparison.some(({ result }) => result === 'advisory')) {
  console.log('Active footprint needs two matching observations per build and a repeated exceedance before it fails the gate.')
}
if (comparison.some(({ result }) => result === 'regression')) process.exitCode = 1
