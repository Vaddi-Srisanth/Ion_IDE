import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileLanguage, formatterFamily, languageCapabilities, runnableLanguage } from '../src/shared/languages'
import { diagnosticPackIds } from '../src/shared/learning-packs'
import { practiceLanguages } from '../src/shared/practice'
import { parsePack } from '../src/main/learning/pack-format'
import { sourceDriveSpelling, sourcePathFromUri } from '../src/shared/source-path'

test('source navigation keeps native drive casing and decoded Unicode paths without broadening workspace grants', () => {
  const file = (path: string, authority = '') => ({ scheme: 'file', path, authority })
  assert.equal(sourcePathFromUri(file('/C:/Study café/資料%20#1.java'), 'win32'), 'C:\\Study café\\資料%20#1.java')
  assert.equal(sourcePathFromUri(file('/d:/code/main.c'), 'win32'), 'd:\\code\\main.c')
  assert.equal(sourcePathFromUri(file('/Share/Study/main.c', 'Server'), 'win32'), '\\\\Server\\Share\\Study\\main.c')
  assert.equal(sourcePathFromUri(file('/work/café/main.c'), 'darwin'), '/work/café/main.c')
  assert.equal(sourcePathFromUri(file('/work/back\\slash.c'), 'linux'), '/work/back\\slash.c')
  assert.equal(sourcePathFromUri(file('/outside.c'), 'win32'), undefined)
  assert.equal(sourcePathFromUri({ scheme: 'https', authority: 'example.invalid', path: '/main.c' }, 'win32'), undefined)
  assert.equal(sourcePathFromUri(file('/C:/bad\0name.c'), 'win32'), undefined)
  assert.equal(sourceDriveSpelling('c:\\Study\\include\\main.h', 'C:\\Study\\main.c', 'win32'), 'C:\\Study\\include\\main.h')
  assert.equal(sourceDriveSpelling('c:\\study\\main.h', 'C:\\Study\\main.c', 'win32'), 'C:\\study\\main.h',
    'A differently cased directory must remain different for the workspace boundary.')
  assert.equal(sourceDriveSpelling('d:\\Study\\main.h', 'C:\\Study\\main.c', 'win32'), 'd:\\Study\\main.h')
  assert.equal(sourceDriveSpelling('/c:/Study/main.h', '/C:/Study/main.c', 'darwin'), '/c:/Study/main.h')
})

test('file detection preserves runner distinctions and formatter exclusions', () => {
  assert.equal(fileLanguage('C:\\sample\\module.C').id, 'cpp')
  assert.equal(runnableLanguage('/sample/module.C'), 'cpp')
  assert.equal(runnableLanguage('main.c'), 'c')
  assert.equal(runnableLanguage('main.CPP'), 'cpp')
  assert.equal(fileLanguage('math.h').id, 'c')
  assert.equal(runnableLanguage('math.h'), undefined)
  assert.equal(runnableLanguage('component.jsx'), undefined)
  assert.equal(fileLanguage('utility.mts').syntax, 'typescript')
  assert.equal(formatterFamily('utility.mts'), 'prettier')
  assert.equal(formatterFamily('cells.ipynb'), undefined)
  assert.equal(fileLanguage('c').id, 'plaintext')
  assert.equal(runnableLanguage('/work.with.dots/c'), undefined)
})

test('every advertised language extension selects its language and the named run adapter', () => {
  const extensions = new Set()
  for (const language of languageCapabilities) {
    for (const extension of language.extensions) {
      assert.ok(!extensions.has(extension), 'duplicate extension ' + extension)
      extensions.add(extension)
      const name = 'sample.' + extension
      assert.equal(fileLanguage(name).id, language.id, name)
      assert.equal(runnableLanguage(name), language.runner?.extensions.includes(extension) ? language.runner.id : undefined, name)
    }
  }
})

test('all bundled learning, diagnostic, practice, and semantic claims match their implementations', async () => {
  const catalog = 'src/main/learning/catalog'
  const expectedPacks = (await readdir(catalog)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort()
  const packs = languageCapabilities.flatMap(({ pack }) => pack ? [pack] : [])
  assert.deepEqual(packs.sort(), expectedPacks)
  for (const pack of packs) {
    const content = parsePack(JSON.parse(await readFile(join(catalog, pack + '.json'), 'utf8')))
    assert.equal(content.id, pack)
    assert.ok(content.lessons.length, pack)
  }
  assert.deepEqual(languageCapabilities.filter(({ diagnosticLessons }) => diagnosticLessons).map(({ id }) => id).sort(), [...diagnosticPackIds].sort())
  assert.deepEqual(languageCapabilities.filter(({ practice }) => practice).map(({ id }) => id).sort(), Object.keys(practiceLanguages).sort())
  assert.deepEqual(languageCapabilities.filter(({ basicSuggestions }) => basicSuggestions).map(({ id }) => id), ['java'])
  assert.deepEqual(languageCapabilities.flatMap(({ id, semantic }) => semantic ? [[id, semantic.adapter, ...semantic.operations]] : []), [
    ['c', 'clangd', 'definition', 'references'], ['cpp', 'clangd', 'definition', 'references'],
    ['java', 'java', 'diagnostics', 'complete', 'signature', 'definition', 'references'],
  ])
  assert.ok(languageCapabilities.every(({ debugAdapter, quizzes }) => !debugAdapter && !quizzes))
})
