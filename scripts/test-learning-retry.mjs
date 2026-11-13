import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const { values } = parseArgs({ options: { source: { type: 'string', default: '.' }, out: { type: 'string' } } })
const source = resolve(values.source)
const scratch = await mkdtemp(join(tmpdir(), 'ion-retry-control-'))
const report = { complete: false, source, method: 'Real LearningService persistence with recorded reviewed tool diagnostics, not a fresh compiler benchmark.', cases: [] }
try {
  const modulePath = join(scratch, 'learning.cjs')
  await build({ entryPoints: [join(source, 'src/main/learning/index.ts')], outfile: modulePath, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' })
  const { LearningService } = createRequire(import.meta.url)(modulePath)
  const corpus = JSON.parse(await readFile('test/fixtures/language-diagnostics.json', 'utf8'))
  for (const [id, text, comment] of [
    ['java-name', 'class Fixture { int attempt = 0; int x = missing; }', '// note\n'],
    ['python-name', 'attempt = 0\nprint(missing)\n', '# note\n'],
    ['js-name', 'let attempt = 0; console.log(missing);', '// note\n'],
  ]) {
    const fixture = corpus.find(item => item.id === id)
    const file = join(scratch, fixture.language + '.json')
    let service = new LearningService(file)
    const result = { status: fixture.phase === 'compile' ? 'compile-error' : 'runtime-error', compiler: fixture.compiler,
      compileOutput: fixture.phase === 'compile' ? fixture.output : '', programOutput: fixture.phase === 'runtime' ? fixture.output : '',
      exitCode: 1, durationMs: 1, message: 'Recorded diagnostic fixture' }
    const observe = async sourceText => (await service.observe({ path: fixture.path, language: fixture.language, result,
      sourceHash: createHash('sha256').update(sourceText).digest('hex'), readSource: async () => sourceText })).diagnostics[0].occurrence
    const first = await observe(text)
    service = new LearningService(file)
    const cosmetic = await observe(comment + text)
    const meaningful = await observe(text.replace('= 0', '= 1'))
    const repeated = (await service.getHistory()).categories.find(item => item.category === fixture.expected)?.repeated
    report.cases.push({ language: fixture.language, first, cosmetic, meaningful, repeated })
  }
  assert.ok(report.cases.every(item => item.first === 'new' && item.cosmetic === 'unchanged' && item.meaningful === 'repeated' && item.repeated === 1),
    'Cosmetic retries must not inflate persisted repeated mistakes.')
  report.complete = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally {
  await rm(scratch, { recursive: true, force: true })
  if (values.out) { const path = resolve(values.out); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n') }
}
console.log(JSON.stringify(report))
