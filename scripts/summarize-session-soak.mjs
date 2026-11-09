import assert from 'node:assert/strict'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { median } from './benchmark-resource-metrics.mjs'

const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, candidate: { type: 'string' }, out: { type: 'string' }, wait: { type: 'boolean' },
} })
assert.ok(values.baseline && values.candidate && values.out, 'Provide --baseline, --candidate, and --out paths.')
const output = resolve(values.out)

async function readCompleted(path) {
  const deadline = Date.now() + 3 * 60 * 60 * 1000
  while (true) {
    const report = JSON.parse(await readFile(path, 'utf8'))
    if (report.error) throw new Error(`${basename(path)}: ${report.error}`)
    if (report.complete) {
      assert.ok(report.soakElapsedMs >= 7_200_000 && report.soak.length > 0, 'A completed two-hour run is required.')
      return report
    }
    assert.ok(values.wait && Date.now() < deadline, `Soak report is incomplete: ${path}`)
    await sleep(30_000)
  }
}

const [before, after] = await Promise.all([readCompleted(values.baseline), readCompleted(values.candidate)])
assert.deepEqual(before.protocol, after.protocol, 'Use the same soak protocol for both runs.')
for (const key of ['macOS', 'processor', 'ramBytes', 'power']) {
  assert.equal(before.host[key], after.host[key], `The recorded host ${key} must match.`)
}

const peak = (key) => ({ soak }) => Math.max(...soak.map((sample) => sample[key]))
const end = (key) => ({ soakEnd }) => soakEnd[key]
const middle = (key) => ({ soak }) => median(soak.map((sample) => sample[key]).filter(Number.isFinite))
const rows = [
  ['Elapsed seconds', ({ soakElapsedMs }) => soakElapsedMs / 1000],
  ['Verified edit rounds', ({ soak }) => soak.length],
  ['Peak summed RSS, MiB', peak('rssMiB')],
  ['Final summed RSS, MiB', end('rssMiB')],
  ['Peak attributed footprint, MiB', peak('footprintMiB')],
  ['Final attributed footprint, MiB', end('footprintMiB')],
  ['Peak renderer heap used, MiB', peak('heapUsedMiB')],
  ['Final renderer heap used, MiB', end('heapUsedMiB')],
  ['Median tab switch, ms', middle('switchMs')],
  ['Median edit to visible text, ms', middle('editMs')],
  ['Median C run, ms', middle('runMs')],
]
const fixed = (value) => Number.isFinite(value) ? value.toFixed(2) : 'Unavailable'
const table = rows.map(([label, read]) => {
  const oldValue = read(before), newValue = read(after)
  return `| ${label} | ${fixed(oldValue)} | ${fixed(newValue)} | ${fixed(newValue - oldValue)} |`
}).join('\n')
const link = (path) => `[${basename(path)}](<${relative(resolve(output, '..'), resolve(path))}>)`
const markdown = `# Ion two-hour editor soak\n\nBoth runs finished and the process trees drained. They ran in separate disposable profiles with some overlapping wall time. Compare lifecycle trends and sampled peaks rather than treating small differences as isolated speedups. RSS can count shared mappings more than once.\n\n| Measurement | Baseline | Candidate | Change |\n| --- | ---: | ---: | ---: |\n${table}\n\n${link(values.baseline)} · ${link(values.candidate)}\n`
await writeFile(output + '.tmp', markdown)
await rename(output + '.tmp', output)
console.log(output)
