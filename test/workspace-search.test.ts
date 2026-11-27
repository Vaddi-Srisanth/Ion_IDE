import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WorkspaceFiles } from '../src/main/files'
import { searchWorkspaceText, workspaceReplacement, workspaceSearchQuery, WorkspaceReplaceReview } from '../src/main/workspace-search'

const rg = resolve('node_modules', '@vscode', `ripgrep-${process.platform}-${process.arch}`, 'bin',
  process.platform === 'win32' ? 'rg.exe' : 'rg')

async function workspace(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'ion-workspace-search-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const directory = join(temporary, 'Workspace with spaces')
  await mkdir(directory)
  const scope = new WorkspaceFiles()
  const { path: root } = await scope.grant(directory, 'folder')
  return { root, scope, temporary }
}

test('workspace search groups literal matches and respects workspace ignore rules and scope', async (t) => {
  const { root, scope, temporary } = await workspace(t)
  const nested = join(root, 'src')
  const generated = join(nested, 'node_modules')
  const outside = join(temporary, 'private.txt')
  await mkdir(generated, { recursive: true })
  await Promise.all([
    writeFile(join(root, '.gitignore'), 'ignored.txt\n'),
    writeFile(join(root, 'ignored.txt'), '.needle*'),
    writeFile(join(temporary, '.gitignore'), 'Notes.txt\n'),
    writeFile(join(root, 'Notes.txt'), '\uFEFF.NEEDLE*\r\n'),
    writeFile(join(root, 'notes.csv'), '.needle*'),
    writeFile(join(root, 'binary'), Buffer.from('binary\0.needle*')),
    writeFile(join(root, 'huge.txt'), Buffer.concat([Buffer.from('.needle*\n'), Buffer.alloc(2_097_152, 'x')])),
    writeFile(join(nested, '.gitignore'), '*.generated\n!keep.generated\n'),
    writeFile(join(nested, 'omit.generated'), '.needle*'),
    writeFile(join(nested, 'keep.generated'), 'prefix\né😀 .needle*\n.needle* twice .needle*\n'),
    writeFile(join(nested, 'not-literal.txt'), 'needle x'),
    writeFile(join(generated, 'module.txt'), '.needle*'),
    writeFile(outside, '.needle*'),
  ])
  if (process.platform !== 'win32') await symlink(outside, join(root, 'outside alias.txt'))
  const result = await searchWorkspaceText(rg, scope, root, workspaceSearchQuery('.needle*'), new AbortController().signal)
  assert.deepEqual(result.files.map(({ relativePath, matches }) => ({ relativePath, matches })), [
    { relativePath: 'Notes.txt', matches: [{ line: 1, column: 1, preview: '.NEEDLE*' }] },
    { relativePath: join('src', 'keep.generated'), matches: [
      { line: 2, column: 5, preview: 'é😀 .needle*' },
      { line: 3, column: 1, preview: '.needle* twice .needle*' },
    ] },
  ])
  assert.equal(result.limit, undefined)
  assert.equal(result.skipped, false)
})

test('workspace search caps matching lines and previews', async (t) => {
  const { root, scope } = await workspace(t)
  await writeFile(join(root, 'many.txt'), (`${'a'.repeat(2000)} find-me ${'a'.repeat(2000)}\n`).repeat(201))
  const result = await searchWorkspaceText(rg, scope, root, 'find-me', new AbortController().signal)
  assert.equal(result.limit, 'matches')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].matches.length, 200)
  assert.equal(result.files[0].matches[0].column, 2002)
  for (const { preview } of result.files[0].matches) {
    assert.ok(preview.startsWith('…') && preview.endsWith('…') && preview.includes('find-me') && preview.length <= 222)
  }
  for (const query of [undefined, 'x'.repeat(201), 'a\nb', 'a\0b', '\ud800']) {
    assert.throws(() => workspaceSearchQuery(query), /single line/)
  }
})

test('cancelling an active workspace search reaps its process', { skip: process.platform === 'win32' }, async (t) => {
  const { root, scope, temporary } = await workspace(t)
  const executable = join(temporary, 'slow-rg')
  await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$$" > child.pid\nexec /bin/sleep 60\n', { mode: 0o700 })
  const controller = new AbortController()
  const result = searchWorkspaceText(executable, scope, root, 'find-me', controller.signal)
  void result.catch(() => undefined)
  try {
    let pid = 0
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      pid = Number(await readFile(join(root, 'child.pid'), 'utf8').catch(() => ''))
      if (!pid) await delay(10)
    }
    assert.ok(pid > 0, 'Search process started')
    controller.abort()
    await assert.rejects(result, { name: 'AbortError' })
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    controller.abort()
    await result.catch(() => undefined)
  }
})

