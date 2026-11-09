import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { diagnose } from '../src/main/learning/diagnostics'
import { LearningService } from '../src/main/learning'
import type { RunResult } from '../src/shared/contracts'
import type { DiagnosticCategory } from '../src/shared/learning'

const packs = resolve('src/main/learning/packs')
const casesPath = resolve('test/fixtures/c-diagnostics.json')
const digest = (source: string) => createHash('sha256').update(source).digest('hex')

function run(partial: Partial<RunResult> = {}): RunResult {
  return {
    status: 'compile-error', compiler: '/usr/bin/clang', compileOutput: '', programOutput: '',
    exitCode: 1, durationMs: 1, message: 'Compilation failed (exit code 1).', ...partial,
  }
}

interface Fixture {
  id: string
  compiler: 'clang' | 'gcc'
  version: string
  source: string
  expected: DiagnosticCategory
  expectedClassification?: DiagnosticCategory
  output: string
}

test('reviewed Apple Clang and GCC fixtures classify structured diagnostics conservatively', async () => {
  const cases = JSON.parse(await readFile(casesPath, 'utf8')) as Fixture[]
  assert.equal(cases.length, 40)
  const report = { classified: 0, correct: 0, incorrect: 0, abstained: 0, classifiedExpected: 0 }
  for (const item of cases) {
    const label = item.compiler + ' ' + item.id
    const diagnostics = diagnose(run({
      compiler: item.compiler === 'clang' ? '/usr/bin/clang' : '/opt/homebrew/bin/gcc-16',
      compileOutput: item.output,
      status: /(?:fatal )?error:/.test(item.output) ? 'compile-error' : 'success',
    }))
    const primary = diagnostics.find((value) => value.severity !== 'note')
    assert.ok(primary, label)
    assert.equal(primary.language, 'c', label)
    assert.equal(primary.compiler, item.compiler, label)
    assert.equal(primary.location?.file, '/fixture.c', label)
    assert.ok(primary.location?.line && primary.location?.column, label)
    assert.ok(item.output.includes(primary.raw.split('\n')[0]), label)
    assert.equal(primary.category, item.expectedClassification ?? item.expected, label)
    if (item.expected !== 'unclassified-compiler') report.classifiedExpected += 1
    if (primary.confidence === 'high') {
      assert.ok(primary.concepts.length > 0, label)
      report.classified += 1
      if (primary.category === item.expected) report.correct += 1
      else report.incorrect += 1
    } else {
      assert.deepEqual(primary.concepts, [], label)
      report.abstained += 1
    }
  }
  assert.deepEqual(report, { classified: 29, correct: 29, incorrect: 0, abstained: 11, classifiedExpected: 30 })
})

test('missing locations and unrecognized diagnostics preserve the original compiler output', () => {
  const linker = 'Undefined symbols for architecture arm64:\n  "_main", referenced from:\nld: symbol(s) not found'
  const [diagnostic] = diagnose(run({ compileOutput: linker }))
  assert.equal(diagnostic.category, 'unclassified-compiler')
  assert.equal(diagnostic.location, undefined)
  assert.equal(diagnostic.raw, linker)
  const [unknown] = diagnose(run({
    compiler: '/custom/cc',
    compileOutput: "/case.c:2:9: error: expected ';' after expression",
  }))
  assert.equal(unknown.compiler, 'unknown')
  assert.equal(unknown.confidence, 'uncertain')
  assert.deepEqual(unknown.concepts, [])
})

test('runtime learning trusts the OS signal rather than interpreting arbitrary output', () => {
  const spoof = run({
    status: 'runtime-error', programOutput: 'SIGSEGV\nThis is an application message.',
    message: 'Program failed (exit code 7).', exitCode: 7,
  })
  assert.equal(diagnose(spoof)[0].category, 'unclassified-runtime')
  assert.match(diagnose(spoof)[0].raw, /This is an application message/)
  const [fault] = diagnose({ ...spoof, programSignal: 'SIGSEGV', exitCode: null })
  assert.equal(fault.category, 'runtime-memory-fault')
  assert.equal(fault.location, undefined)
  assert.deepEqual(fault.concepts, ['memory', 'pointers'])
})

