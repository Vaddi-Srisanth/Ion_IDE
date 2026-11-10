import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, promisify } from 'node:util'
import { artifact, close, createProject, launch, openFolder, openFromExplorer,
  resourceSnapshot, stubDialogs, withScratch } from './desktop-harness.mjs'

assert.equal(process.platform, 'darwin', 'The benchmark uses macOS process accounting.')
const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, runs: { type: 'string', default: '3' },
  sizes: { type: 'string', default: '5,25,50,100' },
} })
const repetitions = Number(values.runs)
const sizes = values.sizes.split(',').map(Number)
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10)
assert.ok(sizes.length && sizes.every((value) => [0, 5, 10, 25, 50, 100].includes(value)))
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use a production build directory.')
const require = createRequire(import.meta.url)
const { LearningPackStore } = require(join(target.path, 'main/learning/catalog-store.cjs'))
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const execute = promisify(execFile)
const searchSamples = 5
const settleMs = 1000
const closeSettleMs = 3000

const title = (index) => 'Benchmark Pack ' + String(index).padStart(3, '0')
const lesson = (index) => ({
  id: 'test-' + index, title: 'Testing example ' + index, section: 'Basics', difficulty: 'beginner',
  explanation: 'This synthetic lesson has enough text to exercise the storage and rendering paths. '.repeat(12),
  example: 'print("Example ' + index + '")', api: [], practice: 'Change the value and predict the result.',
  keywords: ['synthetic', 'benchmark', 'output'],
})
const fixture = (index) => ({
  schema: 2, id: 'bench-pack-' + index, name: title(index), version: 1, summary: 'Synthetic offline benchmark pack.',
  metadata: { kind: 'language', categories: ['automation'], languageVersion: '3.11', prerequisites: [],
    miniProject: 'Compare two example inputs.', references: [{ title: 'Python tutorial', url: 'https://docs.python.org/3/tutorial/' }],
    attribution: { author: 'Ion benchmark', license: 'Synthetic local fixture' } },
  lessons: Array.from({ length: 15 }, (_, index) => lesson(index + 1)),
})

async function sample(session, probe) {
  const { rssMiB, members } = await resourceSnapshot(session, { details: true })
  const { stdout } = await execute(probe, members.map(({ pid }) => String(pid)))
  const parts = stdout.trim().split('\n').filter(Boolean).map((line) => line.split(' ').map(Number))
  return { rssMiB, footprintMiB: parts.length === members.length
    ? parts.reduce((sum, [, bytes]) => sum + bytes, 0) / 1024 ** 2 : null, processes: members.length }
}

const result = await withScratch('marketplace-benchmark', async (scratch) => {
  const probe = join(scratch, 'resource-probe')
  await execute('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const project = await createProject(join(scratch, 'source'), { fileCount: 1 })
  const report = []
  for (const size of sizes) {
    const profile = join(scratch, 'profile-' + size)
    await mkdir(profile)
    const store = new LearningPackStore(profile, join(target.path, 'main/learning-catalog'), version)
    const input = join(scratch, 'synthetic.json')
    for (let index = 0; index < size; index++) {
      await writeFile(input, JSON.stringify(fixture(index)))
      await store.importFile(input)
    }
    assert.equal((await store.getLibrary(false)).installed.length, size)
    for (let run = 0; run < repetitions; run++) {
      const session = await launch(target, profile)
      try {
        const { app, page } = session
        await page.context().setOffline(true)
        await stubDialogs(app, { folder: project.directory })
        await openFolder(page, project)
        await openFromExplorer(page, project.files[0], 'Ion fixture')
        assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
          .some((entry) => /MarketplacePane/.test(entry.name))), false, 'Marketplace chunk stayed unloaded in the editor')
        await sleep(settleMs)
        const idle = await sample(session, probe)
        const market = page.getByTestId('marketplace-pane')
        const search = market.getByTestId('marketplace-search')
        const started = performance.now()
        await page.getByTestId('toggle-marketplace').click()
        await search.waitFor()
        await market.getByTestId('marketplace-install').first().waitFor()
        const openMs = performance.now() - started
        const list = market.getByRole('list', { name: 'Learning packs' })
        const windowed = await list.getAttribute('data-windowed') === 'true'
        if (size >= 25) {
          assert.equal(windowed, true)
          assert.ok(await list.getByRole('listitem').count() < size)
        }
        await sleep(settleMs)
        const opened = await sample(session, probe)
        const searchMs = []
        const queries = size ? Array.from({ length: Math.min(size, searchSamples) }, (_, index) => title(index))
          : ['Python', 'TypeScript', 'JavaScript', 'Rust', 'Python']
        for (const name of queries) {
          const start = performance.now()
          await search.fill(name)
          await market.getByText(name, { exact: true }).first().waitFor()
          searchMs.push(performance.now() - start)
        }
        await page.getByTestId('toggle-marketplace').click()
        await market.waitFor({ state: 'detached' })
        await sleep(closeSettleMs)
        const closed = await sample(session, probe)
        assert.deepEqual(session.requests, [])
        report.push({ size, run: run + 1, idle, opened, closed, openMs, searchMs, windowed })
        console.log(JSON.stringify(report.at(-1)))
      } finally {
        await close(session)
      }
    }
  }
  return report
})
const host = {
  macOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  processor: execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
  memory: Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' })),
  arch: process.arch,
}
const directory = resolve('performance-results')
await mkdir(directory, { recursive: true })
const file = join(directory, 'learning-marketplace-' + new Date().toISOString().replaceAll(':', '-') + '.json')
await writeFile(file, JSON.stringify({ host, version, repetitions, settleMs, closeSettleMs, searchSamples, result }, null, 2) + '\n')
console.log(file)
