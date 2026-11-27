import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { SourceControlService } from '../src/main/source-control'
import { git, resolveGit } from '../src/main/source-control/repository'
import { sameWorktreePath } from '../src/main/source-control/worktree-branches'

test('Windows Git worktree locations compare across slash and case spelling', () => {
  assert.equal(sameWorktreePath('D:\\a\\Ion_IDE\\repo', 'd:/a/ion_ide/repo', 'win32'), true)
  assert.equal(sameWorktreePath('D:\\a\\Ion_IDE\\repo', 'D:/a/other', 'win32'), false)
})

async function fixture(t: TestContext, service = new SourceControlService()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-switch-git-')))
  t.after(async () => { service.close(); await service.drain(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const tool = await resolveGit(root, new AbortController().signal)
  assert.ok(tool)
  const run = (...args: string[]) => execFileSync(tool.executable, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 8000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  }).trim()
  run('init', '-q', '-b', 'main'); run('config', 'user.name', 'Ion fixture'); run('config', 'user.email', 'fixture@ion.invalid')
  await writeFile(join(root, 'source.txt'), 'base\n')
  run('add', '--', 'source.txt'); run('commit', '-qm', 'Base')
  run('branch', 'same-tree')
  const head = run('rev-parse', 'HEAD')
  return { root, service, run, head, directory: join(root, '.git') }
}

const request = (from: string, target = 'same-tree') => ({ current: 'main', target, from, to: from })

test('same-tree branch switching is atomic and preserves staged, unstaged and untracked work', async t => {
  const { root, service, run, head, directory } = await fixture(t)
  const file = join(root, 'source.txt')
  await writeFile(file, 'staged\n'); run('add', '--', 'source.txt'); await writeFile(file, 'working\n')
  await writeFile(join(root, 'untracked.txt'), 'untracked\n')
  const beforeIndex = await readFile(join(directory, 'index'))
  assert.equal((await service.status(root)).kind, 'repository')
  await service.browse(root)
  assert.equal(await service.switchBranch(root, request(head), async () => false), false)
  // A declined native approval must not invalidate the reviewed snapshot or move HEAD.
  assert.equal(run('symbolic-ref', '--quiet', '--no-recurse', 'HEAD'), 'refs/heads/main')
  await service.status(root); await service.browse(root)
  assert.equal(await service.switchBranch(root, request(head), async () => true), true)
  assert.equal(run('symbolic-ref', '--quiet', '--no-recurse', 'HEAD'), 'refs/heads/same-tree')
  assert.deepEqual(await readFile(join(directory, 'index')), beforeIndex)
  assert.equal(await readFile(file, 'utf8'), 'working\n')
  assert.equal(await readFile(join(root, 'untracked.txt'), 'utf8'), 'untracked\n')
  assert.equal((await service.status(root)).kind, 'repository')
})

test('branch switching rejects different trees and linked worktrees', async t => {
  const { root, service, run, head } = await fixture(t)
  run('checkout', '-qb', 'different')
  await writeFile(join(root, 'source.txt'), 'different\n'); run('add', '--', 'source.txt'); run('commit', '-qm', 'Different tree')
  const other = run('rev-parse', 'HEAD')
  run('checkout', '-q', 'main')
  run('branch', 'different-same-tree', head)
  await service.status(root); await service.browse(root)
  await assert.rejects(service.switchBranch(root, { current: 'main', target: 'different', from: head, to: other }, async () => true), /matching|trees match/)
  assert.equal(run('symbolic-ref', '--quiet', '--no-recurse', 'HEAD'), 'refs/heads/main')

  const linked = join(root, 'linked-checkout')
  run('worktree', 'add', '-q', linked, 'different-same-tree')
  await service.status(root); await service.browse(root)
  await assert.rejects(service.switchBranch(root, { current: 'main', target: 'different-same-tree', from: head, to: head }, async () => true), /linked worktrees/)
  assert.equal(run('symbolic-ref', '--quiet', '--no-recurse', 'HEAD'), 'refs/heads/main')
})

test('branch switching compares reviewed ref identities again in Git atomic ref transaction', async t => {
  const { root, run, head } = await fixture(t)
  const ordinary = new SourceControlService()
  t.after(async () => { ordinary.close(); await ordinary.drain() })
  await ordinary.status(root); await ordinary.browse(root)
  // Move the target after Ion's exact-tree checks but before the transaction starts.
  const wrapping: typeof git = async (repository, signal, args, options) => {
    if (args[0] === 'update-ref' && args[1] === '--stdin') {
      const file = join(root, 'source.txt')
      await writeFile(file, 'new commit\n')
      run('add', '--', 'source.txt'); run('commit', '-qm', 'Move target')
      run('branch', '-f', 'same-tree', 'HEAD')
      await writeFile(file, 'base\n')
    }
    return git(repository, signal, args, options)
  }
  const raced = new SourceControlService(wrapping)
  t.after(async () => { raced.close(); await raced.drain() })
  await raced.status(root); await raced.browse(root)
  const actual = run('rev-parse', 'HEAD')
  await assert.rejects(raced.switchBranch(root, request(actual), async () => true))
  assert.equal(run('symbolic-ref', '--quiet', '--no-recurse', 'HEAD'), 'refs/heads/main')
  assert.notEqual(run('rev-parse', 'refs/heads/same-tree'), head)
})
