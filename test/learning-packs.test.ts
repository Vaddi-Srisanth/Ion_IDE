import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { LearningPackStore, learningLibraryDirectory, maxLearningPackBytes } from '../src/main/learning/catalog-store'

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
    assert.equal((await store.select('c')).selected, 'c')
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

test('a corrupted library is preserved and a missing selected C pack cannot enable diagnostics', async () => {
  await withPacks(async (profile, catalog) => {
    const store = new LearningPackStore(profile, catalog)
    const directory = join(profile, learningLibraryDirectory)
    await store.install('c')
    await store.select('c')
    await rm(join(directory, 'c.json'))
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
    const store = new LearningPackStore(profile, resolve('src/main/learning/catalog'))
    const { catalog } = await store.getLibrary()
    assert.ok(catalog.length >= 6)
    assert.ok(catalog.some(({ id }) => id === 'c'))
    for (const listing of catalog) {
      await store.install(listing.id)
      const topics = await store.getTopics(listing.id)
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
