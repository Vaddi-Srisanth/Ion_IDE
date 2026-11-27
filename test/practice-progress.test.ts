import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { PracticeStore, validatePracticeSubmissions } from '../src/main/practice/store'
import type { RunResult } from '../src/shared/contracts'

const signal = new AbortController().signal

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ion-practice-progress-')), path = join(root, 'practice')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new PracticeStore(path)
  const ledger = (problem: string, attempt: string) => join(path, problem, 'attempt-' + attempt + '.submissions.json')
  return { path, store, ledger }
}

const clockSummary = { id: 'minutes-to-clock', title: 'Minutes to Clock', topic: 'Basics', difficulty: 'Easy' } as const
const invoiceSummary = { id: 'workshop-invoice', title: 'Workshop Invoice', topic: 'Basics', difficulty: 'Medium' } as const

function success(programStdout: string): RunResult {
  return { status: 'success', compiler: null, compileOutput: '', programOutput: programStdout, programStdout,
    programStderr: '', exitCode: 0, durationMs: 1, programMs: 1, outputComplete: true, message: 'Fixture' }
}

test('opening progress does not create practice data, and cancel stops a metadata scan before the next record', async t => {
  const { path, store } = await fixture(t)
  assert.deepEqual(await store.progress(signal), { catalogSize: 27, opened: 0, submitted: 0, accepted: 0, unavailable: 0, challenges: [],
    suggestion: { ...clockSummary, reason: 'new' } })
  await assert.rejects(lstat(path), { code: 'ENOENT' })
  await store.start('minutes-to-clock', 'python')
  await store.start('workshop-invoice', 'python')
  const controller = new AbortController()
  const open = fs.open
  const calls: string[] = []
  t.mock.method(fs, 'open', (...args: Parameters<typeof open>) => {
    calls.push(basename(String(args[0])))
    controller.abort()
    return open(...args)
  })
  await assert.rejects(store.progress(controller.signal), { name: 'AbortError' })
  assert.deepEqual(calls, ['problem.json'])
  await assert.rejects(store.progress(controller.signal), { name: 'AbortError' })
  assert.deepEqual(calls, ['problem.json'])
})

test('progress deduplicates catalog IDs and distinguishes restored, local and mismatched-suite evidence across languages', async t => {
  const { path, store, ledger } = await fixture(t)
  const clock = await store.start('minutes-to-clock', 'python')
  const another = await store.start('minutes-to-clock', 'java')
  const manual = await store.start('workshop-invoice', 'python')
  await store.save({ ...manual.problem, title: 'My saved display name', completion: 'Completed' })
  await store.runSamples(manual.problem.id, manual.attempt.id, async () => manual.problem.samples.map(row => success(row.expectedOutput)))
  const custom = await store.save({ ...manual.problem, id: undefined, revision: undefined, title: 'Minutes to Clock', completion: 'Completed' })
  await store.createAttempt(custom.id, 'Personal problem')
  await store.startLearningExercise('python', 'clock-lesson', 'python', store.getChallenge('minutes-to-clock'))
  await store.submit(clock.problem.id, clock.attempt.id, async (_path, inputs) => inputs.map(input =>
    success(Math.floor(Number(input) / 60) + ' ' + Number(input) % 60)), signal)
  const clockLedger = ledger(clock.problem.id, clock.attempt.id)
  const imported = validatePracticeSubmissions(JSON.parse(await readFile(clockLedger, 'utf8')))
  for (const item of imported.submissions) item.restored = true
  await writeFile(clockLedger, JSON.stringify(imported))
  const otherSuite = await store.start('exactly-one-siren', 'cpp')
  await writeFile(ledger(otherSuite.problem.id, otherSuite.attempt.id), JSON.stringify({
    version: 1, submissions: imported.submissions.map(row => ({ ...row, suiteVersion: row.suiteVersion + 1 })),
  }))

  const expected = {
    catalogSize: 27, opened: 3, submitted: 2, accepted: 1, unavailable: 0,
    challenges: [
      { id: 'minutes-to-clock', title: 'Minutes to Clock', state: 'accepted', importedOnly: true },
      { id: 'workshop-invoice', title: 'Workshop Invoice', state: 'opened', importedOnly: false },
      { id: 'exactly-one-siren', title: 'Exactly One Siren', state: 'submitted', importedOnly: true },
    ],
    suggestion: { ...invoiceSummary, reason: 'opened' },
  }
  assert.deepEqual(await store.progress(signal), expected)
  await store.submit(another.problem.id, another.attempt.id, async (_path, inputs) => inputs.map(() => success('incorrect')), signal)
  expected.challenges[0].importedOnly = false
  // Neither a new saved source nor removal of the old source retracts historical verdicts.
  await writeFile(await store.openAttempt(another.problem.id, another.attempt.id), '// new draft\n')
  await rm(await store.openAttempt(clock.problem.id, clock.attempt.id))
  const opened: string[] = [], open = fs.open
  t.mock.method(fs, 'open', (...args: Parameters<typeof open>) => {
    opened.push(basename(String(args[0])))
    return open(...args)
  })
  assert.deepEqual(await new PracticeStore(path).progress(signal), expected)
  assert.ok(opened.includes('problem.json') && opened.some(name => name.endsWith('.submissions.json')))
  assert.ok(opened.every(name => name === 'problem.json' || name.endsWith('.submissions.json')))
})

