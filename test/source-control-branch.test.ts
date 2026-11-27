import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SourceControlService } from '../src/main/source-control'
import { createLocalRef } from '../src/main/source-control/branches'
import { gitDirectory, resolveGit } from '../src/main/source-control/repository'

test('create a reviewed local branch without switching, overwriting a ref, or changing staged and working files', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-create-branch-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const command = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Ion Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim()
  command('init', '-q', '-b', 'main')
  const path = join(root, 'assignment.txt')
  await writeFile(path, 'first\n')
  command('add', '.')
  command('commit', '-qm', 'Baseline')
  const head = command('rev-parse', 'HEAD')
  await writeFile(path, 'staged\n')
  command('add', '.')
  await writeFile(path, 'uncommitted work\n')
  const signal = new AbortController().signal
  const tools = await resolveGit(root, signal)
  const directory = await gitDirectory(root)
  assert.ok(tools && directory)
  const repository = { root, directory, ...tools }
  const tag = (name: string, from = head) => createLocalRef(repository, signal, { name, from }, head, 'tag')
  await tag('submission-1')
  assert.equal(command('cat-file', '-t', 'refs/tags/submission-1'), 'commit')
  assert.equal(command('rev-parse', 'refs/tags/submission-1'), head)
  await assert.rejects(tag('submission-1'))
  await assert.rejects(tag('refs/heads/main'), /tag name/)
  await assert.rejects(tag('stale', '1'.repeat(head.length)), /review the starting commit/)
  const create = (name: string, from = head) => createLocalRef(repository, signal, { name, from }, head, 'branch')
  await create('course/assignment-1')
  assert.equal(command('rev-parse', 'refs/heads/course/assignment-1'), head)
  await assert.rejects(create('course/assignment-1'))
  for (const name of ['../outside', 'course/HEAD.lock', '--help', 'one//two', 'stuff/AUX.txt', 'bad@{0}']) {
    await assert.rejects(create(name), /branch name/)
  }
  await assert.rejects(create('changed', '1'.repeat(head.length)), /review the starting commit/)
  assert.equal(command('branch', '--show-current'), 'main')
  assert.equal(command('show', ':assignment.txt'), 'staged')
  assert.equal(await readFile(path, 'utf8'), 'uncommitted work\n')
  assert.equal(command('for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').length, 2)
})

test('branch creation checks the complete worktree registry including linked unborn and locked selections', async t => {
  const pool = await realpath(await mkdtemp(join(tmpdir(), 'ion-worktree-occupancy-')))
  const root = join(pool, 'main'), linked = join(pool, 'detached sibling'), unborn = join(pool, 'unborn sibling')
  await mkdir(root)
  const tool = await resolveGit(root, new AbortController().signal)
  assert.ok(tool)
  const service = new SourceControlService()
  t.after(async () => {
    service.close()
    await service.drain()
    await rm(pool, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const options = { cwd: root, encoding: 'utf8' as const, windowsHide: true, timeout: 8000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }
  const command = (...args: string[]) => execFileSync(tool.executable, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Ion Fixture', '-c', 'user.email=fixture@example.invalid', ...args], options).trim()
  command('init', '-q', '-b', 'main')
  command('commit', '-q', '--allow-empty', '-m', 'Base')
  const head = command('rev-parse', 'HEAD')
  command('worktree', 'add', '-q', '--detach', linked, head)
  const help = spawnSync(tool.executable, ['worktree', 'add', '-h'], options)
  if ((help.stdout + help.stderr).includes('--orphan')) {
    command('worktree', 'add', '-q', '--orphan', '-b', 'reserved', unborn)
  } else {
    command('worktree', 'add', '-q', '--detach', unborn, head)
    command('-C', unborn, 'checkout', '-q', '--orphan', 'reserved')
  }
  command('worktree', 'lock', '--reason', 'offline\nfixture', unborn)
  await writeFile(join(unborn, 'pending.txt'), 'keep staged\n')
  command('-C', unborn, 'add', '--', 'pending.txt')
  await writeFile(join(unborn, 'pending.txt'), 'keep working\n')
  const unbornDirectory = await gitDirectory(unborn)
  assert.ok(unbornDirectory)
  const index = await readFile(join(unbornDirectory, 'index'))
  for (const source of [root, linked]) {
    assert.equal((await service.status(source)).kind, 'repository')
    await assert.rejects(service.createBranch(source, { name: 'reserved', from: head }), /worktree already uses/)
    await assert.rejects(service.createBranch(source, { name: 'reserved/topic', from: head }), /worktree already uses/)
  }
  await service.createBranch(linked, { name: 'available', from: head })
  assert.equal(command('-C', linked, 'branch', '--show-current'), '')
  assert.equal(command('rev-parse', 'refs/heads/available'), head)
  await service.createTag(linked, { name: 'reserved', from: head })
  assert.equal(command('rev-parse', 'refs/tags/reserved'), head)
  assert.equal(command('for-each-ref', '--format=%(refname)', 'refs/heads/reserved'), '')
  assert.equal(command('-C', unborn, 'symbolic-ref', 'HEAD'), 'refs/heads/reserved')
  assert.deepEqual(await readFile(join(unbornDirectory, 'index')), index)
  assert.equal(await readFile(join(unborn, 'pending.txt'), 'utf8'), 'keep working\n')

  // Git versions may omit a broken registration and still report success.
  await mkdir(join(root, '.git', 'worktrees', 'private-registration'))
  await assert.rejects(service.createBranch(linked, { name: 'unverified', from: head }),
    { message: 'Git could not verify the registered worktrees.' })
  assert.equal(command('for-each-ref', '--format=%(refname)', 'refs/heads/unverified'), '')
  await rm(join(root, '.git', 'worktrees', 'private-registration'), { recursive: true })

  // A missing linked checkout is reported as prunable until Git unregisters it.
  await rm(linked, { recursive: true })
  assert.equal((await service.status(root)).kind, 'repository')
  await assert.rejects(service.createBranch(root, { name: 'prunable', from: head }),
    { message: 'Git could not verify the registered worktrees.' })
  assert.equal(command('for-each-ref', '--format=%(refname)', 'refs/heads/prunable'), '')
})
