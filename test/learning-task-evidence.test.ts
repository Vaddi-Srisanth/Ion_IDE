import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { PracticeStore } from '../src/main/practice'
import { execute } from '../src/main/runner'
import type { RunResult } from '../src/shared/contracts'

const exercise = {
  title: 'Read input', topic: 'Basics', difficulty: 'Easy' as const, statement: 'Echo standard input.',
  samples: [{ label: 'Matching input', input: 'yes', expectedOutput: 'yes\n' },
    { label: 'Different input', input: 'no', expectedOutput: 'yes\n' }],
}

async function fixture(run: (path: string, store: PracticeStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-evidence-'))
  const path = join(directory, 'practice')
  try { await run(path, new PracticeStore(path)) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

async function runNode(path: string, inputs: readonly string[]): Promise<RunResult[]> {
  const results: RunResult[] = []
  for (const input of inputs) {
    const processResult = await execute(process.execPath, [path], {
      cwd: dirname(path), input, signal: new AbortController().signal, timeoutMs: 5000,
      budget: { remaining: 8192 }, environment: process.env, splitOutput: true,
    })
    assert.equal(processResult.state, 'exited')
    results.push({ status: processResult.exitCode === 0 ? 'success' : 'runtime-error', message: 'Local Node execution.',
      compiler: process.execPath, compileOutput: '', programOutput: processResult.output, exitCode: processResult.exitCode,
      programStdout: processResult.stdout, programStderr: processResult.stderr,
      outputComplete: processResult.outputComplete, durationMs: 1 })
  }
  return results
}

test('reading missing lesson evidence does not create a practice library or accept unsafe identities', async () => {
  await fixture(async (path, store) => {
    assert.deepEqual(await store.learningTaskEvidence('javascript', 'input'), {
      problemId: null, attemptCount: 0, manualStatus: null, samples: null,
    })
    await assert.rejects(stat(path), { code: 'ENOENT' })
    await assert.rejects(store.learningTaskEvidence('../javascript', 'input'), /identity/)
    await assert.rejects(store.learningTaskEvidence('javascript', 'input:other'), /identity/)
    await assert.rejects(stat(path), { code: 'ENOENT' })
  })
})

test('lesson evidence projects actual sample execution, freshness and independent attempts without asserting mastery', async () => {
  await fixture(async (path, store) => {
    const started = await store.startLearningExercise('javascript', 'input', 'javascript', exercise)
    const source = await store.openAttempt(started.problem.id, started.attempt.id)
    await writeFile(source, 'process.stdout.write(require("node:fs").readFileSync(0,"utf8").trim()+"\\n")\n')
    const tested = await store.runSamples(started.problem.id, started.attempt.id, runNode)
    const metadata = join(path, started.problem.id, 'problem.json')
    const before = await readFile(metadata, 'utf8')
    const files = (await readdir(join(path, started.problem.id))).sort()
    const evidence = await new PracticeStore(path).learningTaskEvidence('javascript', 'input')
    assert.equal(evidence.problemId, started.problem.id)
    assert.equal(evidence.attemptCount, 1)
    assert.equal(evidence.manualStatus, 'Not started')
    assert.deepEqual(evidence.samples, { attemptId: started.attempt.id, testedAt: tested.attempts[0].lastRun!.testedAt,
      current: true, passed: 1, failed: 1, unavailable: 0, skipped: 0, total: 2 })
    assert.equal('mastered' in evidence, false)
    assert.equal(await readFile(metadata, 'utf8'), before)
    assert.deepEqual((await readdir(join(path, started.problem.id))).sort(), files)
    await writeFile(source, '// changed after tests\n')
    assert.equal((await store.learningTaskEvidence('javascript', 'input')).samples?.current, false)
    const saved = await store.save({ ...tested, notes: 'My reasoning', completion: 'In progress' })
    const second = await store.createAttempt(saved.id, 'Second approach')
    const again = await new PracticeStore(path).learningTaskEvidence('javascript', 'input')
    assert.equal(again.attemptCount, 2)
    assert.equal(again.manualStatus, 'In progress')
    assert.equal(again.samples, null, 'An older test report does not verify a newer attempt.')
    const reopened = await store.startLearningExercise('javascript', 'input', 'javascript', exercise)
    assert.equal(reopened.problem.id, saved.id)
    assert.equal(reopened.attempt.id, second.attempt.id)
    assert.equal(reopened.problem.notes, 'My reasoning')
    assert.equal(await readFile(source, 'utf8'), '// changed after tests\n')
  })
})

test('malformed or missing stored reports provide no fabricated sample evidence', async () => {
  await fixture(async (path, store) => {
    const started = await store.startLearningExercise('python', 'flow', 'python', exercise)
    const report = join(path, started.problem.id, 'attempt-' + started.attempt.id + '.report.json')
    assert.equal((await store.learningTaskEvidence('python', 'flow')).samples, null)
    await writeFile(report, '{"version":1,"results":"everything passed"}')
    assert.equal((await new PracticeStore(path).learningTaskEvidence('python', 'flow')).samples, null)
    assert.equal(await readFile(report, 'utf8'), '{"version":1,"results":"everything passed"}')
  })
})

test('lesson-specific starter initializes only new attempts and cannot overwrite saved or externally edited work', async () => {
  await fixture(async (path, store) => {
    const starter = '# Read input here.\nvalue = input()\n'
    const started = await store.startLearningExercise('python', 'flow', 'python', exercise, starter)
    const source = await store.openAttempt(started.problem.id, started.attempt.id)
    assert.equal(await readFile(source, 'utf8'), starter)
    const saved = await store.save({ ...started.problem, notes: 'Keep my notes', completion: 'In progress' })
    await writeFile(source, '# External or unsaved-editor checkpoint\nprint("mine")\n')
    const before = await readFile(join(path, saved.id, 'problem.json'), 'utf8')
    const again = await new PracticeStore(path).startLearningExercise('python', 'flow', 'python', exercise, '# new pack starter\n')
    assert.equal(again.problem.id, saved.id)
    assert.equal(again.attempt.id, started.attempt.id)
    assert.equal(await readFile(source, 'utf8'), '# External or unsaved-editor checkpoint\nprint("mine")\n')
    assert.equal(await readFile(join(path, saved.id, 'problem.json'), 'utf8'), before)
    const empty = await store.startLearningExercise('python', 'empty-starter', 'python', exercise, '')
    assert.equal(await readFile(await store.openAttempt(empty.problem.id, empty.attempt.id), 'utf8'), '')
    const catalog = store.browse({ difficulty: 'Easy', language: 'python' })[0]
    const normal = await store.start(catalog.id, 'python')
    assert.equal(await readFile(await store.openAttempt(normal.problem.id, normal.attempt.id), 'utf8'), '# Write your solution here.\n')
  })
})

test('invalid or oversized lesson starters are rejected before creating practice files', async () => {
  await fixture(async (path, store) => {
    for (const starter of ['x'.repeat(8001), 'é'.repeat(4001), 'bad\0text', '\ud800', 'bad\x01text', 42]) {
      await assert.rejects(store.startLearningExercise('python', 'flow', 'python', exercise, starter as string), /starter/)
    }
    await assert.rejects(stat(path), { code: 'ENOENT' })
    const boundary = 'é'.repeat(4000)
    const started = await store.startLearningExercise('python', 'flow', 'python', exercise, boundary)
    assert.equal(await readFile(await store.openAttempt(started.problem.id, started.attempt.id), 'utf8'), boundary)
  })
})
