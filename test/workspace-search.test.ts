import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WorkspaceFiles } from '../src/main/files'
import { searchWorkspaceText, workspaceSearchQuery } from '../src/main/workspace-search'

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
