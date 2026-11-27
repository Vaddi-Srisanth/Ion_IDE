import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { runPracticeBatch } from '../src/main/practice/execute-samples'
import { PracticeStore, validatePracticeSubmissions } from '../src/main/practice/store'
import type { RunResult } from '../src/shared/contracts'

const signal = new AbortController().signal
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const answer = (value: string) => Math.floor(Number(value) / 60) + ' ' + Number(value) % 60 + '\n'
const privateMarker = 'PRIVATE-PROGRAM-DIAGNOSTIC'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ion-local-submit-')), store = new PracticeStore(join(root, 'practice'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const { problem, attempt } = await store.start('minutes-to-clock', 'python')
  const source = await store.openAttempt(problem.id, attempt.id)
  const ledger = join(root, 'practice', problem.id, 'attempt-' + attempt.id + '.submissions.json')
  return { root, store, problem, attempt, source, ledger }
}

function success(stdout: string): RunResult {
  return { status: 'success', compiler: null, compileOutput: '', programOutput: stdout, programStdout: stdout,
    programStderr: privateMarker, exitCode: 0, durationMs: 3, programMs: 2, outputComplete: true, message: privateMarker }
}
const correct = async (_path: string, inputs: readonly string[]) => inputs.map(input => success(answer(input)))

test('real Python passes the visible samples, fails the local suite, and a separate correct attempt passes after reopening', async t => {
  const { root, store, problem, attempt, source, ledger } = await fixture(t)
  assert.equal(problem.canSubmit, true)
  const notes = 'Keep these notes and my manual progress.'
  await store.save({ ...problem, notes, completion: 'In progress' })
  const sampleOnly = [
    'import sys', 'm = int(input())', 'answers = {137:"2 17", 0:"0 0", 60:"1 0", 1000000000:"16666666 40"}',
    'if m not in answers: print("' + privateMarker + '", m, file=sys.stderr)', 'print(answers.get(m,"unknown"))',
  ].join('\n') + '\n'
  await writeFile(source, sampleOnly)
  const observed: string[] = []
  async function python(path: string, inputs: readonly string[], _token: string, expectedHash?: string) {
    const bytes = await readFile(path)
    if (expectedHash !== undefined) {
      assert.equal(expectedHash, hash(bytes))
      observed.push(...inputs)
    }
    return runPracticeBatch(path, bytes.toString('utf8'), inputs, async () => true, signal)
  }
  const visible = await store.runSamples(problem.id, attempt.id, python)
  assert.deepEqual(visible.attempts[0].lastRun?.results.map(row => row.status), Array(4).fill('passed'))
  const first = await store.submit(problem.id, attempt.id, python, signal)
  const wrong = first.attempts[0].submissions?.[0]
  assert.ok(wrong && wrong.verdict === 'wrong-answer' && wrong.passed === 0 && wrong.current)
  assert.deepEqual(first.attempts[0].lastRun, visible.attempts[0].lastRun)
  assert.equal(wrong.total, observed.length)
  assert.ok(observed.every(input => !problem.samples.some(sample => sample.input === input)))
  const publicEvidence = JSON.stringify([store.getChallenge('minutes-to-clock'), first])
  const disk = await readFile(ledger, 'utf8')
  for (const value of [privateMarker, ...observed.flatMap(input => [JSON.stringify(input), JSON.stringify(answer(input).trim())])]) {
    assert.ok(!publicEvidence.includes(value) && !disk.includes(value), 'unseen fixtures and program output stay out of public and stored records')
  }
  assert.ok(!publicEvidence.includes(hash(sampleOnly)))
  assert.deepEqual(Object.keys(wrong).sort(), ['judgedAt', 'verdict', 'passed', 'total', 'runtimeMs', 'current'].sort())

  const second = await store.createAttempt(problem.id, 'General solution')
  const secondPath = await store.openAttempt(problem.id, second.attempt.id)
  const correctSource = 'm = int(input())\nprint(*divmod(m, 60))\n'
  await writeFile(secondPath, correctSource)
  await store.submit(problem.id, second.attempt.id, python, signal)
  const reopened = await new PracticeStore(join(root, 'practice')).get(problem.id)
  const accepted = reopened.attempts[1].submissions?.[0]
  assert.ok(accepted && accepted.current && accepted.verdict === 'accepted' && accepted.passed === accepted.total)
  assert.deepEqual(reopened.attempts[0].submissions, [wrong])
  assert.equal(reopened.notes, notes)
  assert.equal(reopened.completion, 'In progress')
  assert.equal(await readFile(source, 'utf8'), sampleOnly)
  assert.equal(await readFile(secondPath, 'utf8'), correctSource)
})

