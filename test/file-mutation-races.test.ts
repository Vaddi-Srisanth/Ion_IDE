import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileMutations, type FileMutations } from '../src/main/file-mutations'
import { WorkspaceFiles } from '../src/main/files'

async function fixture(body: (scratch: string, root: string, native: FileMutations) => Promise<void>) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-file-race-')))
  const root = join(scratch, 'Source folder')
  try {
    await mkdir(root)
    await body(scratch, root, fileMutations())
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

test('native rename preserves a destination published after the workspace preflight', async () => {
  await fixture(async (_scratch, root, native) => {
    const source = join(root, 'existing.txt')
    const target = join(root, 'renamed.txt')
    const files = new WorkspaceFiles({ ...native, async rename(from, to, parent, caseOnly) {
      await writeFile(to, 'newer external destination', { flag: 'wx' })
      await native.rename(from, to, parent, caseOnly)
    } })
    await writeFile(source, 'Ion source')
    await files.grant(root, 'folder')
    await assert.rejects(files.rename(source, 'renamed.txt'), /already exists/)
    assert.equal(await readFile(target, 'utf8'), 'newer external destination')
    assert.equal(await readFile(source, 'utf8'), 'Ion source')
  })
})

test('native save retains a competing revision published just before replacement', async () => {
  await fixture(async (_scratch, root, native) => {
    const source = join(root, 'résultat.txt')
    const external = join(root, 'external-save.txt')
    const files = new WorkspaceFiles({ ...native, async replace(staged, to, parent, backup) {
      await writeFile(external, 'competing version')
      await rename(external, to)
      await native.replace(staged, to, parent, backup)
    } })
    await writeFile(source, 'previous version')
    await files.grant(root, 'folder')
    const opened = await files.read(source)
    await assert.rejects(files.save(source, 'Ion editor version', opened.revision, opened.contentHash), /FILE_CHANGED: .*preserved/)
    const names = await readdir(root)
    const recovery = names.find(name => /^Ion recovery-.*\.bak$/.test(name))
    assert.ok(recovery)
    assert.equal(await readFile(join(root, recovery), 'utf8'), 'competing version')
    assert.equal(await readFile(source, 'utf8'), 'Ion editor version')
    assert.equal(names.some(name => name.endsWith('.tmp')), false)
  })
})

test('native rename rejects a redirected parent at the operation boundary', async () => {
  await fixture(async (scratch, root, native) => {
    const inside = join(root, 'nested')
    const parked = join(root, 'retained')
    const outside = join(scratch, 'ungranted')
    const file = 'text.txt'
    await Promise.all([mkdir(inside), mkdir(outside)])
    await Promise.all([writeFile(join(inside, file), 'inside'), writeFile(join(outside, file), 'outside')])
    const files = new WorkspaceFiles({ ...native, async rename(from, to, parent, caseOnly) {
      await rename(dirname(from), parked)
      await symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir')
      await native.rename(from, to, parent, caseOnly)
    } })
    await files.grant(root, 'folder')
    await assert.rejects(files.rename(join(inside, file), 'moved.txt'), /folder changed/)
    assert.deepEqual(await readdir(outside), [file])
    assert.equal(await readFile(join(outside, file), 'utf8'), 'outside')
    assert.equal(await readFile(join(parked, file), 'utf8'), 'inside')
  })
})

test('native folder creation refuses a redirected grant', async () => {
  await fixture(async (scratch, root, native) => {
    const outside = join(scratch, 'ungranted')
    const original = join(scratch, 'parked')
    await mkdir(outside)
    const files = new WorkspaceFiles({ ...native, async prepare(path, parent, mode, kind, input) {
      await rename(root, original)
      await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
      await native.prepare(path, parent, mode, kind, input)
    } })
    await files.grant(root, 'folder')
    await assert.rejects(files.create(root, 'new directory', 'folder'), /folder changed/)
    assert.deepEqual(await readdir(outside), [])
    assert.deepEqual(await readdir(original), [])
  })
})

test('Trash stages the selected file through its granted parent before the shell receives a path', async () => {
  await fixture(async (scratch, root, native) => {
    const outside = join(scratch, 'ungranted')
    const original = join(scratch, 'parked')
    const filename = 'my assignment.c'
    const source = join(root, filename)
    await mkdir(outside)
    await writeFile(join(outside, filename), 'ungranted')
    await writeFile(source, 'authorized')
    const files = new WorkspaceFiles({ ...native, async move(from, to, first, second) {
      await rename(root, original)
      await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
      await native.move(from, to, first, second)
    } }, () => join(scratch, 'private trash staging'))
    await files.grant(root, 'folder')
    await assert.rejects(files.trash(source, async () => true, async () => assert.fail('The shell must not receive a redirected entry')), /folder changed/)
    assert.equal(await readFile(join(outside, filename), 'utf8'), 'ungranted')
    assert.equal(await readFile(join(original, filename), 'utf8'), 'authorized')
  })
})

test('failed Trash keeps the original item if another writer claims its old name', async () => {
  await fixture(async (scratch, root, native) => {
    const source = join(root, 'assignment.c')
    const files = new WorkspaceFiles(native, () => join(scratch, 'private trash staging'))
    await writeFile(source, 'authorized')
    await files.grant(root, 'folder')
    let retained: string | undefined
    await assert.rejects(files.trash(source, async () => true, async (staged) => {
      retained = staged
      assert.equal(await readFile(staged, 'utf8'), 'authorized')
      await writeFile(source, 'competing revision', { flag: 'wx' })
      throw new Error('Native Trash declined the operation')
    }), /retained item/)
    assert.equal(await readFile(source, 'utf8'), 'competing revision')
    assert.ok(retained)
    assert.equal(await readFile(retained, 'utf8'), 'authorized')
  })
})
