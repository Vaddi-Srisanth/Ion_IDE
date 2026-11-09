import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { createInterface } from 'node:readline'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { isWithin, WorkspaceFiles } from '../src/main/files'

const windowsOnly = { skip: process.platform !== 'win32', timeout: 20_000 }

async function workspace(t: TestContext) {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-windows-files-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const path = join(scratch, 'Learning Files')
  await mkdir(path)
  const files = new WorkspaceFiles()
  const root = await files.grant(path, 'folder')
  return { scratch, root, files }
}

async function lockAgainstReplacement(path: string): Promise<() => Promise<void>> {
  // A normal Node handle permits deletion. Create a real Windows handle that denies it.
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    "$ErrorActionPreference='Stop'",
    "$handle=[IO.File]::Open($env:ION_LOCK_PATH, 'Open', 'Read', 'ReadWrite')",
    "try { [Console]::WriteLine('locked'); $null=[Console]::ReadLine() } finally { $handle.Dispose() }",
  ].join('; ')], { env: { ...process.env, ION_LOCK_PATH: path }, windowsHide: true })
  const closed = once(child, 'close')
  void closed.catch(() => undefined)
  const lines = createInterface({ input: child.stdout })
  try {
    const [line] = await Promise.race([
      once(lines, 'line'),
      closed.then(([code]) => { throw new Error('Windows file lock helper exited with code ' + code) }),
    ])
    assert.equal(line, 'locked')
  } catch (error) {
    child.kill()
    await closed.catch(() => undefined)
    throw error
  } finally {
    lines.close()
  }
  return async () => {
    child.stdin.end('\n')
    assert.equal((await closed)[0], 0)
  }
}

test('Windows workspace keeps canonical Unicode paths and confirms a case-alias Save As', windowsOnly, async (t) => {
  const { root, files } = await workspace(t)
  const folder = await files.create(root.path, 'Study Résumé', 'folder')
  const first = await files.create(folder.path, '例 Code.txt', 'file', 'original')
  const opened = await files.read(first.path)
  assert.equal(opened.text, 'original')
  await files.save(first.path, 'edited', opened.revision, opened.contentHash)
  const alias = join(folder.path, '例 code.TXT')
  assert.equal((await files.grant(alias, 'file')).path, first.path)
  await assert.rejects(files.read(alias), /Symbolic links/)
  assert.equal(await files.saveAs(alias, 'cancelled'), null)
  assert.equal(await readFile(first.path, 'utf8'), 'edited')

  const replaced = await files.saveAs(alias, 'replaced', async (target) => {
    assert.equal(target, first.path)
    return true
  })
  assert.equal(replaced?.path, first.path)
  const renamed = await files.rename(first.path, '例 CODE.txt')
  assert.equal(await realpath(renamed.path), renamed.path)
  assert.deepEqual(await files.list(folder.path), [renamed])
  assert.equal((await files.read(renamed.path)).text, 'replaced')
  assert.equal(await files.trash(renamed.path, async () => true, (path) => rename(path, join(root.path, 'recycled.txt'))), true)
  assert.deepEqual(await files.list(folder.path), [])
  assert.equal(await readFile(join(root.path, 'recycled.txt'), 'utf8'), 'replaced')
})

test('Windows workspace denies junction escapes, case-variant roots, devices, and data streams', windowsOnly, async (t) => {
  const { scratch, root, files } = await workspace(t)
  const outside = join(scratch, 'private.txt')
  await writeFile(outside, 'private')
  await symlink(scratch, join(root.path, 'escape'), 'junction')
  assert.deepEqual(await files.list(root.path), [])
  await assert.rejects(files.read(join(root.path, 'escape', 'private.txt')), /Symbolic links/)
  assert.equal(isWithin(root.path, join(root.path, 'file.txt')), true)
  assert.equal(isWithin(root.path, join(scratch, 'learning files', 'file.txt')), false)
  const entry = await files.create(root.path, 'regular.txt', 'file')
  for (const path of [entry.path + ':hidden', toNamespacedPath(entry.path), join(root.path, 'NUL.txt'), join(root.path, 'folder.', 'file.txt')]) {
    await assert.rejects(files.read(path), /regular Windows file or folder/)
  }
  for (const name of ['CONIN$', 'COM¹.txt', 'LPT9 .txt', 'trailing.']) {
    assert.throws(() => files.create(root.path, name, 'file'), /valid Windows/)
  }
  assert.equal(await readFile(outside, 'utf8'), 'private')
})

test('Windows workspace reads and saves long paths with Unicode names', windowsOnly, async (t) => {
  const { root, files } = await workspace(t)
  const nested = await files.create(root.path, '学'.repeat(180), 'folder')
  const entry = await files.create(nested.path, '文'.repeat(120) + '.txt', 'file', 'long path')
  assert.ok(entry.path.length > 260)
  const opened = await files.read(entry.path)
  assert.equal(opened.text, 'long path')
  await files.save(entry.path, 'edited', opened.revision, opened.contentHash)
  assert.equal((await files.read(entry.path)).text, 'edited')
})

test('Windows atomic saves recover from transient sharing locks and preserve external edits', windowsOnly, async (t) => {
  const { root, files } = await workspace(t)
  const entry = await files.create(root.path, 'locked.txt', 'file', 'original')
  const opened = await files.read(entry.path)
  const release = await lockAgainstReplacement(entry.path)
  const pending = files.save(entry.path, 'first save', opened.revision, opened.contentHash)
  const outcome = pending.then(() => null, (error: unknown) => error)
  try {
    await delay(160)
    assert.equal(await readFile(entry.path, 'utf8'), 'original')
    assert.equal((await readdir(root.path)).some((name) => name.endsWith('.tmp')), true)
  } finally {
    await release()
  }
  assert.equal(await outcome, null)
  assert.equal(await readFile(entry.path, 'utf8'), 'first save')

  const saved = await files.read(entry.path)
  const releaseConflict = await lockAgainstReplacement(entry.path)
  try {
    const rejected = assert.rejects(files.save(entry.path, 'second save', saved.revision, saved.contentHash), /FILE_CHANGED/)
    await delay(100)
    await writeFile(entry.path, 'changed by another program')
    await rejected
    assert.equal(await readFile(entry.path, 'utf8'), 'changed by another program')
  } finally {
    await releaseConflict()
  }

  const external = await files.read(entry.path)
  const releasePersistent = await lockAgainstReplacement(entry.path)
  try {
    await assert.rejects(files.save(entry.path, 'third save', external.revision, external.contentHash), /Windows could not replace.*Save As/)
    assert.equal(await readFile(entry.path, 'utf8'), 'changed by another program')
    assert.deepEqual(await readdir(root.path), ['locked.txt'])
  } finally {
    await releasePersistent()
  }
})
