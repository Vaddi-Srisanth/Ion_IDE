import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ExplanationRequest } from '../src/shared/explanations'
import type { PackLesson } from '../src/shared/learning-packs'
import type { ProjectLensReference, ProjectLensSnapshot } from '../src/shared/project-lens'
import { prepareContext, type ExplanationContextOptions } from '../src/main/explanations/context'
import { WorkspaceFiles, revision } from '../src/main/files'
import { ProjectLensSession } from '../src/main/project-lens/session'

const signal = () => new AbortController().signal
const tutor = (more = {}): ExplanationRequest => ({ purpose: 'tutor', action: 'concept', question: 'Explain this evidence.', ...more })
const lesson: PackLesson = { id: 'values', title: 'Values', section: 'Syntax', explanation: 'Names refer to values.',
  example: 'print(3)', practice: 'Predict the output.', api: [] }
const safe = /selected explanation context/

async function fixture(t: TestContext, scope = new WorkspaceFiles()) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-explanation-context-')))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'workspace'), other = join(scratch, 'other')
  await mkdir(root); await mkdir(other); await mkdir(join(root, 'src'))
  const path = join(root, 'src', 'main.py')
  await writeFile(path, 'print("first")\nprint("second")\n')
  await writeFile(join(root, 'package.json'), '{"name":"safe-fixture","dependencies":{"react":"19"}}')
  await writeFile(join(other, 'private.py'), 'private content')
  await scope.grant(root, 'folder')
  const session = new ProjectLensSession(() => state.scope)
  const state = { current: true, scope, lesson: structuredClone(lesson), snapshot: null as ProjectLensSnapshot | null,
    lessonCalls: 0, lensCalls: 0, opened: [] as ProjectLensReference[] }
  const snapshot = await session.analyze(root)
  state.snapshot = snapshot
  let live = true
  t.after(() => session.close())
  const options: ExplanationContextOptions = {
    scope: () => state.scope, isCurrent: () => state.current,
    lesson: async (packId, lessonId) => { state.lessonCalls++; assert.equal(packId, 'python'); assert.equal(lessonId, 'values'); return state.lesson },
    lens: async requested => {
      state.lensCalls++; assert.equal(requested, root)
      return { snapshot: state.snapshot!, validate: async () => { if (!live) throw new Error('private raw lease failure') },
        openReference: async reference => { state.opened.push(reference); return session.openReference(root, reference) } }
    },
  }
  const reference = snapshot.files.find(item => item.reference.path === 'src/main.py')!.reference
  const project = (refs: ProjectLensReference[] = [reference]): ExplanationRequest => ({ purpose: 'project-lens', action: 'understand',
    question: 'Describe the supplied source.', project: { root, refs } })
  return { scratch, root, other, path, scope, state, options, reference, project, invalidate: () => { live = false } }
}

