import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, close, launch, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { baseline: { type: 'string' }, target: { type: 'string', default: 'dist' },
  trials: { type: 'string', default: '7' }, out: { type: 'string', default: 'performance-results/stabilization/startup.json' } } })
assert.ok(values.baseline)
const trials = Number(values.trials)
assert.ok(Number.isInteger(trials) && trials >= 3 && trials <= 20)
const builds = { baseline: await artifact(values.baseline), candidate: await artifact(values.target) }
const report = { complete: false, host: { platform: process.platform, arch: process.arch,
  release: release(), cpu: cpus()[0]?.model, ramBytes: totalmem() },
protocol: { trials, launch: 'Fresh process to Welcome DOM, then same-profile warm launch. OS caches retained. Alternating order per pair. Hidden disposable Minimal Mode profiles.' },
builds: {}, samples: [] }
for (const [name, build] of Object.entries(builds)) {
  report.builds[name] = createHash('sha256').update(await readFile(join(build.path, 'main/index.cjs'))).digest('hex')
}
await withScratch('stabilization-startup', async scratch => {
  for (let pair = 0; pair < trials; pair++) {
    for (const label of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const profile = join(scratch, label + '-' + pair)
      await mkdir(profile)
      await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: {
        resourceProfile: 'minimal', autoSave: false, showOutput: true, openFullScreen: false,
      } }))
      const fresh = await launch(builds[label], profile)
      await close(fresh)
      const warm = await launch(builds[label], profile)
      await close(warm)
      assert.deepEqual(fresh.errors, [])
      assert.deepEqual(warm.errors, [])
      report.samples.push({ label, pair, freshMs: fresh.startupMs, warmMs: warm.startupMs })
    }
  }
})
report.complete = true
await mkdir(dirname(resolve(values.out)), { recursive: true })
await writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
console.log(values.out)
