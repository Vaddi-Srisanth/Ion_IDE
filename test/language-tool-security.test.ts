import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { commandPaths, executable, onPath } from '../src/main/run-console/plans'

test('language discovery ignores repository-controlled PATH executables and linked directories', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-language-discovery-'))
  const root = join(scratch, 'workspace')
  const repositoryBin = join(root, 'bin')
  const outside = join(scratch, 'outside')
  const name = process.platform === 'win32' ? 'pyright-langserver.exe' : 'pyright-langserver'
  const previous = process.env.PATH
  try {
    await mkdir(repositoryBin, { recursive: true })
    await mkdir(outside)
    await writeFile(join(repositoryBin, name), 'not executable by Ion')
    await chmod(join(repositoryBin, name), 0o755).catch(() => {})
    await writeFile(join(outside, name), 'outside fixture')
    await chmod(join(outside, name), 0o755).catch(() => {})
    const alias = join(root, 'linked-tools')
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
    process.env.PATH = [repositoryBin, alias, outside, previous ?? ''].join(delimiter)
    const paths = await commandPaths(root)
    assert.equal(paths.includes(repositoryBin), false)
    assert.equal(paths.includes(alias), false)
    assert.equal(await executable(join(repositoryBin, name), root), false)
    assert.equal(await executable(join(alias, name), root), false)
    assert.equal(await onPath('pyright-langserver', root, [repositoryBin, alias]), null)
  } finally {
    process.env.PATH = previous
    await rm(scratch, { recursive: true, force: true })
  }
})
