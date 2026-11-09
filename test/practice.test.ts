import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PracticeStore } from '../src/main/practice'
import { CRunner, detectCompiler } from '../src/main/runner'
import type { RunResult } from '../src/shared/contracts'
import type { PracticeDraft, PracticeSample } from '../src/shared/practice'

const sample = (expectedOutput: string, input = ''): PracticeSample => ({
  id: randomUUID(), label: 'Sample', input, expectedOutput,
})

function draft(samples: PracticeSample[] = []): PracticeDraft {
  return {
    title: 'Double a number', sourceUrl: 'https://example.org/problems/double', difficulty: 'Easy', topic: 'Input',
    completion: 'In progress', statement: 'Read a number and print double its value.', notes: 'Try scanf first.', samples,
  }
}

async function scratch<T>(operation: (directory: string, store: PracticeStore) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ion-practice-test-'))
  try {
    return await operation(directory, new PracticeStore(join(directory, 'practice')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function success(stdout: string, stderr = ''): RunResult {
  return {
    status: 'success', compiler: '/usr/bin/clang', compileOutput: '', programOutput: stdout + stderr,
    programStdout: stdout, programStderr: stderr, exitCode: 0, durationMs: 2, message: 'Finished.',
  }
}

test('practice problems, notes, and independent source attempts survive reopening', () => scratch(async (directory, store) => {
  const problem = await store.save(draft())
  const first = await store.createAttempt(problem.id, 'First approach')
  const firstPath = await store.openAttempt(problem.id, first.attempt.id)
  assert.equal(await readFile(firstPath, 'utf8'), '')
  await writeFile(firstPath, 'int main(void) { return 1; }')
  const second = await store.createAttempt(problem.id, 'Alternate approach')
  const secondPath = await store.openAttempt(problem.id, second.attempt.id)
  await writeFile(secondPath, 'int main(void) { return 0; }')
  await assert.rejects(store.save({ ...problem, notes: 'This revision is stale.' }), /problem changed/)

  const metadata = join(directory, 'practice', problem.id, 'problem.json')
  const { language: _language, ...legacy } = JSON.parse(await readFile(metadata, 'utf8'))
  await writeFile(metadata, JSON.stringify(legacy))
  const reopened = new PracticeStore(join(directory, 'practice'))
  assert.deepEqual(await reopened.list(), {
    problems: [{ id: problem.id, title: 'Double a number', difficulty: 'Easy', topic: 'Input', completion: 'In progress', language: 'c' }],
    unavailable: 0,
  })
  const current = await reopened.get(problem.id)
  assert.equal(current.notes, 'Try scanf first.')
  assert.deepEqual(current.attempts.map(({ label }) => label), ['First approach', 'Alternate approach'])
  assert.match(await readFile(await reopened.openAttempt(problem.id, first.attempt.id), 'utf8'), /return 1/)
  assert.match(await readFile(await reopened.openAttempt(problem.id, second.attempt.id), 'utf8'), /return 0/)
}))

test('practice IPC inputs reject path traversal, cross-problem attempts, and symbolic links', () => scratch(async (directory, store) => {
  await assert.rejects(store.save({ ...draft(), sourceUrl: 'file:///private/data' }), /HTTP or HTTPS/)
  await assert.rejects(store.get('../outside'), /identifier/)
  const a = await store.save(draft())
  const b = await store.save({ ...draft(), title: 'Another problem' })
  const { attempt } = await store.createAttempt(a.id, '')
  await assert.rejects(store.openAttempt(b.id, attempt.id), /does not belong/)
  const path = await store.openAttempt(a.id, attempt.id)
  const outside = join(directory, 'outside.c')
  await writeFile(outside, 'private')
  await rename(path, path + '.saved')
  await symlink(outside, path)
  await assert.rejects(store.openAttempt(a.id, attempt.id), /regular source file/)
  assert.equal(await readFile(outside, 'utf8'), 'private')
}))

test('filtered catalog challenges open prepared, independent language attempts without replacing saved work', () => scratch(async (directory, store) => {
  const easy = store.browse({ difficulty: 'Easy', topic: 'Basics', language: 'python' })
  assert.ok(easy.length > 0)
  assert.ok(easy.every(({ difficulty, topic }) => difficulty === 'Easy' && topic === 'Basics'))
  assert.throws(() => store.browse({ difficulty: 'Easy', language: 'unknown' }), /practice language/)
  await assert.rejects(store.start('../outside', 'python'), /Invalid practice challenge/)
  await assert.rejects(store.start(easy[0].id, 'unknown'), /practice language/)

  const first = await store.start(easy[0].id, 'python')
  const source = await store.openAttempt(first.problem.id, first.attempt.id)
  assert.match(source, /\.py$/)
  assert.equal(first.problem.language, 'python')
  assert.ok(first.problem.statement.length > 80)
  assert.ok(first.problem.samples.length >= 3)
  await writeFile(source, '# keep my work\n')

  const reopened = new PracticeStore(join(directory, 'practice'))
  const again = await reopened.start(easy[0].id, 'python')
  assert.equal(again.problem.id, first.problem.id)
  assert.equal(again.attempt.id, first.attempt.id)
  assert.equal(await readFile(source, 'utf8'), '# keep my work\n')
  const other = await reopened.start(easy[0].id, 'java')
  const java = await reopened.openAttempt(other.problem.id, other.attempt.id)
  assert.notEqual(other.problem.id, first.problem.id)
  assert.match(java, /attempt-[\w-]+[/\\]Main\.java$/)
  assert.match(await readFile(java, 'utf8'), /public class Main/)
  assert.equal((await reopened.list()).problems.length, 2)
}))

test('sample results distinguish exact stdout, stderr, compilation errors, and stale source', () => scratch(async (_directory, store) => {
  const samples = [sample('12', '6\n'), sample('8', '4\n')]
  const problem = await store.save(draft(samples))
  const { attempt } = await store.createAttempt(problem.id, '')
  const tested = await store.runSamples(problem.id, attempt.id, async (_path, inputs) => inputs.map((stdin) => stdin === '6\n'
    ? success('12\r\n', 'non-output log\n') : success('8  \n')))
  const report = tested.attempts[0].lastRun
  assert.equal(report?.current, true)
  assert.deepEqual(report?.results.map(({ status }) => status), ['passed', 'failed'])
  assert.equal(report?.results[0].stderr, 'non-output log\n')
  assert.equal(tested.completion, 'In progress')

  const saved = await store.save({ ...tested, notes: 'Notes alone do not invalidate a test.' })
  assert.equal(saved.attempts[0].lastRun?.current, true)
  const path = await store.openAttempt(problem.id, attempt.id)
  await writeFile(path, 'new source')
  assert.equal((await store.get(problem.id)).attempts[0].lastRun?.current, false)

  let calls = 0
  const errors = await store.runSamples(problem.id, attempt.id, async () => {
    calls++
    return [{
      ...success(''), status: 'compile-error', programStderr: undefined,
      compileOutput: 'compiler error', message: 'The compiler failed.',
    }]
  })
  assert.equal(calls, 1)
  assert.deepEqual(errors.attempts[0].lastRun?.results.map(({ status }) => status), ['unavailable', 'skipped'])
  assert.equal(errors.attempts[0].lastRun?.results[0].stderr, 'compiler error')
}))

test('sample results are not published for a source that changed during execution', () => scratch(async (_directory, store) => {
  const problem = await store.save(draft([sample('3')]))
  const { attempt } = await store.createAttempt(problem.id, '')
  await assert.rejects(store.runSamples(problem.id, attempt.id, async (source) => {
    await writeFile(source, 'edited while running')
    return [success('3\n')]
  }), /changed during the run/)
  assert.equal((await store.get(problem.id)).attempts[0].lastRun, undefined)
}))

test('practice samples execute a saved C solution through the real runner', async (context) => {
  const compiler = await detectCompiler(new AbortController().signal)
  if (!compiler) return context.skip('No installed C compiler.')
  await scratch(async (_directory, store) => {
    const problem = await store.save(draft([sample('12', '6\n'), sample('0', '0\n')]))
    const { attempt } = await store.createAttempt(problem.id, '')
    const path = await store.openAttempt(problem.id, attempt.id)
    await writeFile(path, `#include <stdio.h>
#include <stdlib.h>
int main(void) {
    char marker[4096];
    snprintf(marker, sizeof(marker), "%s/marker", getenv("TMPDIR"));
    FILE *created = fopen(marker, "wx");
    if (!created) return 2;
    fclose(created);
    int n;
    if (scanf("%d", &n) != 1) return 1;
    fprintf(stderr, "trace\\n");
    printf("%d\\n", n * 2);
    return 0;
}
`)
    const runner = new CRunner(undefined, async () => compiler)
    const run = await store.runSamples(problem.id, attempt.id, async (source, inputs) => {
      const results = await runner.runSamples(source, inputs, async () => true)
      assert.equal(typeof results[0].compileMs, 'number')
      assert.equal(results[1].compileMs, undefined)
      return results
    })
    assert.deepEqual(run.attempts[0].lastRun?.results.map(({ status }) => status), ['passed', 'passed'])
    assert.equal(run.attempts[0].lastRun?.results[0].stderr, 'trace\n')

    const stop = new AbortController()
    let checked = 0
    const stopped = await runner.runSamples(path, ['6\n', '0\n', '4\n'], async () => {
      if (++checked === 2) stop.abort()
      return true
    }, stop.signal)
    assert.deepEqual(stopped.map(({ status }) => status), ['success', 'cancelled'])
    assert.equal(runner.busy, false)
  })
})
