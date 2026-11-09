import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { compileLearningCatalog, LearningPackStore, learningLibraryDirectory, maxLearningPackBytes, parseInstalledLibrary } from '../src/main/learning/catalog-store'

function pack(id: string, name: string) {
  return {
    schema: 1, id, name, summary: 'Learn control flow with a small example.', version: 1,
    lessons: [{
      id: 'branches', title: 'Branches', section: 'Syntax',
      explanation: 'A branch chooses which code to run.', example: 'if (ready) start();',
      api: [{ name: 'if', description: 'Runs its body when the condition is true.' }],
      practice: 'Add a branch that handles the opposite case.',
    }],
  }
}

async function withPacks(run: (profile: string, catalog: string) => Promise<void>) {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-pack-test-'))
  try {
    const catalog = join(scratch, 'catalog')
    const profile = join(scratch, 'profile')
    await mkdir(catalog)
    await mkdir(profile)
    const definitions = [pack('c', 'C'), pack('python', 'Python')]
    await Promise.all(definitions.map((item) => writeFile(join(catalog, item.id + '.json'), JSON.stringify(item))))
    await writeFile(join(catalog, 'index.json'), JSON.stringify(definitions.map(({ schema: _schema, lessons, ...summary }) =>
      ({ ...summary, topicCount: lessons.length }))))
    await run(profile, catalog)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

test('pack installation and language selection are separate, local, and durable', async () => {
  await withPacks(async (profile, catalog) => {
    const store = new LearningPackStore(profile, catalog)
    const initial = await store.getLibrary()
    assert.deepEqual(initial.catalog.map(({ id }) => id), ['c', 'python'])
    assert.deepEqual(initial.installed, [])
    assert.equal(initial.selected, null)
    assert.equal(await store.isSelected('c'), false)
    await assert.rejects(lstat(join(profile, learningLibraryDirectory)), { code: 'ENOENT' })
    await assert.rejects(store.select('c'), /Install/)
    await assert.rejects(store.getTopics('c'), /Install/)
    await assert.rejects(store.getLesson('c', 'branches'), /Install/)
    await assert.rejects(store.install('../other'), /catalog/)

    await Promise.all([store.install('python'), store.install('python'), store.install('c')])
    const installed = await store.getLibrary()
    assert.deepEqual(installed.installed.map(({ id }) => id), ['python', 'c'])
    assert.equal(installed.selected, null)
    const selected = await store.select('c', false)
    assert.equal(selected.selected, 'c')
    assert.deepEqual(selected.catalog, [])
    const reopened = new LearningPackStore(profile, catalog)
    assert.equal(await reopened.isSelected('c'), true)
    assert.deepEqual(await reopened.getTopics('c'), [{ id: 'branches', title: 'Branches', section: 'Syntax' }])
    assert.deepEqual(await reopened.getLesson('c', 'branches'), pack('c', 'C').lessons[0])
    await assert.rejects(reopened.getLesson('c', 'missing'), /not in/)
    await assert.rejects(reopened.getTopics('../c'), /Install/)

    assert.equal((await reopened.remove('python')).selected, 'c')
    assert.equal((await reopened.remove('c')).selected, null)
    assert.equal(await reopened.isSelected('c'), false)
    await assert.rejects(reopened.getLesson('c', 'branches'), /Install/)
    await assert.rejects(lstat(join(profile, learningLibraryDirectory, 'c.json')), { code: 'ENOENT' })
    assert.deepEqual((await new LearningPackStore(profile, catalog).getLibrary()).installed, [])
  })
})

test('imports accept only bounded, validated plain-data packs from regular files', async () => {
  await withPacks(async (profile, catalog) => {
    const store = new LearningPackStore(profile, catalog)
    const path = join(profile, 'import.json')
    const valid = pack('lisp', 'Lisp')
    await writeFile(path, Buffer.alloc(maxLearningPackBytes + 1, 32))
    await assert.rejects(store.importFile(path), /exceeds 256 KiB/)
    await writeFile(path, Buffer.from([0xff, 0xfe]))
    await assert.rejects(store.importFile(path), /UTF-8 JSON/)
    for (const invalid of [
      { ...valid, id: '../outside' }, { ...valid, id: 'lisp\n' }, { ...valid, id: 'con' },
      { ...valid, hooks: ['run.js'] }, { ...valid, lessons: [...valid.lessons, ...valid.lessons] },
      { ...valid, lessons: [{ ...valid.lessons[0], api: [{ name: 'API', description: 42 }] }] },
      { ...valid, lessons: [{ ...valid.lessons[0], explanation: 'a'.repeat(6001) }] },
    ]) {
      await writeFile(path, JSON.stringify(invalid))
      await assert.rejects(store.importFile(path), /Invalid learning pack/)
    }
    await writeFile(path, JSON.stringify(pack('c', 'Custom C')))
    await assert.rejects(store.importFile(path), /reserved/)
    await writeFile(path, JSON.stringify(valid))
    if (process.platform !== 'win32') {
      const link = join(profile, 'link.json')
      await symlink(path, link)
      await assert.rejects(store.importFile(link), /regular file/)
    }
    assert.deepEqual((await store.getLibrary()).installed, [])
    const imported = await store.importFile(path)
    assert.equal(imported.selected, null)
    assert.deepEqual(imported.installed.map(({ id }) => id), ['lisp'])
    assert.equal((await store.select('lisp')).selected, 'lisp')
    assert.deepEqual(await store.getLesson('lisp', 'branches'), valid.lessons[0])
    await assert.rejects(store.importFile(path), /already installed/)
  })
})

test('legacy multibyte lessons keep their original size allowance through import and export', async () => {
  await withPacks(async (profile, catalog) => {
    const store = new LearningPackStore(profile, catalog)
    const original = pack('local-large-lesson', 'Local Study')
    const lesson = {
      ...original.lessons[0], explanation: '界'.repeat(6000), example: '界'.repeat(8000),
      api: Array.from({ length: 4 }, (_, index) => ({ name: 'API ' + index, description: '界'.repeat(600) })),
    }
    const legacy = { ...original, lessons: [lesson] }
    assert.ok(Buffer.byteLength(JSON.stringify(lesson)) > 48 * 1024)
    const source = join(profile, 'original.json')
    const output = join(profile, 'portable.json')
    await writeFile(source, JSON.stringify(legacy))
    const preview = await store.previewFile(source)
    await store.confirmImport(preview.token)
    assert.deepEqual(await store.getLesson(legacy.id, lesson.id), lesson)
    await store.exportFile(legacy.id, output)
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), legacy)
  })
})