test('question-only and explicit lesson/buffer context preserve authoritative and provided-evidence distinctions', async t => {
  const f = await fixture(t)
  const question = await prepareContext(tutor(), signal(), f.options)
  assert.deepEqual(question.input.sources, [])
  assert.equal(f.state.lessonCalls, 0); assert.equal(f.state.lensCalls, 0)
  const noProject = await prepareContext({ purpose: 'project-lens', action: 'health', question: 'What evidence would help?' }, signal(), f.options)
  assert.deepEqual(noProject.input.sources, [])
  assert.ok(noProject.exclusions.some(row => row.includes('remain unknown')))
  assert.equal(f.state.lensCalls, 0)
  const request = tutor({ lesson: { packId: 'python', lessonId: 'values' }, code: { path: f.path,
    label: 'main.py (unsaved)', text: 'print("unsaved")', version: 7 }, diagnostic: 'SyntaxError: expected colon' })
  const context = await prepareContext(request, signal(), f.options)
  assert.deepEqual(context.input.sources.map(source => source.origin), ['lesson', 'editor-buffer', 'diagnostic'])
  assert.match(context.input.sources[0].text, /Names refer to values/)
  assert.equal(context.input.sources[1].text, 'print("unsaved")')
  assert.notEqual(await readFile(f.path, 'utf8'), context.input.sources[1].text)
  assert.ok(context.exclusions.some(row => row.includes('renderer-provided, unverified')))
  assert.ok(context.exclusions.some(row => row.includes('not independent proof')))
  assert.doesNotMatch(JSON.stringify(context.input), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(Object.isFrozen(context.input.sources[0]), true)
  const source = context.input.sources[1]
  assert.deepEqual(await context.openCitation({ sourceId: source.id, startLine: 1, endLine: 1 }),
    { label: 'main.py (unsaved)', text: 'print("unsaved")' })
  const selectedLesson = context.input.sources[0]
  assert.deepEqual((await context.openCitation({ sourceId: selectedLesson.id, startLine: 1, endLine: 1 })).lesson,
    { packId: 'python', lessonId: 'values' })
})

test('Ask Ion context can include only a question and one optional editor excerpt', async t => {
  const f = await fixture(t)
  const request: ExplanationRequest = { purpose: 'ask', action: 'ask-question', question: 'What is a pure function?' }
  const question = await prepareContext(request, signal(), f.options)
  assert.deepEqual(question.input, { ...request, sources: [] })
  const code = { path: f.path, label: 'main.py', text: 'print("selected editor excerpt")', version: 9 }
  const selected = await prepareContext({ ...request, code }, signal(), f.options)
  assert.equal(selected.input.sources.length, 1)
  assert.equal(selected.input.sources[0].origin, 'editor-buffer')
  assert.equal(selected.input.sources[0].text, code.text)
  for (const extra of [{ question: ' \n ' }, { action: 'hint' }, { lesson: { packId: 'python', lessonId: 'values' } },
    { diagnostic: 'error' }, { project: { root: f.root, refs: [] } }]) {
    await assert.rejects(prepareContext({ ...request, ...extra }, signal(), f.options), safe)
  }
  assert.equal(f.state.lessonCalls, 0)
  assert.equal(f.state.lensCalls, 0)
})

test('project sources require exact snapshot membership; citations open existing evidence without grants', async t => {
  const f = await fixture(t)
  const context = await prepareContext(f.project(), signal(), f.options)
  assert.deepEqual(context.input.sources.map(source => source.origin), ['structure', 'saved-file'])
  assert.match(context.input.sources[0].text, /do not prove/)
  const source = context.input.sources[1]
  assert.equal(source.text, await readFile(f.path, 'utf8'))
  assert.match(source.id, /^source-/); assert.ok(!source.id.includes('main.py'))
  const opened = await context.openCitation({ sourceId: source.id, startLine: 2, endLine: 2 })
  assert.equal(opened.entry?.path, f.path)
  assert.deepEqual(opened.range, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 16 })
  assert.equal(f.scope.authorizes(join(f.other, 'private.py')), false)
  assert.deepEqual(f.state.opened, [f.reference])
  await assert.rejects(context.openCitation({ sourceId: source.id, startLine: 0, endLine: 1 }), safe)
  await assert.rejects(context.openCitation({ sourceId: source.id, startLine: 1, endLine: 999 }), safe)
  await assert.rejects(context.openCitation({ sourceId: 'invented', startLine: 1, endLine: 1 }), safe)
  await assert.rejects(context.openCitation({ sourceId: source.id, startLine: 1, endLine: 1, path: f.path } as never), safe)
  const structureOnly = await prepareContext(f.project([]), signal(), f.options)
  assert.equal(structureOnly.input.sources.length, 1)
  await assert.rejects(prepareContext(f.project([{ ...f.reference, revision: 'forged' }]), signal(), f.options), safe)
  await assert.rejects(prepareContext(f.project([{ ...f.reference, path: '../other/private.py' }]), signal(), f.options), safe)
  await assert.rejects(prepareContext(f.project([{ ...f.reference, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } }]), signal(), f.options), safe)
})

