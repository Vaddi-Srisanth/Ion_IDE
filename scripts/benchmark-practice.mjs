import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, close, launch, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  compare: { type: 'string' },
  runs: { type: 'string', default: '5' },
} })
const runs = Number(values.runs)
assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 20, 'Use between one and twenty measured batches.')

async function measure(path) {
  return withScratch('practice-bench', async (scratch) => {
    const profile = join(scratch, 'profile')
    await mkdir(profile)
    const session = await launch(await artifact(path), profile)
    try {
      await stubDialogs(session.app, { allowRun: true })
      const ids = await session.page.evaluate(async () => {
        const problem = await window.ion.practice.save({
          title: 'Double an integer', sourceUrl: '', difficulty: 'Easy', topic: 'C I/O',
          completion: 'In progress', statement: 'Read an integer and print twice its value.', notes: '',
          samples: Array.from({ length: 8 }, (_, index) => ({
            id: crypto.randomUUID(), label: 'Sample ' + index, input: index + '\n', expectedOutput: index * 2 + '\n',
          })),
        })
        const { attempt } = await window.ion.practice.createAttempt(problem.id, 'First attempt')
        const file = await window.ion.practice.openAttempt(problem.id, attempt.id)
        return { problem: problem.id, attempt: attempt.id, path: file.path }
      })
      await writeFile(ids.path, '#include <stdio.h>\nint main(void) { int n; if (scanf("%d", &n) != 1) return 1; printf("%d\\n", 2*n); return 0; }\n')
      async function run() {
        return session.page.evaluate(async ({ problem, attempt }) => {
          const start = performance.now()
          const result = await window.ion.practice.runSamples(problem, attempt)
          const elapsed = performance.now() - start
          const report = result.attempts.find(row => row.id === attempt)?.lastRun
          if (!report?.current || report.results.length !== 8 || !report.results.every(row => row.status === 'passed')) {
            throw new Error('Benchmark requires eight fresh, passing samples.')
          }
          return elapsed
        }, ids)
      }
      const warmupMs = await run()
      const samplesMs = []
      for (let index = 0; index < runs; index += 1) samplesMs.push(await run())
      const sorted = samplesMs.toSorted((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      return {
        path, warmupMs, samplesMs, medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
      }
    } finally {
      await close(session)
    }
  })
}

const comparison = values.compare ? await measure(values.compare) : undefined
const production = await measure(values.target)
const report = { comparison, production }
await mkdir('performance-results', { recursive: true })
const file = join('performance-results', 'practice-' + new Date().toISOString().replaceAll(':', '-') + '.json')
await writeFile(file, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
console.log('Raw samples: ' + file)