test('history persists edited retries, skips unchanged runs, and resolves on successful recompilation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-test-'))
  try {
    const storage = join(directory, 'learning.json')
    const service = new LearningService(storage, packs)
    const path = '/fixture.c'
    const compileError = run({ compileOutput: path + ":1:23: error: expected ';' after return statement" })
    const observe = (source: string, result: RunResult = compileError) =>
      service.observe({ path, sourceHash: digest(source), result })
    const firstSource = 'int main(void) { return 0 }'
    const secondSource = 'int main(void) { return 1 }'
    assert.equal((await observe(firstSource)).diagnostics[0].occurrence, 'new')
    const firstWrite = await stat(storage, { bigint: true })
    assert.equal((await observe(firstSource)).diagnostics[0].occurrence, 'unchanged')
    assert.equal((await stat(storage, { bigint: true })).ino, firstWrite.ino)
    assert.equal((await observe(secondSource)).diagnostics[0].occurrence, 'repeated')
    assert.equal((await observe(firstSource)).diagnostics[0].occurrence, 'unchanged')
    assert.equal((await service.observe({
      path: '/other.c', sourceHash: digest(firstSource), result: compileError,
    })).diagnostics[0].occurrence, 'new')

    assert.equal((await observe('return total;', run({
      compileOutput: path + ":1:20: error: use of undeclared identifier 'total'",
    }))).diagnostics[0].occurrence, 'new')
    assert.equal((await observe('return count;', run({
      compileOutput: path + ":1:20: error: use of undeclared identifier 'count'",
    }))).diagnostics[0].occurrence, 'new')
    assert.equal((await observe('int total = 0; int total = 1;', run({
      compileOutput: path + ":1:20: error: redefinition of 'total'",
    }))).diagnostics[0].occurrence, 'related')

    await Promise.all([service.recordTopic('statements', 'viewed'), service.recordTopic('statements', 'selected')])
    const reloaded = new LearningService(storage, packs)
    const fixed = await reloaded.observe({
      path, sourceHash: digest('int main(void) { return 0; }'),
      result: run({ status: 'success', exitCode: 0, message: 'Program exited successfully.' }),
    })
    assert.deepEqual(new Set(fixed.resolved), new Set(['missing-semicolon', 'undeclared-identifier', 'scope-conflict']))
    const history = await reloaded.getHistory()
    assert.deepEqual(history.categories.find(({ category }) => category === 'missing-semicolon'), {
      category: 'missing-semicolon', encountered: 3, repeated: 1, resolved: 1,
    })
    assert.deepEqual(history.categories.find(({ category }) => category === 'undeclared-identifier'), {
      category: 'undeclared-identifier', encountered: 2, repeated: 0, resolved: 2,
    })
    assert.deepEqual(history.topics, [{ id: 'statements', viewed: 2, selected: 1 }])
    const onDisk = await readFile(storage, 'utf8')
    assert.doesNotMatch(onDisk, /\/fixture\.c|return 0/)
    await reloaded.clearHistory()
    assert.deepEqual(await new LearningService(storage, packs).getHistory(), { categories: [], topics: [] })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('runtime failures can resolve compiler errors while preserving runtime history until a successful run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-runtime-'))
  try {
    const service = new LearningService(join(directory, 'learning.json'), packs)
    const path = '/fixture.c'
    await service.observe({
      path, sourceHash: digest('missing semicolon'), result: run({
        compileOutput: path + ":1:23: error: expected ';' after expression",
      }),
    })
    const crash = run({ status: 'runtime-error', programSignal: 'SIGSEGV' })
    const first = await service.observe({ path, sourceHash: digest('first crash'), result: crash })
    assert.deepEqual(first.resolved, ['missing-semicolon'])
    assert.equal(first.diagnostics[0].occurrence, 'new')
    const repeat = await service.observe({ path, sourceHash: digest('second crash'), result: crash })
    assert.equal(repeat.diagnostics[0].occurrence, 'repeated')
    assert.deepEqual(repeat.resolved, [])
    const success = await service.observe({ path, sourceHash: digest('fixed'), result: run({ status: 'success' }) })
    assert.deepEqual(success.resolved, ['runtime-memory-fault'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('unchanged diagnostic bursts do not count again after individual episode eviction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-diagnostic-burst-'))
  try {
    const storage = join(directory, 'learning.json')
    const compileOutput = Array.from({ length: 12 }, (_, index) =>
      `/fixture.c:${index + 1}:7: error: use of undeclared identifier 'name${index}'`).join('\n')
    const observation = { path: '/fixture.c', sourceHash: digest('same source'), result: run({ compileOutput }) }
    await new LearningService(storage, packs).observe(observation)
    const reloaded = new LearningService(storage, packs)
    const feedback = await reloaded.observe(observation)
    assert.equal(feedback.diagnostics.length, 12)
    assert.ok(feedback.diagnostics.every(({ occurrence }) => occurrence === 'unchanged'))
    assert.deepEqual((await reloaded.getHistory()).categories, [
      { category: 'undeclared-identifier', encountered: 12, repeated: 0, resolved: 0 },
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('topic index is available before any concept file loads and content stays scoped to known IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-pack-'))
  try {
    const service = new LearningService(join(directory, 'history.json'), directory)
    assert.equal(service.getTopics().length, 12)
    await assert.rejects(() => service.getConcept('../learning'), /Unknown learning topic/)
    await assert.rejects(() => service.getConcept('pointers'), { code: 'ENOENT' })
    await writeFile(join(directory, 'pointers.json'), await readFile(join(packs, 'pointers.json')))
    assert.equal((await service.getConcept('pointers')).title, 'Pointers and dereferencing')
    await assert.rejects(() => service.getConcept('types'), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an unreadable history does not hide explanations or replace the existing data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-history-error-'))
  try {
    const storage = join(directory, 'learning.json')
    await writeFile(storage, '{"version":2}')
    const service = new LearningService(storage, packs)
    const result = await service.observe({
      path: '/fixture.c', sourceHash: digest('missing semicolon'), result: run({
        compileOutput: "/fixture.c:1:23: error: expected ';' after expression",
      }),
    })
    assert.equal(result.historyUnavailable, true)
    assert.equal(result.diagnostics[0].category, 'missing-semicolon')
    assert.deepEqual(result.resolved, [])
    assert.equal(await readFile(storage, 'utf8'), '{"version":2}')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