test('changed sources, lessons, lease, scope, root identity and owner invalidate pending reviews', async t => {
  const f = await fixture(t)
  const context = await prepareContext(f.project(), signal(), f.options)
  await writeFile(f.path, 'different source')
  await assert.rejects(context.validate(), safe)
  await assert.rejects(context.openCitation({ sourceId: context.input.sources[1].id, startLine: 1, endLine: 1 }), safe)
  const localLesson = await prepareContext(tutor({ lesson: { packId: 'python', lessonId: 'values' } }), signal(), f.options)
  f.state.lesson.explanation = 'Changed after review.'
  await assert.rejects(localLesson.validate(), safe)
  const context2 = await prepareContext(f.project([]), signal(), f.options)
  f.invalidate()
  await assert.rejects(context2.validate(), safe)
  const question = await prepareContext(tutor(), signal(), f.options)
  f.state.current = false
  await assert.rejects(question.validate(), safe)
  f.state.current = true
  f.state.scope = new WorkspaceFiles()
  await assert.rejects(question.validate(), safe)
  f.state.scope = f.scope
  const anchored = await prepareContext(tutor(), signal(), f.options)
  await rename(f.root, join(f.scratch, 'old-workspace')); await mkdir(f.root)
  await assert.rejects(anchored.validate(), safe)
})

test('source prefixes are bounded to 8 KiB and safely stop before a split UTF-8 character', async t => {
  const f = await fixture(t)
  await writeFile(f.path, 'a'.repeat(8191) + '🌟' + 'x'.repeat(10_000))
  const inspected = await f.scope.inspect(f.path, 'file')
  const ref = { ...f.reference, revision: revision(inspected.stats) }
  f.state.snapshot = { ...f.state.snapshot!, files: [{ reference: ref, language: 'python', bytes: 18_195 }] }
  const context = await prepareContext(f.project([ref]), signal(), f.options)
  assert.equal(context.input.sources[1].text, 'a'.repeat(8191))
  assert.ok(context.exclusions.some(row => row.includes('first 8 KiB')))
  await writeFile(f.path, Buffer.alloc(2 * 1024 * 1024 + 1, 97))
  const large = { ...ref, revision: revision((await f.scope.inspect(f.path, 'file')).stats) }
  f.state.snapshot.files[0].reference = large
  await assert.rejects(prepareContext(f.project([large]), signal(), f.options), safe)
})

test('sensitive, generated, document, notebook and malformed/binary source content is rejected', async t => {
  const f = await fixture(t)
  const originals = f.state.snapshot!
  const cases = [['.env', 'PRIVATE=hidden'], ['credentials.py', 'private'], ['package-lock.json', '{}'],
    ['result.generated.py', 'generated'], ['notes.docx', 'PK'], ['work.ipynb', '{}'],
    ['plain.py', '-----BEGIN PRIVATE KEY-----\nprivate'], ['plain.py', 'api_key = "synthetic-secret-value"'],
    ['plain.py', Buffer.from([0xff, 0xfe])], ['plain.py', Buffer.from([65, 0, 66])], ['plain.py', 'a\u001bb']]
  for (const [name, value] of cases) {
    const path = join(f.root, name as string)
    await writeFile(path, value)
    const ref = { path: name as string, revision: revision((await f.scope.inspect(path, 'file')).stats) }
    f.state.snapshot = { ...originals, files: [{ reference: ref, language: 'python', bytes: 1 }] }
    await assert.rejects(prepareContext(f.project([ref]), signal(), f.options), safe, name as string)
  }
  await mkdir(join(f.root, 'node_modules')); await writeFile(join(f.root, 'node_modules', 'module.js'), 'module code')
  const dependency = { path: 'node_modules/module.js', revision: revision((await f.scope.inspect(join(f.root, 'node_modules', 'module.js'), 'file')).stats) }
  f.state.snapshot = { ...originals, files: [{ reference: dependency, language: 'javascript', bytes: 1 }] }
  await assert.rejects(prepareContext(f.project([dependency]), signal(), f.options), safe)
})

test('symlink replacements cannot substitute outside content or create new grants', async t => {
  const f = await fixture(t)
  await rm(f.path)
  try { await symlink(join(f.other, 'private.py'), f.path) }
  catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
      t.skip('Windows symlink permission unavailable.'); return
    }
    throw error
  }
  await assert.rejects(prepareContext(f.project(), signal(), f.options), safe)
  assert.equal(f.scope.authorizes(join(f.other, 'private.py')), false)
})