test('decline, cancellation, incomplete results, runner failures and same-size source changes preserve earlier submission bytes', async t => {
  const { store, problem, attempt, source, ledger } = await fixture(t)
  await writeFile(source, '# A\n')
  await store.submit(problem.id, attempt.id, correct, signal)
  const before = await readFile(ledger)
  for (const invalid of [
    [success('partial')], [{ ...success(''), outputComplete: false }], [{ ...success(''), status: 'cancelled' }],
    [{ ...success(''), status: 'rejected' }], [{ ...success(''), status: 'missing-toolchain' }],
    [{ ...success(''), status: 'runtime-error', exitCode: null }], [{ ...success(''), programMs: -1 }],
    [{ ...success(''), status: 'compile-error', exitCode: 0 }], [],
  ]) {
    await assert.rejects(store.submit(problem.id, attempt.id, async () => invalid as RunResult[], signal),
      (err: Error) => !err.message.includes(privateMarker))
  }
  await assert.rejects(store.submit(problem.id, attempt.id, async () => { throw new Error(privateMarker) }, signal),
    (err: Error) => !err.message.includes(privateMarker))
  const stop = new AbortController()
  await assert.rejects(store.submit(problem.id, attempt.id, async (_path, inputs) => {
    await assert.rejects(store.runSamples(problem.id, attempt.id, correct), /already running/)
    stop.abort()
    return correct('', inputs)
  }, stop.signal), /abort/i)
  const old = await stat(source)
  await assert.rejects(store.submit(problem.id, attempt.id, async (_path, inputs) => {
    await writeFile(source, '# B\n')
    await utimes(source, old.atime, old.mtime)
    return correct('', inputs)
  }, signal), /changed/)
  assert.deepEqual(await readFile(ledger), before)
  assert.equal((await store.get(problem.id)).attempts[0].submissions?.[0].current, false)

  const custom = await store.save({ ...problem, id: undefined, revision: undefined, title: 'Personal exercise' })
  const unsupported = await store.createAttempt(custom.id, 'Outside catalog')
  assert.ok(!unsupported.problem.canSubmit)
  await assert.rejects(store.submit(unsupported.problem.id, unsupported.attempt.id, correct, signal), /unavailable/)
  await assert.rejects(store.submit(problem.id, unsupported.attempt.id, correct, signal), /does not belong/)
})

test('submission history is bounded, restored entries stay historical, and malformed records are preserved and excluded', async t => {
  const { store, problem, attempt, ledger } = await fixture(t)
  for (let n = 0; n < 11; n++) {
    await store.submit(problem.id, attempt.id, n === 0 ? async (_path, inputs) => inputs.map(() => success('wrong')) : correct, signal)
  }
  const stored = validatePracticeSubmissions(JSON.parse(await readFile(ledger, 'utf8')))
  assert.equal(stored.submissions.length, 10)
  assert.ok(stored.submissions.every(row => row.verdict === 'accepted'))
  await writeFile(ledger, JSON.stringify({ ...stored, submissions: stored.submissions.map(row => ({ ...row, restored: true })) }))
  const renewed = await store.submit(problem.id, attempt.id, correct, signal)
  assert.deepEqual(renewed.attempts[0].submissions?.map(row => row.current), [...Array(9).fill(false), true])
  const dirty = { version: 1, submissions: [{ ...stored.submissions[0], stdout: privateMarker }] }
  await writeFile(ledger, JSON.stringify(dirty))
  await assert.rejects(store.submit(problem.id, attempt.id, correct, signal), /could not be read/)
  assert.equal(await readFile(ledger, 'utf8'), JSON.stringify(dirty))
  assert.ok(!JSON.stringify(await store.get(problem.id)).includes(privateMarker))
  assert.throws(() => validatePracticeSubmissions(dirty), /Invalid/)
  assert.throws(() => validatePracticeSubmissions({ ...stored, secret: 'private' }), /Invalid/)
})

test('the judge records verified process failures with aggregate timings and retains prior evidence on uncertain outcomes', async t => {
  const { store, problem, attempt, ledger } = await fixture(t)
  for (const language of ['c', 'cpp', 'java', 'javascript']) {
    assert.equal((await store.start('minutes-to-clock', language)).problem.canSubmit, true)
  }
  const failedCompile: RunResult = { ...success(''), status: 'compile-error', programMs: undefined, compileMs: 5, exitCode: 1 }
  await store.submit(problem.id, attempt.id, async () => [failedCompile], signal)
  await store.submit(problem.id, attempt.id, async (_path, inputs) => inputs.map(input =>
    ({ ...success(answer(input)), status: 'runtime-error', exitCode: 7 })), signal)
  await store.submit(problem.id, attempt.id, async () => [{ ...failedCompile, status: 'timeout', exitCode: null }], signal)
  const result = await store.submit(problem.id, attempt.id, async (_path, inputs) => [
    success(answer(inputs[0])), { ...success(''), status: 'output-limit', exitCode: null, outputComplete: false },
  ], signal)
  const outcomes = result.attempts[0].submissions
  assert.deepEqual(outcomes?.map(row => row.verdict), ['compile-error', 'runtime-error', 'timeout', 'output-limit'])
  assert.equal(outcomes?.[0].runtimeMs, 0)
  assert.equal(outcomes?.[3].passed, 1)
  assert.equal(outcomes?.[3].runtimeMs, 4)
  const before = await readFile(ledger)
  await assert.rejects(store.submit(problem.id, attempt.id, async (_path, inputs) => inputs.map(() => ({ ...success(''), exitCode: null })),
    signal), /could not verify/)
  assert.deepEqual(await readFile(ledger), before)
})
