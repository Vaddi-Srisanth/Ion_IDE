import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { compilerProblems, diagnose } from '../src/main/learning/diagnostics'
import { LearningService } from '../src/main/learning'
import { cRetryFingerprint } from '../src/main/learning/c-retry'
import { InteractiveRunner } from '../src/main/run-console/engine'
import type { RunPlan } from '../src/main/run-console/plans'
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
  const cPack = JSON.parse(await readFile(resolve('src/main/learning/catalog/c.json'), 'utf8')) as {
    lessons: Array<{ id: string }>
  }
  assert.equal(cases.length, 50)
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
    if (primary.category === 'format-argument-type') {
      assert.match(primary.guidance ?? '', /expected and actual types/, label)
    }
    if (item.expected !== 'unclassified-compiler') report.classifiedExpected += 1
    if (primary.confidence === 'high') {
      assert.ok(primary.concepts.length > 0, label)
      assert.ok(cPack.lessons.some(({ id }) => id === primary.packTopic), label)
      report.classified += 1
      if (primary.category === item.expected) report.correct += 1
      else report.incorrect += 1
    } else {
      assert.deepEqual(primary.concepts, [], label)
      report.abstained += 1
    }
  }
  assert.deepEqual(report, { classified: 35, correct: 35, incorrect: 0, abstained: 15, classifiedExpected: 36 })
})

