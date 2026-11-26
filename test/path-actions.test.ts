import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceFiles } from '../src/main/files'
import { copyAuthorizedPath, revealAuthorizedPath } from '../src/main/path-actions'

test('path context actions accept only already-authorized regular entries', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-path-actions-'))
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(scratch, { recursive: true, force: true })))
  const workspace = join(scratch, 'workspace')
  const outside = join(scratch, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  const source = join(workspace, 'main.c')
  const privateFile = join(outside, 'private.txt')
  await writeFile(source, 'int main(void) { return 0; }')
  await writeFile(privateFile, 'private')
  const scope = new WorkspaceFiles()
  const granted = await scope.grant(workspace, 'folder')
  const grantedSource = join(granted.path, 'main.c')

  const copied: string[] = []
  assert.equal(await copyAuthorizedPath(scope, grantedSource, value => copied.push(value)), grantedSource)
  assert.deepEqual(copied, [grantedSource])

  const revealed: string[] = []
  assert.equal(await revealAuthorizedPath(scope, granted.path, value => revealed.push(value)), granted.path)
  assert.deepEqual(revealed, [granted.path])

  await assert.rejects(copyAuthorizedPath(scope, privateFile, value => copied.push(value)), /Open the file or its folder/)
  assert.deepEqual(copied, [grantedSource], 'rejected paths never reach the clipboard adapter')
})

test('path context actions reject symlink escapes before invoking the OS adapter', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-path-links-'))
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(scratch, { recursive: true, force: true })))
  const workspace = join(scratch, 'workspace')
  const outside = join(scratch, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  const privateFile = join(outside, 'private.txt')
  const alias = join(workspace, 'alias.txt')
  await writeFile(privateFile, 'private')
  await symlink(privateFile, alias)
  const scope = new WorkspaceFiles()
  const granted = await scope.grant(workspace, 'folder')
  const grantedAlias = join(granted.path, 'alias.txt')

  let invoked = false
  await assert.rejects(revealAuthorizedPath(scope, grantedAlias, () => { invoked = true }), /regular file or folder|Symbolic links/)
  assert.equal(invoked, false)
})
