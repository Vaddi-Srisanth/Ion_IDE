import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LearningPackStore, learningLibraryDirectory, parseInstalledLibrary } from '../src/main/learning/catalog-store'
import { PracticeStore } from '../src/main/practice'

function pack(id: string, name = id, version = 1) {
  return {
    schema: 1, id, name, summary: 'A local language lesson.', version,
    lessons: [{ id: 'branches', title: 'Branches', section: 'Syntax',
      explanation: 'Choose which statement to execute.', example: 'if (ready) start();',
      api: [], practice: 'Write and test a branch.' }],
  }
}

function summary(definition: ReturnType<typeof pack>) {
  const { schema: _schema, lessons, ...fields } = definition
  return { ...fields, topicCount: lessons.length }
}

async function fixture(run: (profile: string, catalog: string, store: LearningPackStore) => Promise<void>) {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-direct-learning-'))
  try {
    const profile = join(scratch, 'profile'), catalog = join(scratch, 'catalog')
    await Promise.all([mkdir(profile), mkdir(catalog)])
    const definitions = ['c', 'java', 'python'].map((id) => pack(id))
    for (const definition of definitions) await writeFile(join(catalog, definition.id + '.json'), JSON.stringify(definition))
    await writeFile(join(catalog, 'index.json'), JSON.stringify(definitions.map(summary)))
    await run(profile, catalog, new LearningPackStore(profile, catalog))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

test('first direct Python, Java, and C selections materialize only the chosen pack and survive reopening', async () => {
  for (const id of ['python', 'java', 'c']) await fixture(async (profile, catalog, store) => {
    const directory = join(profile, learningLibraryDirectory)
    const initial = await store.getLibrary()
    assert.deepEqual(initial.installed, [])
    assert.equal(initial.selected, null)
    assert.equal((await store.select(null, false)).selected, null)
    await assert.rejects(readdir(directory), { code: 'ENOENT' })
    const selected = await store.select(id, false)
    assert.equal(selected.selected, id)
    assert.deepEqual(selected.catalog, [])
    assert.deepEqual(selected.installed.map((entry) => entry.id), [id])
    assert.deepEqual(selected.recent, [id])
    assert.equal((await readdir(directory)).filter((name) => name.startsWith('pack-')).length, 1)
    const registry = parseInstalledLibrary(await readFile(join(directory, 'library.json'), 'utf8'))
    const reopened = new LearningPackStore(profile, catalog)
    assert.equal(await reopened.isSelected(id), true)
    assert.equal((await reopened.getLesson(id, 'branches')).title, 'Branches')
    await reopened.select(id, false)
    assert.deepEqual(parseInstalledLibrary(await readFile(join(directory, 'library.json'), 'utf8')), registry)
  })
})

test('direct selection reads no other pack body and serializes concurrent requests without duplicate storage', { timeout: 5000 }, async () => {
  await fixture(async (profile, catalog, store) => {
    await writeFile(join(catalog, 'java.json'), 'unreadable')
    await store.select('python', false)
    await writeFile(join(catalog, 'java.json'), JSON.stringify(pack('java')))
    await Promise.all([store.select('java', false), store.select('c', false), store.select('python', false)])
    const library = await store.getLibrary()
    assert.equal(library.selected, 'python')
    assert.deepEqual(library.installed.map((entry) => entry.id), ['python', 'java', 'c'])
    assert.equal((await readdir(join(profile, learningLibraryDirectory))).filter((name) => name.startsWith('pack-')).length, 3)
  })
})

test('legacy profile selection preserves old installed bytes, version, history, preferences and local packs', async () => {
  await fixture(async (profile, catalog, store) => {
    const directory = join(profile, learningLibraryDirectory)
    await mkdir(directory)
    const previous = pack('c', 'Previous C')
    const local = pack('community', 'My imported lessons')
    await writeFile(join(directory, 'c.json'), JSON.stringify(previous))
    await writeFile(join(directory, 'community.json'), JSON.stringify(local))
    await writeFile(join(directory, 'library.json'), JSON.stringify({ schema: 1, selected: 'c', recent: ['c'],
      installed: [summary(previous), { ...summary(local), source: 'local' }] }))
    const protectedFiles = new Map<string, string>([
      [join(directory, 'c.json'), JSON.stringify(previous)],
      [join(directory, 'community.json'), JSON.stringify(local)],
      [join(profile, 'learning.json'), '{"version":1,"files":{},"categories":{},"topics":{}}'],
      [join(profile, 'preferences.json'), '{"autoSave":true,"learningLens":false}'],
    ])
    for (const [path, text] of protectedFiles) await writeFile(path, text)
    const next = pack('c', 'Newer C', 2)
    await writeFile(join(catalog, 'c.json'), JSON.stringify(next))
    await writeFile(join(catalog, 'index.json'), JSON.stringify([next, pack('java'), pack('python')].map(summary)))
    await store.select('python', false)
    await store.select('c', false)
    const library = await new LearningPackStore(profile, catalog).getLibrary()
    assert.equal(library.selected, 'c')
    assert.equal(library.installed.find((entry) => entry.id === 'c')?.version, 1)
    assert.equal(library.installed.find((entry) => entry.id === 'c')?.name, 'Previous C')
    assert.deepEqual(library.recent, ['c', 'python'])
    await store.select('community', false)
    assert.equal((await store.getLesson('community', 'branches')).title, 'Branches')
    for (const [path, text] of protectedFiles) assert.equal(await readFile(path, 'utf8'), text)
  })
})

test('an installed import keeps its identity even if a later bundled catalog reserves the same ID', async () => {
  await fixture(async (profile, catalog, store) => {
    const path = join(profile, 'community.json')
    const imported = pack('community', 'My local course')
    await writeFile(path, JSON.stringify(imported))
    await store.importFile(path)
    const registryPath = join(profile, learningLibraryDirectory, 'library.json')
    const before = parseInstalledLibrary(await readFile(registryPath, 'utf8')).installed[0]
    await writeFile(join(catalog, 'index.json'), JSON.stringify([pack('c'), pack('java'), pack('python'), pack('community', 'Bundled course', 2)].map(summary)))
    const library = await store.select('community', false)
    assert.equal(library.installed[0].name, 'My local course')
    assert.equal(library.installed[0].source, 'local')
    assert.equal(await store.isSelected('community'), false, 'Imported content does not enable built-in diagnostic interpretation')
    assert.deepEqual(parseInstalledLibrary(await readFile(registryPath, 'utf8')).installed[0], before)
  })
})

test('corrupt registries and missing installed content fail without replacing prior selection or data', async () => {
  await fixture(async (profile, _catalog, store) => {
    await store.install('c')
    await store.install('python')
    await store.select('python', false)
    const directory = join(profile, learningLibraryDirectory), registryPath = join(directory, 'library.json')
    const original = await readFile(registryPath, 'utf8')
    const installed = parseInstalledLibrary(original).installed.find((entry) => entry.id === 'c')!
    await rm(join(directory, 'pack-' + installed.storage, 'manifest.json'))
    await assert.rejects(store.select('c', false), /ENOENT/)
    assert.equal(await readFile(registryPath, 'utf8'), original)
    await writeFile(registryPath, '{"schema":1,"selected":"c","installed":[]}')
    const corrupt = await readFile(registryPath, 'utf8')
    await assert.rejects(store.select('java', false), /library could not be read/)
    assert.equal(await readFile(registryPath, 'utf8'), corrupt)
    assert.equal((await readdir(directory)).filter((name) => name.startsWith('pack-')).length, 2)
  })
})

test('invalid or missing bundled selections preserve the existing selection and create no extra content', async () => {
  await fixture(async (profile, catalog, store) => {
    await store.select('python', false)
    const registryPath = join(profile, learningLibraryDirectory, 'library.json')
    const original = await readFile(registryPath, 'utf8')
    await assert.rejects(store.select('../java', false), /Invalid learning pack/)
    await assert.rejects(store.select('missing', false), /catalog/)
    await rm(join(catalog, 'java.json'))
    await assert.rejects(store.select('java', false), /ENOENT/)
    await writeFile(join(catalog, 'c.json'), 'invalid')
    await assert.rejects(store.select('c', false), /UTF-8 JSON/)
    assert.equal(await readFile(registryPath, 'utf8'), original)
    assert.equal((await readdir(join(profile, learningLibraryDirectory))).filter((name) => name.startsWith('pack-')).length, 1)
  })
})

test('direct language selection preserves the existing exercise identity, notes, attempts and source', async () => {
  await fixture(async (profile, catalog, store) => {
    const practicePath = join(profile, 'practice')
    const practice = new PracticeStore(practicePath)
    const exercise = { title: 'Branches', topic: 'Syntax', difficulty: 'Easy' as const,
      statement: 'Write and test a branch.', samples: [{ label: 'Input', input: '1', expectedOutput: 'yes\n' }] }
    const first = await practice.startLearningExercise('python', 'branches', 'python', exercise)
    const saved = await practice.save({ ...first.problem, notes: 'Keep my reasoning', completion: 'In progress' })
    const second = await practice.createAttempt(saved.id, 'Another approach')
    const source = await practice.openAttempt(saved.id, second.attempt.id)
    await writeFile(source, '# keep my work\nprint("yes")\n')
    await store.select('java', false)
    await store.select('python', false)
    const reopened = new PracticeStore(practicePath)
    const again = await reopened.startLearningExercise('python', 'branches', 'python', exercise)
    assert.equal(again.problem.id, first.problem.id)
    assert.equal(again.attempt.id, second.attempt.id)
    assert.equal(again.problem.notes, 'Keep my reasoning')
    assert.equal(again.problem.completion, 'In progress')
    assert.deepEqual(again.problem.attempts.map((attempt) => attempt.id), [first.attempt.id, second.attempt.id])
    assert.equal(await readFile(source, 'utf8'), '# keep my work\nprint("yes")\n')
    assert.equal((await reopened.list()).problems.length, 1)
    assert.equal((await new LearningPackStore(profile, catalog).getLibrary()).selected, 'python')
  })
})