test('format guidance requires a matching compiler option and warnings do not enter error history', async () => {
  const message = "/fixture.c:3:20: warning: format specifies type 'int' but the argument has type 'double'"
  for (const compileOutput of [message, message + ' [-Wformat-security]']) {
    const [diagnostic] = diagnose(run({ status: 'success', exitCode: 0, compileOutput }))
    assert.equal(diagnostic.confidence, 'uncertain')
    assert.equal(diagnostic.guidance, undefined)
    assert.equal(diagnostic.raw, compileOutput)
  }
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-format-'))
  try {
    const service = new LearningService(join(directory, 'learning.json'), packs)
    const feedback = await service.observe({
      path: '/fixture.c', sourceHash: digest('format example'),
      result: run({ status: 'success', exitCode: 0, compileOutput: message + ' [-Wformat]' }),
    })
    assert.equal(feedback.diagnostics[0].category, 'format-argument-type')
    assert.equal(feedback.diagnostics[0].severity, 'warning')
    assert.equal(feedback.diagnostics[0].occurrence, undefined)
    assert.deepEqual((await service.getHistory()).categories, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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

test('Problems reuses bounded compiler diagnostics without depending on learning or parsing program output', () => {
  const file = 'C:\\Workspace with spaces\\fixture.c'
  const error = file + ":2:9: error: expected ';' after expression"
  const result = run({ compileOutput: error, programOutput: '/private.c:7:8: error: untrusted runtime text' })
  assert.deepEqual(compilerProblems(result, 'c'), [{
    raw: error, severity: 'error', location: { file, line: 2, column: 9 },
  }])
  const invalidLine = '/fixture.c:99999999999999999999:1: error: invalid'
  assert.deepEqual(compilerProblems(run({ compileOutput: invalidLine }), 'c'), [
    { raw: invalidLine, severity: 'error' },
  ])
  const output = Array.from({ length: 28 }, (_, i) => `/fixture.c:${i + 1}: warning: compiler note`).join('\n')
  const warningOnly = compilerProblems(run({ compiler: 'gcc.exe', compileOutput: output }), 'c')
  assert.equal(warningOnly.length, 24)
  assert.equal(warningOnly[0].severity, 'error', 'An unsuccessful compile still exposes its raw report.')
  assert.equal(warningOnly[1].location?.line, 1)
  assert.ok(warningOnly[0].raw.length <= 2200)
  assert.deepEqual(compilerProblems(run({ status: 'runtime-error', programOutput: error }), 'c'), [])
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
      result: run({ status: 'success', exitCode: 0, message: 'Program exited successfully.', compileVerified: true }),
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
    const crash = run({ status: 'runtime-error', programSignal: 'SIGSEGV', compileVerified: true })
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

test('C retries compare real tokens while preserving strings, punctuators and uncertain preprocessor input', () => {
  const hash = (source: string) => cRetryFingerprint(source, digest(source))
  const original = '#include <stdio.h>\nint main(void) { puts("keep // text"); return + +count }'
  const cosmetic = '#include <stdio.h>\n// explain the check\nint main ( void ) { puts("keep // text"); /* no edit */ return  + + count }'
  assert.ok(hash(original))
  assert.equal(hash(cosmetic), hash(original))
  assert.notEqual(hash(original.replace('keep // text', 'edit // text')), hash(original))
  assert.notEqual(hash(original.replace('+ +count', '++count')), hash(original))
  assert.notEqual(hash('int value = 1e+2'), hash('int value = 1e + 2'))
  assert.notEqual(hash('char *text = L"x"'), hash('char *text = L "x"'))
  for (const source of [
    '#define CHECK(x) #x\nCHECK(a + b)',
    'char *bad = "unterminated',
    'int a; /* unterminated',
    'int a = __LINE__',
    'int a = 1\\\n2',
    'int a ??= 2',
    'a'.repeat(128 * 1024 + 1),
  ]) assert.equal(hash(source), undefined)
  assert.equal(cRetryFingerprint(original, digest(cosmetic)), undefined, 'The run snapshot must match.')
})

test('cosmetic C retries survive relaunch without adding history, and old history can acquire a token hash', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-c-retry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'learning.json')
  const path = '/fixture.c'
  const result = run({ compileOutput: path + ":2:23: error: expected ';' after return statement" })
  const original = '#include <stdio.h>\nint main(void) { return 0 }'
  const cosmetic = '#include <stdio.h>\nint main ( void ) { /* comment */ return   0 }'
  const first = new LearningService(file)
  // A version 1 history from before token hashes keeps its exact retry behavior.
  assert.equal((await first.observe({ path, sourceHash: digest(original), result })).diagnostics[0].occurrence, 'new')
  let readCount = 0
  const observe = (service: LearningService, source: string, value = result) => service.observe({
    path, sourceHash: digest(source), result: value,
    readSource: async () => { readCount += 1; return source },
  })
  assert.equal((await observe(first, original)).diagnostics[0].occurrence, 'unchanged')
  const reloaded = new LearningService(file)
  const beforeCosmetic = await stat(file, { bigint: true })
  assert.equal((await observe(reloaded, cosmetic)).diagnostics[0].occurrence, 'unchanged')
  assert.equal((await stat(file, { bigint: true })).ino, beforeCosmetic.ino)
  assert.equal((await observe(reloaded, original.replace('return 0', 'return 1'))).diagnostics[0].occurrence, 'repeated')
  assert.equal((await observe(reloaded, cosmetic)).diagnostics[0].occurrence, 'unchanged')
  assert.equal(readCount, 4)
  const success = await observe(reloaded, 'int main(void) { return 0; }',
    run({ status: 'success', compileVerified: true, exitCode: 0 }))
  assert.equal(readCount, 4, 'Successful compilation should not read source for retry comparison.')
  assert.deepEqual(success.resolved, ['missing-semicolon'])
  assert.deepEqual((await reloaded.getHistory()).categories, [
    { category: 'missing-semicolon', encountered: 2, repeated: 1, resolved: 1 },
  ])
  assert.doesNotMatch(await readFile(file, 'utf8'), /stdio|return 0|comment|fixture\.c/)
})

test('ambiguous C source changes cannot increment a known episode without comparable token evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-uncertain-retry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new LearningService(join(directory, 'learning.json'), packs)
  const path = '/fixture.c'
  const result = run({ compileOutput: path + ":2:23: error: expected ';' after return statement" })
  const observe = (source: string, read = source) => service.observe({
    path, sourceHash: digest(source), result, readSource: async () => read,
  })
  const macro = '#define SCORE 0\nint main(void) { return SCORE }'
  assert.equal((await observe(macro)).diagnostics[0].occurrence, 'new')
  assert.equal((await observe(macro.replace('SCORE 0', 'SCORE  0'))).diagnostics[0].occurrence, 'unchanged')
  assert.equal((await observe(macro.replace('SCORE 0', 'SCORE 1'))).diagnostics[0].occurrence, 'unchanged')
  const supported = 'int main(void) { return 0 }'
  assert.equal((await observe(supported, 'external change after compilation')).diagnostics[0].occurrence, 'unchanged')
  assert.deepEqual((await service.getHistory()).categories, [
    { category: 'missing-semicolon', encountered: 1, repeated: 0, resolved: 0 },
  ])
  assert.equal((await observe(supported)).diagnostics[0].occurrence, 'unchanged')
  assert.equal((await observe(supported.replace('return 0', 'return 1'))).diagnostics[0].occurrence, 'repeated')
  assert.deepEqual((await service.getHistory()).categories, [
    { category: 'missing-semicolon', encountered: 2, repeated: 1, resolved: 0 },
  ])
})

test('C resolutions require complete compiler evidence and unknown errors preserve raw text without creating history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const storage = join(directory, 'learning.json')
  const service = new LearningService(storage, packs)
  const path = '/fixture.c'
  const recognized = path + ":1:23: error: expected ';' after return statement"
  const observe = (source: string, result: RunResult) => service.observe({ path, sourceHash: digest(source), result })
  const incomplete = await observe('incomplete', run({ compileOutput: recognized, outputComplete: false }))
  assert.equal(incomplete.diagnostics[0].raw, recognized)
  assert.equal(incomplete.diagnostics[0].confidence, 'uncertain')
  assert.equal(incomplete.diagnostics[0].occurrence, undefined)
  const unrecognized = path + ':1:1: error: unknown compiler error'
  const unknown = await observe('unknown', run({ compileOutput: unrecognized }))
  assert.equal(unknown.diagnostics[0].raw, unrecognized)
  assert.equal(unknown.diagnostics[0].confidence, 'uncertain')
  assert.deepEqual((await service.getHistory()).categories, [])
  assert.equal((await observe('known', run({ compileOutput: recognized }))).diagnostics[0].occurrence, 'new')
  const compilerResolutions = (feedback: Awaited<ReturnType<typeof observe>>) =>
    feedback.resolved.filter((category) => category !== 'unclassified-runtime')
  for (const unsuccessful of [
    run({ compileOutput: unrecognized }),
    run({ status: 'timeout', outputComplete: false }),
    run({ status: 'output-limit', outputComplete: false }),
    run({ status: 'success', exitCode: 0 }),
    run({ status: 'runtime-error', outputComplete: false }),
    run({ status: 'success', compileVerified: true, compileOutput: unrecognized }),
  ]) assert.deepEqual(compilerResolutions(await observe('unverified', unsuccessful)), [])
  assert.equal((await service.getHistory()).categories[0].resolved, 0)
  assert.deepEqual((await observe('verified', run({ status: 'success', compileVerified: true, exitCode: 0 }))).resolved,
    ['missing-semicolon'])
  assert.deepEqual((await observe('same verified source', run({ status: 'success', compileVerified: true, exitCode: 0 }))).resolved, [])
  assert.equal((await new LearningService(storage, packs).getHistory()).categories[0].resolved, 1)
})

test('Run Console emits compile evidence after a real completed child, never after failure, truncation, or an interpreted run', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-compile-stage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const runner = new InteractiveRunner(join(directory, 'missing-pty-helper'), { compileMs: 5000, programMs: 5000, outputBytes: 1024 })
  const command = (source: string) => ({ executable: process.execPath, args: ['-e', source] })
  const plan: RunPlan = { label: 'C', cwd: directory, language: 'c', toolchain: process.execPath, run: command('') }
  const execute = (compile?: string) => runner.run({ ...plan, compile: compile === undefined ? undefined : command(compile) },
    () => {}, new AbortController().signal)
  assert.equal((await execute('process.exit(0)')).compileVerified, true)
  const failure = await execute('process.exit(1)')
  assert.equal(failure.status, 'compile-error')
  assert.equal(failure.compileVerified, undefined)
  const truncated = await execute("process.stdout.write('a'.repeat(4096))")
  assert.equal(truncated.status, 'output-limit')
  assert.equal(truncated.compileVerified, undefined)
  assert.equal((await execute()).compileVerified, undefined)
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
