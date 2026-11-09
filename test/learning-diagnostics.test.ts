import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { LearningService } from '../src/main/learning'
import { diagnose } from '../src/main/learning/diagnostics'
import type { RunResult } from '../src/shared/contracts'
import type { DiagnosticCategory } from '../src/shared/learning'
import type { RunLanguage } from '../src/shared/run-console'

interface Fixture {
  id: string
  language: RunLanguage
  compiler: string
  path: string
  phase: 'compile' | 'runtime'
  expected: DiagnosticCategory
  output: string
}

const fixtures = () => readFile(resolve('test/fixtures/language-diagnostics.json'), 'utf8')
  .then((data) => JSON.parse(data) as Fixture[])

function result(fixture: Fixture, changes: Partial<RunResult> = {}): RunResult {
  return {
    status: fixture.phase === 'compile' ? 'compile-error' : 'runtime-error',
    compiler: fixture.compiler,
    compileOutput: fixture.phase === 'compile' ? fixture.output : '',
    programOutput: fixture.phase === 'runtime' ? fixture.output : '',
    exitCode: 1,
    durationMs: 1,
    message: 'Tool exited with code 1.',
    ...changes,
  }
}

test('recorded Java, Python, C++, and Node.js failures map to existing lessons or abstain', async () => {
  const corpus = await fixtures()
  assert.equal(corpus.length, 29)
  const languages = [...new Set(corpus.map(({ language }) => language))]
  const lessons = new Map(await Promise.all(languages.map(async (language) => {
    const data = await readFile(resolve('src/main/learning/catalog', language + '.json'), 'utf8')
    const pack = JSON.parse(data) as { lessons: Array<{ id: string }> }
    return [language, new Set(pack.lessons.map(({ id }) => id))] as const
  })))
  for (const fixture of corpus) {
    const [diagnostic] = diagnose(result(fixture), fixture.language, fixture.path)
    const { id, language, phase, expected } = fixture
    assert.equal(diagnostic.language, language, id)
    assert.equal(diagnostic.phase, phase, id)
    assert.equal(diagnostic.category, expected, id)
    const originalLine = diagnostic.raw.split('\n')[phase === 'runtime' ? 1 : 0]
    assert.ok(originalLine && fixture.output.includes(originalLine), id)
    if (expected.startsWith('unclassified')) {
      assert.equal(diagnostic.confidence, 'uncertain', id)
      assert.equal(diagnostic.packTopic, undefined, id)
      assert.equal(diagnostic.guidance, undefined, id)
    } else {
      assert.equal(diagnostic.confidence, 'high', id)
      assert.ok(diagnostic.location?.line, id)
      assert.ok(diagnostic.packTopic && lessons.get(language)?.has(diagnostic.packTopic), id)
      assert.ok(diagnostic.guidance, id)
    }
  }
})

test('diagnostics require the reviewed tool, matching source, and complete trace evidence', async () => {
  const corpus = await fixtures()
  const java = corpus.find(({ id }) => id === 'java-name')!
  const python = corpus.find(({ id }) => id === 'python-name')!
  const js = corpus.find(({ id }) => id === 'js-name')!
  const cases = [
    diagnose(result(java, { compiler: 'mvn' }), java.language, java.path),
    diagnose(result(python, { programOutput: "NameError: name 'missing' is not defined" }), python.language, python.path),
    diagnose(result(python, { outputComplete: false }), python.language, python.path),
    diagnose(result(js), js.language, '/somewhere-else/fixture.cjs'),
    diagnose(result(js, { exitCode: 7 }), js.language, js.path),
    diagnose(result(js, { programOutput: js.output.replace(/Node\.js v[^\n]+$/, '') }), js.language, js.path),
  ]
  for (const [diagnostic] of cases) {
    assert.equal(diagnostic.confidence, 'uncertain')
    assert.equal(diagnostic.packTopic, undefined)
    assert.ok(diagnostic.raw)
  }
  const [colored] = diagnose(result(python, { programOutput: python.output.replace(/^NameError:/m, '\x1b[35mNameError:\x1b[0m') }), python.language, python.path)
  assert.equal(colored.category, 'python-undefined-name')
  assert.doesNotMatch(colored.raw, /\x1b/)
})

test('Node file URLs and compiler paths work with Windows paths and spaces', async () => {
  const corpus = await fixtures()
  const node = corpus.find(({ id }) => id === 'js-esm-name')!
  const file = 'C:\\Workspace with spaces\\fixture.mjs'
  const [runtime] = diagnose(result(node, {
    compiler: 'C:\\Program Files\\nodejs\\node.exe',
    programOutput: node.output.replaceAll('file:///workspace%20with%20spaces/', 'file:///c:/Workspace%20with%20spaces/'),
  }), 'javascript', file)
  assert.equal(runtime.category, 'javascript-undefined-name')
  assert.equal(runtime.location?.file, file)
  const java = corpus.find(({ id }) => id === 'java-name')!
  const path = 'C:\\Workspace with spaces\\Fixture.java'
  const [compiler] = diagnose(result(java, {
    compiler: 'C:\\Program Files\\JDK\\bin\\javac.exe', compileOutput: java.output.replace(java.path, path),
  }), 'java', path)
  assert.equal(compiler.category, 'java-unresolved-variable')
  assert.equal(compiler.location?.file, path)
})

test('language diagnostics retain history and resolve a runtime failure only after success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-language-diagnostics-'))
  try {
    const file = join(directory, 'learning.json')
    const corpus = await fixtures()
    const runtime = corpus.find(({ id }) => id === 'java-null')!
    const compilation = corpus.find(({ id }) => id === 'java-name')!
    const service = new LearningService(file)
    const observe = (source: string, input: RunResult, instance = service) => instance.observe({
      path: runtime.path, language: runtime.language, result: input,
      sourceHash: createHash('sha256').update(source).digest('hex'),
    })
    const first = await observe('first edit', result(runtime))
    assert.equal(first.language, 'java')
    assert.equal(first.diagnostics[0].occurrence, 'new')
    assert.equal((await observe('first edit', result(runtime))).diagnostics[0].occurrence, 'unchanged')
    assert.equal((await observe('second edit', result(runtime))).diagnostics[0].occurrence, 'repeated')
    assert.deepEqual((await observe('compile failure', result(compilation))).resolved, [])
    const reloaded = new LearningService(file)
    const fixed = await observe('successful edit', result(runtime, { status: 'success', exitCode: 0, programOutput: '' }), reloaded)
    assert.deepEqual(new Set(fixed.resolved), new Set(['java-null-reference', 'java-unresolved-variable']))
    assert.ok((await reloaded.getHistory()).categories.some(({ category, repeated, resolved }) =>
      category === 'java-null-reference' && repeated === 1 && resolved === 1))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
