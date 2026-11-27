import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { LearningPackStore } from '../src/main/learning/catalog-store'
import { isLesson, manifestFor, parseManifest, parsePack } from '../src/main/learning/pack-format'

const legacyLesson = {
  id: 'flow', title: 'Control flow', section: 'Syntax',
  explanation: 'A loop repeats a block.', example: 'for (;;) {}',
  api: [], practice: 'Write a bounded loop.',
}
const teaching = {
  objective: 'Use a loop to inspect a sequence of integers.',
  starter: '// Write your loop here.\n',
  hints: ['Start with the first value.', 'Decide when to stop.', 'Advance after each iteration.'],
  followUp: 'Optional challenge, not checked by the original samples: count the inspected values.',
}
const metadata = {
  kind: 'language', categories: ['core'], languageVersion: '1.0', prerequisites: [],
  miniProject: 'Build a small counter.', references: [{ title: 'Reference', url: 'https://example.org/reference' }],
  attribution: { author: 'Ion test fixture', license: 'Project preview terms' },
}

function definition(schema: 1 | 2, lesson: unknown) {
  return { schema, id: 'teaching-fixture', name: 'Teaching fixture', summary: 'Learn loops.', version: 1,
    lessons: [lesson], ...(schema === 2 && { metadata }) }
}

test('the real pack parser preserves legacy schema 1/2 and optional teaching data without indexing code', () => {
  for (const schema of [1, 2] as const) {
    const legacy = definition(schema, legacyLesson)
    assert.deepEqual(parsePack(legacy), legacy)
    const lesson = { ...legacyLesson, ...teaching }
    const parsed = parsePack(definition(schema, lesson))
    assert.deepEqual(parsed.lessons[0], lesson)
    assert.deepEqual(parseManifest(manifestFor(parsed)).topics, [{ id: 'flow', title: 'Control flow', section: 'Syntax' }])
  }
  assert.equal(isLesson({ ...legacyLesson, starter: '' }), true, 'an explicitly blank editable starter is valid')
})

test('teaching fields are bounded plain data and reject unknown or executable-shaped fields', () => {
  for (const fields of [
    { objective: '' }, { objective: 'x'.repeat(601) }, { objective: 'a\0b' }, { objective: 42 },
    { starter: 'x'.repeat(8001) }, { starter: { command: 'run' } }, { starter: 'a\0b' },
    { hints: [] }, { hints: ['one', 'two', 'three', 'four'] }, { hints: [''] },
    { hints: ['x'.repeat(601)] }, { hints: ['a\0b'] }, { hints: 'a hint' },
    { followUp: '' }, { followUp: 'x'.repeat(1201) }, { followUp: 'a\0b' },
    { followUp: { run: 'command' } }, { onComplete: 'run.js' },
  ]) {
    const invalid = { ...legacyLesson, ...teaching, ...fields }
    assert.equal(isLesson(invalid), false, JSON.stringify(fields).slice(0, 90))
    assert.throws(() => parsePack(definition(2, invalid)), /Invalid learning pack/)
  }
  assert.equal(isLesson({ ...legacyLesson, objective: 'x'.repeat(600), starter: 'x'.repeat(8000),
    hints: ['x'.repeat(600)], followUp: 'x'.repeat(1200) }), true)
})

test('editable starters enforce the same 8000 UTF-8 byte boundary as execution', () => {
  for (const starter of ['é'.repeat(4000), '😀'.repeat(2000), '界'.repeat(2666) + 'ab']) {
    assert.equal(Buffer.byteLength(starter, 'utf8'), 8000)
    assert.equal(isLesson({ ...legacyLesson, starter }), true)
    assert.equal(parsePack(definition(2, { ...legacyLesson, starter })).lessons[0].starter, starter)
  }
  for (const starter of ['é'.repeat(4000) + 'a', '😀'.repeat(2000) + 'a', '界'.repeat(2667)]) {
    assert.ok(starter.length <= 8000, 'fits the character cap but exceeds the byte cap')
    assert.ok(Buffer.byteLength(starter, 'utf8') > 8000)
    assert.equal(isLesson({ ...legacyLesson, starter }), false)
    assert.throws(() => parsePack(definition(2, { ...legacyLesson, starter })), /Invalid learning pack/)
  }
})

test('import, lesson loading, reopening and export preserve optional teaching fields as data', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-teaching-test-'))
  try {
    const catalog = join(scratch, 'catalog'), profile = join(scratch, 'profile')
    await mkdir(catalog)
    await mkdir(profile)
    await writeFile(join(catalog, 'index.json'), '[]')
    const source = definition(2, { ...legacyLesson, ...teaching })
    const input = join(scratch, 'input.json'), output = join(scratch, 'output.json')
    await writeFile(input, JSON.stringify(source))
    const store = new LearningPackStore(profile, catalog)
    await store.importFile(input)
    assert.deepEqual(await store.getLesson(source.id, 'flow'), source.lessons[0])
    const reopened = new LearningPackStore(profile, catalog)
    assert.deepEqual(await reopened.getLesson(source.id, 'flow'), source.lessons[0])
    await reopened.exportFile(source.id, output)
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), source)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('three reviewed flow lessons retain their existing exercise identity and behavioral samples', async () => {
  const contracts = {
    c: { practice: 'Read one integer upper bound from stdin and sum the multiples of 3 from 1 through that bound.',
      samples: [{ input: '20\n', expectedOutput: '63\n' }, { input: '5\n', expectedOutput: '3\n' },
        { input: '1\n', expectedOutput: '0\n' }], version: 4, file: 'lesson.c' },
    java: { practice: 'Read a positive integer N and then N integers from stdin. Whitespace separates the values.',
      samples: [{ input: '3\n-7 -2 -9\n', expectedOutput: '-2\n' }, { input: '1\n0\n', expectedOutput: '0\n' },
        { input: '5\n2 7 4 7 3\n', expectedOutput: '7\n' }], version: 3, file: 'Main.java' },
    python: { practice: 'Read a nonnegative upper bound from stdin. Print multiples of 3 down to 1 in descending order.',
      samples: [{ input: '10\n', expectedOutput: '9\n6\n3\n' }, { input: '2\n', expectedOutput: '' },
        { input: '6\n', expectedOutput: '6\n3\n' }], version: 4, file: 'lesson.py' },
  }
  for (const [id, contract] of Object.entries(contracts)) {
    const pack = parsePack(JSON.parse(await readFile(resolve('src/main/learning/catalog', id + '.json'), 'utf8')))
    const lesson = pack.lessons.find(item => item.id === 'flow')!
    assert.equal(pack.version, contract.version)
    assert.equal(lesson.exampleFile, contract.file)
    assert.equal(lesson.practice, contract.practice)
    assert.deepEqual(lesson.exercise?.samples, contract.samples)
    assert.ok(lesson.objective && lesson.starter && lesson.followUp)
    assert.equal(lesson.hints?.length, 3)
    assert.notEqual(lesson.starter, lesson.example, 'practice starter is distinct from the solved teaching example')
    assert.match(lesson.starter, /TODO/)
    assert.match(lesson.followUp, /not checked/)
    assert.equal(pack.lessons.filter(item => item.objective !== undefined).length, 1, 'one carefully reviewed path per pack')
  }
})
