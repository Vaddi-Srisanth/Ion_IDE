import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, close, createProject, launch, openFolder, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { baseline: { type: 'string' }, target: { type: 'string', default: 'dist' },
  trials: { type: 'string', default: '30' }, out: { type: 'string', default: 'performance-results/file-saves.json' } } })
assert.ok(values.baseline, 'Pass a preserved production build with --baseline.')
const trials = Number(values.trials)
assert.ok(Number.isInteger(trials) && trials >= 3 && trials <= 100)
const summarize = (samples) => {
  const ordered = [...samples].sort((a, b) => a - b)
  return { medianMs: ordered[Math.ceil(ordered.length * 0.5) - 1], p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1] }
}
const report = { platform: process.platform, arch: process.arch, trials,
  method: 'Renderer save IPC through synchronized publish and revision response. Exact disk bytes are verified. No editor or autosave timing included.', results: {} }

await withScratch('file-saves', async scratch => {
  for (const [name, build] of [['baseline', values.baseline], ['candidate', values.target]]) {
    const project = await createProject(join(scratch, name), { fileCount: 0 })
    const session = await launch(await artifact(build), join(scratch, name + '-profile'))
    try {
      await session.page.context().setOffline(true)
      await stubDialogs(session.app, { folder: project.directory })
      await openFolder(session.page, project)
      report.results[name] = {}
      for (const [size, count] of [['256-byte', 250], ['1.5-MiB', 1.5 * 1024 ** 2 - 6]]) {
        const path = join(project.directory, size + '.txt')
        await writeFile(path, 'x'.repeat(count))
        const timings = await session.page.evaluate(async ({ path, count, trials }) => {
          const api = window.ion
          const body = 'x'.repeat(count)
          let { revision, contentHash } = await api.readFile(path)
          const result = []
          for (let iteration = 0; iteration <= trials; iteration++) {
            const text = body + String(iteration).padStart(5, '0') + '\n'
            const begin = performance.now()
            const saved = await api.saveFile(path, text, revision, contentHash)
            const duration = performance.now() - begin
            revision = saved.revision
            contentHash = saved.contentHash
            if (iteration) result.push(duration)
          }
          return result
        }, { path, count, trials })
        assert.equal(await readFile(path, 'utf8'), 'x'.repeat(count) + String(trials).padStart(5, '0') + '\n')
        report.results[name][size] = { ...summarize(timings), timings }
      }
      assert.deepEqual(session.requests, [])
      assert.deepEqual(session.errors, [])
    } finally { await close(session) }
  }
})
await mkdir(dirname(resolve(values.out)), { recursive: true })
await writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
console.log(values.out)