test('cancellation after a file handle is open closes it; failures never echo private paths', async t => {
  class AbortScope extends WorkspaceFiles {
    inspectHook?: () => void
    override async inspect(...args: Parameters<WorkspaceFiles['inspect']>) {
      const result = await super.inspect(...args)
      this.inspectHook?.()
      return result
    }
  }
  const scope = new AbortScope(), f = await fixture(t, scope), controller = new AbortController()
  let directoryChecks = 0
  // This verified sequence reaches the post-open ancestor checks after fstat.
  // Failed/cancelled filesystem awaits must unwind the finally-owned handle.
  scope.inspectHook = () => { if (++directoryChecks === 9) controller.abort() }
  let before: number | undefined
  try { before = (await readdir(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')).length } catch {}
  await assert.rejects(prepareContext(f.project(), controller.signal, f.options), error => {
    assert.match(String(error), safe); assert.ok(!String(error).includes(f.root)); return true
  })
  assert.equal(controller.signal.aborted, true)
  scope.inspectHook = undefined
  if (before !== undefined) {
    const after = (await readdir(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')).length
    assert.ok(after <= before, 'The disposable source handle was closed after cancellation.')
  }
  const stopped = new AbortController(); stopped.abort()
  await assert.rejects(prepareContext(tutor(), stopped.signal, f.options), safe)
  const context = await prepareContext(tutor(), controller.signal.aborted ? signal() : controller.signal, f.options)
  assert.equal(context.input.sources.length, 0)
})

test('input schema, source totals, explicit root and lesson validation reject spoofed claims before disclosure', async t => {
  const f = await fixture(t)
  const bad: unknown[] = [tutor({ sources: [{ text: 'spoofed' }] }), tutor({ question: 'é'.repeat(1025) }),
    tutor({ purpose: 'project-lens' }), tutor({ action: 'health' }), tutor({ code: { label: 'x', text: 'x', version: -1 } }),
    tutor({ code: { label: '/private/name.py', text: 'x', version: 1 } }),
    tutor({ code: { label: 'x', text: 'x'.repeat(8193), version: 1 } }),
    tutor({ code: { label: 'x', path: join(f.other, 'private.py'), text: 'x', version: 1 } }),
    tutor({ lesson: { packId: 'python', lessonId: 'values', text: 'spoofed lesson' } }),
    { ...f.project(), project: { root: f.other, refs: [] } }, f.project(Array(5).fill(f.reference)), f.project([f.reference, f.reference])]
  for (const request of bad) await assert.rejects(prepareContext(request, signal(), f.options), safe)
  f.state.lesson.id = 'wrong'
  await assert.rejects(prepareContext(tutor({ lesson: { packId: 'python', lessonId: 'values' } }), signal(), f.options), safe)
  const refs = []
  for (let i = 0; i < 4; i++) {
    const path = join(f.root, 'many' + i + '.py'); await writeFile(path, 'x'.repeat(8192))
    refs.push({ path: 'many' + i + '.py', revision: revision((await f.scope.inspect(path, 'file')).stats) })
  }
  f.state.snapshot = { ...f.state.snapshot!, files: refs.map(reference => ({ reference, language: 'python', bytes: 8192 })) }
  await assert.rejects(prepareContext(f.project(refs), signal(), f.options), safe)
})

test('structure-only context shares actual bounded snapshot paths and declared candidates without unselected contents or renderer summaries', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'docs')); await mkdir(join(f.root, 'tests'))
  await writeFile(join(f.root, 'docs', 'guide.md'), 'UNSELECTED_DOCUMENT_CONTENT')
  await writeFile(join(f.root, 'tests', 'test_main.py'), 'UNSELECTED_TEST_CONTENT')
  await writeFile(f.path, '-----BEGIN PRIVATE KEY-----\nUNSELECTED_SOURCE_CONTENT')
  await writeFile(join(f.root, 'package.json'), '{"main":"src/main.py","module":"src/missing.js","dependencies":{"react":"19"}}')
  const nativeLens = new ProjectLensSession(() => f.scope)
  t.after(() => nativeLens.close())
  const snapshot = await nativeLens.analyze(f.root)
  f.options.lens = async root => nativeLens.lease(root)
  const context = await prepareContext(f.project([]), signal(), f.options)
  assert.equal(context.input.sources.length, 1)
  const excerpt = context.input.sources[0].text, summary = JSON.parse(excerpt)
  assert.ok(summary.files.some((item: { path: string }) => item.path === 'src/main.py'))
  assert.ok(summary.manifests.some((item: { path: string; kind: string }) => item.path === 'package.json' && item.kind === 'npm'))
  assert.ok(summary.entryPoints.some((item: { path: string; kind: string; declaredOrObservedAt: string }) =>
    item.path === 'src/missing.js' && item.kind === 'manifest-reference' && item.declaredOrObservedAt === 'package.json'))
  assert.ok(summary.entryPoints.some((item: { path: string; kind: string }) => item.path === 'src/main.py' && item.kind === 'existing-candidate'))
  assert.ok(summary.tests.includes('tests/test_main.py'))
  assert.ok(summary.documentation.includes('docs/guide.md'))
  assert.deepEqual(summary.counts, snapshot.counts)
  assert.ok(summary.limitations.some((value: string) => value.includes('Point-in-time')))
  assert.ok(summary.limitations.some((value: string) => value.includes('do not prove')))
  assert.doesNotMatch(excerpt, /PRIVATE KEY|UNSELECTED_|main\":|dependencies|\/Users\//)
  assert.ok(Buffer.byteLength(excerpt) <= 8192)
  await assert.rejects(prepareContext({ ...f.project([]), project: { root: f.root, refs: [], summary: 'invented project architecture' } }, signal(), f.options), safe)
  await assert.rejects(prepareContext({ ...f.project([]), structure: { files: ['invented.py'] } }, signal(), f.options), safe)
})

test('long UTF-8 metadata paths share one 8 KiB budget, omit whole items and report exact excerpt omission counts', async t => {
  const f = await fixture(t)
  let directory = f.root
  for (let depth = 0; depth < 4; depth++) {
    directory = join(directory, 'd' + depth + '界'.repeat(35)); await mkdir(directory)
  }
  for (let index = 0; index < 30; index++) await writeFile(join(directory, '文'.repeat(35) + index + '.py'), 'UNSELECTED_CONTENT')
  const nativeLens = new ProjectLensSession(() => f.scope)
  t.after(() => nativeLens.close())
  const snapshot = await nativeLens.analyze(f.root)
  f.options.lens = async root => nativeLens.lease(root)
  const context = await prepareContext(f.project([]), signal(), f.options)
  const excerpt = context.input.sources[0].text, summary = JSON.parse(excerpt)
  assert.ok(Buffer.byteLength(excerpt) <= 8192)
  assert.ok(summary.omittedItems.files > 0)
  assert.equal(summary.files.length + summary.omittedItems.files, snapshot.files.length)
  assert.equal(summary.manifests.length + summary.omittedItems.manifests, snapshot.manifests.length)
  assert.equal(summary.entryPoints.length + summary.omittedItems.entryPoints, snapshot.entryPoints.length)
  const actual = new Set(snapshot.files.map(file => file.reference.path))
  for (const row of summary.files) assert.ok(actual.has(row.path), 'Every retained path is an actual complete snapshot path.')
  assert.ok(summary.files.some((row: { path: string }) => Buffer.byteLength(row.path) > 500))
  assert.doesNotMatch(excerpt, /UNSELECTED_CONTENT|\.\.\./)
  assert.equal((await prepareContext(f.project([]), signal(), f.options)).input.sources[0].text, excerpt)
})

test('streaming consent selects only the transport and never enters the source context', async t => {
  const f = await fixture(t)
  for (const selected of [undefined, false, true]) {
    const context = await prepareContext(tutor({ stream: selected }), signal(), f.options)
    assert.equal(context.stream, selected === true)
    assert.equal(Object.hasOwn(context.input, 'stream'), false)
    assert.deepEqual(context.input.sources, [])
  }
  for (const invalid of ['yes', 1, null, {}]) {
    await assert.rejects(prepareContext(tutor({ stream: invalid }), signal(), f.options), safe)
  }
  assert.equal(f.state.lessonCalls + f.state.lensCalls, 0)
})
