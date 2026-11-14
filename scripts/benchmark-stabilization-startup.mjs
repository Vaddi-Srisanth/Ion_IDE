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
const output = resolve(values.out)
await mkdir(dirname(output), { recursive: true })
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
const report = { complete: false, host: { platform: process.platform, arch: process.arch,
  release: release(), cpu: cpus()[0]?.model, ramBytes: totalmem() },
protocol: { trials, launch: 'Fresh process to Welcome DOM, then same-profile warm launch. OS caches retained. Alternating order per pair. Hidden disposable Minimal Mode profiles.' },
builds: {}, samples: [] }
for (const [name, build] of Object.entries(builds)) {
  report.builds[name] = createHash('sha256').update(await readFile(join(build.path, 'main/index.cjs'))).digest('hex')
}
await persist()
await withScratch('stabilization-startup', async scratch => {
  for (let pair = 0; pair < trials; pair++) {
    for (const label of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const profile = join(scratch, label + '-' + pair)
      await mkdir(profile)
      await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: {
        resourceProfile: 'minimal', autoSave: false, showOutput: true, openFullScreen: false,
      } }))
      const sample = { label, pair, complete: false, phase: 'fresh-launch' }
      report.samples.push(sample)
      await persist()
      let current, primaryError
      try {
        current = await launch(builds[label], profile)
        sample.freshMs = current.startupMs
        assert.deepEqual(current.errors, [])
        await close(current)
        assert.equal(current.appProcess.exitCode, 0)
        assert.equal(current.appProcess.signalCode, null)
        sample.freshExitVerified = true
        current = undefined
        sample.phase = 'warm-launch'
        await persist()
        current = await launch(builds[label], profile)
        sample.warmMs = current.startupMs
        assert.deepEqual(current.errors, [])
        await close(current)
        assert.equal(current.appProcess.exitCode, 0)
        assert.equal(current.appProcess.signalCode, null)
        sample.warmExitVerified = true
        current = undefined
        sample.complete = true
        sample.phase = 'complete'
      } catch (error) {
        primaryError = error
        sample.failed = true
        sample.failure = { phase: sample.phase, type: error?.name, code: error?.code ?? null }
        throw error
      } finally {
        try { if (current) await close(current) }
        catch (error) { sample.cleanupFailed = true; if (!primaryError) throw error }
        finally { await persist() }
      }
    }
  }
})
report.complete = true
await mkdir(dirname(resolve(values.out)), { recursive: true })
await writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
console.log(values.out)