test('a corrupted library is preserved and a missing selected C pack cannot enable diagnostics', async () => {
  await withPacks(async (profile, catalog) => {
    const store = new LearningPackStore(profile, catalog)
    const directory = join(profile, learningLibraryDirectory)
    await store.install('c')
    await store.select('c')
    const installed = parseInstalledLibrary(await readFile(join(directory, 'library.json'), 'utf8')).installed[0]
    await rm(join(directory, 'pack-' + installed.storage, 'manifest.json'))
    assert.equal(await store.isSelected('c'), false)
    const registry = join(directory, 'library.json')
    const corrupt = '{"schema":1,"selected":"c","installed":[]}'
    await writeFile(registry, corrupt)
    await assert.rejects(store.install('python'), /library could not be read/)
    assert.equal(await readFile(registry, 'utf8'), corrupt)
  })
})

test('every shipped pack matches its Marketplace listing and opens its topics', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'ion-shipped-pack-test-'))
  try {
    const catalogPath = join(profile, 'catalog')
    await compileLearningCatalog(resolve('src/main/learning/catalog'), catalogPath, '0.9.4')
    const store = new LearningPackStore(profile, catalogPath)
    const { catalog } = await store.getLibrary()
    assert.ok(catalog.length >= 6)
    assert.ok(catalog.some(({ id }) => id === 'c'))
    for (const listing of catalog) {
      await store.install(listing.id)
      const topics = await store.getTopics(listing.id)
      assert.deepEqual((await store.getDetails(listing.id)).topics, topics)
      assert.equal(topics.length, listing.topicCount, listing.id)
      for (const topic of topics) {
        assert.equal((await store.getLesson(listing.id, topic.id)).title, topic.title, listing.id)
      }
    }
    assert.equal((await store.getLibrary()).selected, null)
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('legacy installed packs stay readable and an explicit update keeps selection, recents and lesson IDs', async () => {
  await withPacks(async (profile, catalog) => {
    const previous = pack('python', 'Python')
    const { schema: _schema, lessons, ...summary } = previous
    const directory = join(profile, learningLibraryDirectory)
    await mkdir(directory)
    const legacyFile = join(directory, 'python.json')
    await writeFile(legacyFile, JSON.stringify(previous))
    await writeFile(join(directory, 'library.json'), JSON.stringify({ schema: 1, selected: 'python',
      installed: [{ ...summary, topicCount: lessons.length }] }))
    const store = new LearningPackStore(profile, catalog)
    assert.equal(await store.isSelected('python'), true)
    assert.deepEqual(await store.getLesson('python', 'branches'), lessons[0])
    const next = { ...previous, version: 2, lessons: [...lessons, { ...lessons[0], id: 'loops', title: 'Loops' }] }
    await writeFile(join(catalog, 'python.json'), JSON.stringify(next))
    const currentCatalog = (await store.getLibrary()).catalog.map((item) => item.id === 'python'
      ? { ...item, version: 2, topicCount: 2 } : item)
    await writeFile(join(catalog, 'index.json'), JSON.stringify(currentCatalog))
    await store.select('python')
    const updated = await store.install('python')
    assert.equal(updated.selected, 'python')
    assert.deepEqual(updated.recent, ['python'])
    assert.deepEqual(await store.getTopics('python'), [{ id: 'branches', title: 'Branches', section: 'Syntax' },
      { id: 'loops', title: 'Loops', section: 'Syntax' }])
    await assert.rejects(lstat(legacyFile), { code: 'ENOENT' })
  })
})

test('an import preview does not install, binds confirmation to the file, and exports a portable pack', async () => {
  await withPacks(async (profile, catalog) => {
    const store = new LearningPackStore(profile, catalog)
    const path = join(profile, 'source.json')
    const exported = join(profile, 'export.json')
    const definition = { ...pack('community', 'Community'), schema: 2, metadata: {
      kind: 'language', categories: ['automation'], languageVersion: '1.0', prerequisites: [],
      miniProject: 'Collect repeated commands in a script.', attribution: { author: 'Example', license: 'CC BY 4.0' },
      references: [{ title: 'Language guide', url: 'https://example.org/guide' }],
    } }
    await writeFile(path, JSON.stringify({ ...definition, metadata: { ...definition.metadata, minimumIonVersion: '9.0.0' } }))
    await assert.rejects(store.previewFile(path), /requires Ion 9\.0\.0/)
    await writeFile(path, JSON.stringify({ ...definition, metadata: { ...definition.metadata,
      references: [{ title: 'Local script', url: 'javascript:alert(1)' }] } }))
    await assert.rejects(store.previewFile(path), /Invalid learning pack/)
    await writeFile(path, JSON.stringify(definition))
    const preview = await store.previewFile(path)
    assert.equal(preview.details.pack.author, 'Example')
    assert.deepEqual((await store.getLibrary()).installed, [])
    await writeFile(path, JSON.stringify({ ...definition, name: 'Changed' }))
    await assert.rejects(store.confirmImport(preview.token), /changed after preview/)
    await writeFile(path, JSON.stringify(definition))
    const fresh = await store.previewFile(path)
    assert.deepEqual((await store.confirmImport(fresh.token)).installed.map(({ id }) => id), ['community'])
    await store.exportFile('community', exported)
    assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')), definition)
    const installed = parseInstalledLibrary(await readFile(join(profile, learningLibraryDirectory, 'library.json'), 'utf8')).installed[0]
    await writeFile(join(profile, learningLibraryDirectory, 'pack-' + installed.storage, 'lesson-branches.json'), 'unreadable')
    assert.equal((await store.getTopics('community')).length, 1)
    await assert.rejects(store.getLesson('community', 'branches'), /UTF-8 JSON/)
  })
})