test('reviewed workspace replacement applies only selected stable files through safe saves', async (t) => {
  const { root, scope } = await workspace(t)
  const first = join(root, 'first.txt'), second = join(root, 'second.txt')
  await writeFile(first, 'Needle one\nneedle two\n')
  await writeFile(second, 'leave Needle alone\n')
  const service = new WorkspaceReplaceReview(rg, scope)
  const review = await service.review('needle', 'pin')
  assert.equal(review.replacements, 3)
  assert.deepEqual(review.files.map(file => [file.relativePath, file.replacements]), [['first.txt', 2], ['second.txt', 1]])
  const result = await service.apply(review.token, [first])
  assert.deepEqual(result, { applied: [first], failed: [] })
  assert.equal(await readFile(first, 'utf8'), 'pin one\npin two\n')
  assert.equal(await readFile(second, 'utf8'), 'leave Needle alone\n')
  await assert.rejects(service.apply(review.token, [second]), /expired/)
})

test('workspace replacement reviews and safely applies files across explicit roots', async (t) => {
  const { root, scope, temporary } = await workspace(t)
  const second = join(temporary, 'Second workspace')
  await mkdir(second)
  const secondRoot = (await scope.addRoot(second)).path
  const firstFile = join(root, 'first.txt'), secondFile = join(secondRoot, 'second.txt')
  await Promise.all([writeFile(firstFile, 'shared marker\n'), writeFile(secondFile, 'shared marker\n')])
  const service = new WorkspaceReplaceReview(rg, scope)
  const review = await service.review('marker', 'updated')
  assert.equal(review.replacements, 2)
  assert.deepEqual(review.files.map(({ relativePath }) => relativePath), [
    `${root.split(/[/\\]/).at(-1)}/first.txt`, 'Second workspace/second.txt',
  ])
  assert.deepEqual(await service.apply(review.token, [firstFile, secondFile]), {
    applied: [firstFile, secondFile], failed: [],
  })
  assert.equal(await readFile(firstFile, 'utf8'), 'shared updated\n')
  assert.equal(await readFile(secondFile, 'utf8'), 'shared updated\n')
})

test('reviewed replacement preserves external edits and reports partial failures', async (t) => {
  const { root, scope } = await workspace(t)
  const changed = join(root, 'a-changed.txt'), stable = join(root, 'b-stable.txt')
  await writeFile(changed, 'find me\n')
  await writeFile(stable, 'find me too\n')
  const service = new WorkspaceReplaceReview(rg, scope)
  const review = await service.review('find', 'keep')
  await writeFile(changed, 'external edit\n')
  const result = await service.apply(review.token, [changed, stable])
  assert.equal(result.applied.length, 1)
  assert.equal(result.applied[0], stable)
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].path, changed)
  assert.match(result.failed[0].message, /changed/i)
  assert.equal(await readFile(changed, 'utf8'), 'external edit\n')
  assert.equal(await readFile(stable, 'utf8'), 'keep me too\n')
})

test('workspace replacement validates bounded text and reviewed selections', async (t) => {
  const { root, scope } = await workspace(t)
  const file = join(root, 'only.txt')
  await writeFile(file, 'safe token\n')
  assert.throws(() => workspaceReplacement('x'.repeat(10_001)), /10,000/)
  assert.throws(() => workspaceReplacement('\0'), /10,000/)
  const service = new WorkspaceReplaceReview(rg, scope)
  const review = await service.review('token', 'value')
  await assert.rejects(service.apply(review.token, [join(root, 'unreviewed.txt')]), /invalid/)
  assert.equal(await readFile(file, 'utf8'), 'safe token\n')
})

test('reviewed replacement handles long Unicode paths and case-insensitive text without broadening scope', async (t) => {
  const { root, scope } = await workspace(t)
  const nested = join(root, 'Unicode Ω ' + 'a'.repeat(90), 'deeper ' + 'b'.repeat(90))
  await mkdir(nested, { recursive: true })
  const file = join(nested, 'Résumé 日本語.txt')
  await writeFile(file, 'mixed CaseToken value\n')
  const service = new WorkspaceReplaceReview(rg, scope)
  const review = await service.review('casetoken', 'updated')
  assert.equal(review.files.length, 1)
  assert.equal(review.files[0].path, file)
  assert.equal(review.files[0].relativePath, relative(root, file))
  assert.deepEqual(await service.apply(review.token, [file]), { applied: [file], failed: [] })
  assert.equal(await readFile(file, 'utf8'), 'mixed updated value\n')
})
