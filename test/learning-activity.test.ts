import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LearningService } from '../src/main/learning'

const oldHistory = () => ({
  version: 1,
  files: { ['a'.repeat(32)]: { episodes: {
    ['missing-semicolon:' + 'b'.repeat(32)]: { category: 'missing-semicolon', hashes: ['c'.repeat(32)] },
  } } },
  categories: { 'missing-semicolon': { encountered: 2, repeated: 1, resolved: 0 } },
  topics: { arrays: { viewed: 3, selected: 1 } },
})

async function fixture(run: (path: string, service: LearningService) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-activity-'))
  const path = join(directory, 'learning.json')
  try { await run(path, new LearningService(path)) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('reading lesson activity creates no file and preserves the existing public history shape', async () => {
  await fixture(async (path, service) => {
    assert.deepEqual(await service.getLearningActivity('python', 'flow'), {
      packId: 'python', lessonId: 'flow', opened: 0, hintsRevealed: 0, lastAt: null,
    })
    assert.deepEqual(await service.getHistory(), { categories: [], topics: [] })
    await assert.rejects(stat(path), { code: 'ENOENT' })
  })
})

test('version-one diagnostic history survives lesson/hint events, normal topic writes and reopening', async () => {
  await fixture(async (path, service) => {
    const original = oldHistory()
    const originalText = JSON.stringify(original)
    await writeFile(path, originalText)
    const prior = await service.getHistory()
    await service.getLearningActivity('java', 'types')
    assert.equal(await readFile(path, 'utf8'), originalText)
    await service.recordLearningActivity('java', 'types', 'lesson-opened')
    const event = await service.recordLearningActivity('java', 'types', 'hint-revealed')
    assert.equal(event.opened, 1)
    assert.equal(event.hintsRevealed, 1)
    assert.ok(event.lastAt && event.lastAt <= Date.now())
    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(saved.version, 1)
    for (const key of ['files', 'categories', 'topics'] as const) assert.deepEqual(saved[key], original[key])
    assert.deepEqual(await service.getHistory(), prior)
    assert.deepEqual(await new LearningService(path).getLearningActivity('java', 'types'), event)
    await service.recordTopic('arrays', 'selected')
    assert.deepEqual(await new LearningService(path).getLearningActivity('java', 'types'), event)
    assert.deepEqual(Object.keys(await service.getHistory()).sort(), ['categories', 'topics'])
    assert.equal('mastered' in event, false)
    await service.clearHistory()
    assert.equal((await service.getLearningActivity('java', 'types')).lastAt, null)
  })
})

test('activity validates identities/actions before writing and preserves corrupted records', async () => {
  await fixture(async (path, service) => {
    await writeFile(path, JSON.stringify(oldHistory()))
    const original = await readFile(path, 'utf8')
    for (const [pack, lesson] of [['../python', 'flow'], ['python', '../flow'], ['python', 'x'.repeat(41)], ['library', 'flow'], ['python', 'flow:extra']]) {
      await assert.rejects(service.recordLearningActivity(pack, lesson, 'lesson-opened'), /identity/)
      await assert.rejects(service.getLearningActivity(pack, lesson), /identity/)
    }
    for (const action of ['passed', 'mastered', 'hint', '', null, { opened: 999 }]) {
      await assert.rejects(service.recordLearningActivity('python', 'flow', action), /activity action/)
    }
    assert.equal(await readFile(path, 'utf8'), original)
    const invalid = [null, [], { 'python:flow:extra': { opened: 0, hintsRevealed: 0, lastAt: 1 } },
      { 'python:flow': { opened: -1, hintsRevealed: 0, lastAt: 1 } },
      { 'python:flow': { opened: 0, hintsRevealed: 65536, lastAt: 1 } },
      { 'python:flow': { opened: 0, hintsRevealed: 0, lastAt: 0 } },
      { 'python:flow': { opened: 0, hintsRevealed: 0, lastAt: 1, mastered: true } }]
    for (const activity of invalid) {
      const text = JSON.stringify({ ...oldHistory(), activity })
      await writeFile(path, text)
      await assert.rejects(new LearningService(path).recordLearningActivity('python', 'flow', 'lesson-opened'), /could not be read/)
      assert.equal(await readFile(path, 'utf8'), text)
    }
  })
})

test('lesson activity saturates counters and retains only 256 most recently recorded lessons', async () => {
  await fixture(async (path, service) => {
    const activity = Object.fromEntries(Array.from({ length: 256 }, (_, i) =>
      ['python:lesson-' + i, { opened: 65535, hintsRevealed: 65535, lastAt: i + 1 }]))
    await writeFile(path, JSON.stringify({ ...oldHistory(), activity }))
    await service.recordLearningActivity('python', 'lesson-0', 'lesson-opened')
    await service.recordLearningActivity('python', 'lesson-0', 'hint-revealed')
    const saturated = await service.getLearningActivity('python', 'lesson-0')
    assert.equal(saturated.opened, 65535)
    assert.equal(saturated.hintsRevealed, 65535)
    await service.recordLearningActivity('java', 'new-lesson', 'lesson-opened')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(Object.keys(saved.activity).length, 256)
    assert.ok(saved.activity['python:lesson-0'])
    assert.equal(saved.activity['python:lesson-1'], undefined)
    assert.deepEqual(saved.files, oldHistory().files)
    assert.deepEqual(saved.categories, oldHistory().categories)
    const oversized = { ...oldHistory(), activity: { ...activity, 'java:extra': { opened: 1, hintsRevealed: 0, lastAt: 1 } } }
    const text = JSON.stringify(oversized)
    await writeFile(path, text)
    await assert.rejects(new LearningService(path).getLearningActivity('java', 'extra'), /could not be read/)
    assert.equal(await readFile(path, 'utf8'), text)
  })
})

test('an activity event cannot publish a history file exceeding the existing 512 KiB limit', async () => {
  await fixture(async (path, service) => {
    const original = oldHistory()
    const overhead = JSON.stringify({ ...original, legacyPadding: '' }).length
    const text = JSON.stringify({ ...original, legacyPadding: 'x'.repeat(512 * 1024 - overhead - 8) })
    await writeFile(path, text)
    await assert.rejects(service.recordLearningActivity('java', 'types', 'lesson-opened'), /storage limit/)
    assert.equal(await readFile(path, 'utf8'), text)
    assert.equal((await service.getLearningActivity('java', 'types')).opened, 0)
  })
})