test('a retained local submission is suggested before an opened challenge', async t => {
  const { store } = await fixture(t)
  await store.start(clockSummary.id, 'python')
  const invoice = await store.start(invoiceSummary.id, 'python')
  await store.submit(invoice.problem.id, invoice.attempt.id, async (_path, inputs) => inputs.map(() => success('incorrect')), signal)
  assert.deepEqual((await store.progress(signal)).suggestion, { ...invoiceSummary, reason: 'submitted' })
})

test('topic focus counts distinct locally unresolved wrong-answer challenges and ignores restored verdicts', async t => {
  const { store, ledger } = await fixture(t)
  const clock = await store.start(clockSummary.id, 'python')
  await store.submit(clock.problem.id, clock.attempt.id, async (_path, inputs) => inputs.map(() => success('wrong')), signal)
  await store.submit(clock.problem.id, clock.attempt.id, async (_path, inputs) => inputs.map(() => success('wrong again')), signal)
  assert.equal((await store.progress(signal)).topicFocus, undefined)

  const invoice = await store.start(invoiceSummary.id, 'python')
  await store.submit(invoice.problem.id, invoice.attempt.id, async (_path, inputs) => inputs.map(() => success('wrong')), signal)
  assert.deepEqual((await store.progress(signal)).topicFocus, {
    topic: 'Basics', unresolvedChallenges: 2,
    challenge: { ...clockSummary },
  })

  await store.submit(clock.problem.id, clock.attempt.id, async (_path, inputs) => inputs.map(input => {
    const minutes = Number(input)
    return success(Math.floor(minutes / 60) + ' ' + minutes % 60)
  }), signal)
  assert.equal((await store.progress(signal)).topicFocus, undefined)
  await store.submit(clock.problem.id, clock.attempt.id, async (_path, inputs) => inputs.map(() => success('wrong later')), signal)
  assert.deepEqual((await store.progress(signal)).topicFocus, {
    topic: 'Basics', unresolvedChallenges: 2,
    challenge: { ...clockSummary },
  })

  const clockLedger = ledger(clock.problem.id, clock.attempt.id)
  const imported = validatePracticeSubmissions(JSON.parse(await readFile(clockLedger, 'utf8')))
  for (const item of imported.submissions) item.restored = true
  await writeFile(clockLedger, JSON.stringify(imported))
  assert.equal((await store.progress(signal)).topicFocus, undefined)
})

test('related challenges use local topic activity and imported results exclude only the recorded challenge', async t => {
  const { store, ledger } = await fixture(t)
  const clock = await store.start(clockSummary.id, 'python')
  await store.submit(clock.problem.id, clock.attempt.id, async (_path, inputs) => inputs.map(input =>
    success(Math.floor(Number(input) / 60) + ' ' + Number(input) % 60)), signal)
  assert.deepEqual((await store.progress(signal)).suggestion, { ...invoiceSummary, reason: 'related' })

  const clockLedger = ledger(clock.problem.id, clock.attempt.id)
  const imported = validatePracticeSubmissions(JSON.parse(await readFile(clockLedger, 'utf8')))
  for (const item of imported.submissions) item.restored = true
  await writeFile(clockLedger, JSON.stringify(imported))
  assert.deepEqual((await store.progress(signal)).suggestion,
    { id: 'badge-initials', title: 'Badge Initials', topic: 'Strings', difficulty: 'Easy', reason: 'new' })
})

test('unreadable problem and submission records are counted separately while remaining evidence survives', async t => {
  const { store, path, ledger } = await fixture(t)
  const clock = await store.start('minutes-to-clock', 'python')
  const another = await store.createAttempt(clock.problem.id, 'Later')
  await store.submit(clock.problem.id, another.attempt.id, async (_path, inputs) => inputs.map(() => success('wrong')), signal)
  const damaged = ledger(clock.problem.id, clock.attempt.id)
  const marker = '{"malformed":"PRIVATE-FIXTURE"}'
  await writeFile(damaged, marker)
  const badProblem = join(path, randomUUID())
  await mkdir(badProblem)
  await writeFile(join(badProblem, 'problem.json'), marker)
  const result = await store.progress(signal)
  assert.deepEqual(result, { catalogSize: 27, opened: 1, submitted: 1, accepted: 0, unavailable: 2,
    challenges: [{ id: 'minutes-to-clock', title: 'Minutes to Clock', state: 'submitted', importedOnly: false }] })
  assert.equal(await readFile(damaged, 'utf8'), marker)
  assert.equal(await readFile(join(badProblem, 'problem.json'), 'utf8'), marker)
})

test('a paused progress read leaves the store available to save notes', { timeout: 5000 }, async t => {
  const { store } = await fixture(t)
  const clock = await store.start('minutes-to-clock', 'python')
  const invoice = await store.start('workshop-invoice', 'python')
  await store.submit(clock.problem.id, clock.attempt.id, async (_path, inputs) => inputs.map(() => success('wrong')), signal)
  let entered!: () => void, release!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  const open = fs.open
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    if (String(args[0]).endsWith('.submissions.json')) {
      entered()
      await paused
    }
    return open(...args)
  })
  const scan = store.progress(signal)
  try {
    await reading
    const saved = await store.save({ ...invoice.problem, notes: 'Saved during progress review.' })
    assert.equal(saved.notes, 'Saved during progress review.')
  } finally {
    release()
  }
  assert.equal((await scan).submitted, 1)
})
