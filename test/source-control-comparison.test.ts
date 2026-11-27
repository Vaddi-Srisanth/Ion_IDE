import assert from 'node:assert/strict'
import { execFileSync, type SpawnOptions } from 'node:child_process'
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { SourceControlService } from '../src/main/source-control'
import { resolveGit } from '../src/main/source-control/repository'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-compare-git-')))
  const service = new SourceControlService()
  t.after(async () => { service.close(); await service.drain(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const tool = await resolveGit(root, new AbortController().signal)
  assert.ok(tool)
  const git = (...args: string[]) => execFileSync(tool.executable, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 8000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Ion fixture'); git('config', 'user.email', 'fixture@ion.invalid')
  git('config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'source.txt'), 'base\n')
  git('add', '--', 'source.txt'); git('commit', '-qm', 'Base')
  return { root, service, git, base: git('rev-parse', 'HEAD') }
}

test('real branch and stash previews honor tree direction, the stash base, and dirty and staged work', async t => {
  const { root, service, git, base } = await fixture(t)
  git('branch', 'old-tip')
  const source = join(root, 'source.txt')
  await writeFile(source, 'stashed working file\n'); await writeFile(join(root, 'untracked.txt'), 'stashed untracked file\n')
  git('stash', 'push', '-qu', '-m', 'Fixture')
  const stash = git('rev-parse', 'refs/stash')
  git('checkout', '-qb', 'topic')
  await writeFile(source, 'topic\n'); await writeFile(join(root, 'topic.txt'), 'topic\n')
  git('add', '-A'); git('commit', '-qm', 'Topic')
  const topic = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main'); await writeFile(join(root, 'main.txt'), 'main\n')
  git('add', '-A'); git('commit', '-qm', 'Main')
  const head = git('rev-parse', 'HEAD')
  git('checkout', '-qb', 'future'); git('commit', '--allow-empty', '-qm', 'Future'); const future = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main'); git('pack-refs', '--all', '--prune')
  await writeFile(source, 'staged source\n'); git('add', '--', 'source.txt'); await writeFile(source, 'dirty source\n')
  const staged = git('diff', '--cached', '--binary', 'HEAD')
  const branch = (name: string, to: string) => ({ kind: 'branch' as const, name, from: head, to })
  assert.equal((await service.status(root)).kind, 'repository')
  await assert.rejects(service.previewComparison(root, branch('topic', topic)), /reviewed branch/)
  assert.deepEqual((await service.browse(root)).stash, { oid: stash })
  assert.deepEqual(await service.previewComparison(root, branch('topic', topic)), {
    from: head, to: topic, relation: 'diverged', includesUntrackedParent: false, truncated: false,
    changes: [{ status: 'D', path: 'main.txt' }, { status: 'M', path: 'source.txt' }, { status: 'A', path: 'topic.txt' }],
  })
  assert.equal((await service.previewComparison(root, branch('main', head))).relation, 'same')
  assert.equal((await service.previewComparison(root, branch('old-tip', base))).relation, 'behind')
  assert.equal((await service.previewComparison(root, branch('future', future))).relation, 'ahead')
  const request = { kind: 'stash', name: 'refs/stash', from: head, to: stash }
  assert.deepEqual(await service.previewComparison(root, request), { from: base, to: stash, relation: 'stash',
    changes: [{ status: 'M', path: 'source.txt' }], truncated: false, includesUntrackedParent: true })
  for (const bad of [branch('HEAD~1', base), branch('refs/tags/other', topic), branch('topic', future), { ...request, name: 'stash@{0}' }]) {
    await assert.rejects(service.previewComparison(root, bad), /reviewed branch/)
  }
  assert.equal(git('diff', '--cached', '--binary', 'HEAD'), staged)
  assert.equal(await readFile(source, 'utf8'), 'dirty source\n')
  assert.equal(git('rev-parse', 'HEAD'), head)
  git('update-ref', '-d', 'refs/stash')
  await assert.rejects(service.previewComparison(root, request), /references changed/)
})

test('reviewed stash snapshot keeps staged, working and untracked filesystem state intact', async t => {
  const { root, service, git, base } = await fixture(t)
  const source = join(root, 'source.txt')
  await writeFile(source, 'older saved change\n'); git('stash', 'push', '-qm', 'Earlier snapshot')
  const earlierStash = git('rev-parse', 'refs/stash')
  await writeFile(source, 'staged change\n'); git('add', '--', 'source.txt')
  await writeFile(source, 'working change\n')
  await writeFile(join(root, 'untracked.txt'), 'untracked remains outside snapshot\n')
  const staged = git('diff', '--cached', '--binary', 'HEAD')
  assert.equal((await service.status(root)).kind, 'repository')
  assert.equal(await service.saveStashSnapshot(root, async () => false), null)
  assert.equal(git('stash', 'list').split('\n').length, 1)
  const oid = await service.saveStashSnapshot(root, async review => {
    assert.deepEqual(review, { branch: 'main', head: base, files: 1 })
    return true
  })
  assert.match(oid ?? '', /^[0-9a-f]{40}$/)
  assert.equal(git('rev-parse', 'refs/stash'), oid)
  assert.equal(git('rev-parse', 'refs/stash@{1}'), earlierStash)
  assert.equal(git('rev-parse', 'HEAD'), base)
  assert.equal(await readFile(source, 'utf8'), 'working change\n')
  assert.equal(await readFile(join(root, 'untracked.txt'), 'utf8'), 'untracked remains outside snapshot\n')
  assert.equal(git('diff', '--cached', '--binary', 'HEAD'), staged)
  const parents = git('rev-list', '--parents', '-n', '1', 'refs/stash').split(' ')
  assert.equal(parents.length, 3, 'snapshot contains the working tree and index commits, not an untracked-files parent')
})

test('reviewed stash pop applies index and worktree, cancel preserves the stash, and conflicts retain it', async t => {
  const { root, service, git } = await fixture(t)
  const source = join(root, 'source.txt')
  await writeFile(source, 'stashed change\n')
  git('add', '--', 'source.txt')
  await writeFile(source, 'stashed staged and worktree\n')
  git('stash', 'push', '-qm', 'Pop fixture')
  const oid = git('rev-parse', 'refs/stash')
  git('reset', '--hard', '-q', 'HEAD')
  assert.equal((await service.status(root)).kind, 'repository')
  assert.deepEqual((await service.browse(root)).stash, { oid })
  assert.equal(await service.popStash(root, { oid }, [], async () => false), null)
  assert.equal(git('rev-parse', 'refs/stash'), oid)
  assert.equal(await readFile(source, 'utf8'), 'base\n')
  await service.status(root); await service.browse(root)
  let prompted = false
  try { await service.popStash(root, { oid }, [source], async () => { prompted = true; return true }) }
  catch (error) { assert.equal((error as Error).message, 'Save or close modified editor files before applying a stash.') }
  assert.equal(prompted, false)
  const result = await service.popStash(root, { oid }, [], async review => {
    assert.deepEqual(review, { branch: 'main', oid })
    return true
  })
  assert.deepEqual(result, { applied: true, conflicts: false })
  assert.equal(await readFile(source, 'utf8'), 'stashed staged and worktree\n')
  assert.equal(git('show', ':source.txt'), 'base')
  assert.equal(git('diff', '--', 'source.txt').includes('+stashed staged and worktree'), true)
  assert.equal(git('stash', 'list'), '')

  await writeFile(source, 'conflicting stashed edit\n')
  git('stash', 'push', '-qm', 'Conflict fixture')
  const conflictOid = git('rev-parse', 'refs/stash')
  git('reset', '--hard', '-q', 'HEAD')
  await writeFile(source, 'committed competing edit\n')
  git('add', '--', 'source.txt'); git('commit', '-qm', 'Competing edit')
  const conflictBase = git('rev-parse', 'HEAD')
  await writeFile(source, 'conflicting stashed edit\n'); git('stash', 'push', '-qm', 'Conflict fixture two')
  // Restore the first stash as the selected, reviewed stash, then create a divergent clean HEAD.
  git('stash', 'drop', '-q', 'stash@{0}')
  git('update-ref', 'refs/stash', conflictOid)
  git('reset', '--hard', '-q', conflictBase)
  await service.status(root)
  await service.browse(root)
  const conflict = await service.popStash(root, { oid: conflictOid }, [], async () => true)
  assert.deepEqual(conflict, { applied: false, conflicts: true })
  assert.equal(git('rev-parse', 'refs/stash'), conflictOid)
  assert.match(await readFile(source, 'utf8'), /^(<<<<<<<|committed competing edit)/m)
})

test('a ref removed during a preview of packed refs invalidates the result, including in a linked worktree', async t => {
  const { root, service, git, base } = await fixture(t)
  git('branch', 'old-tip'); git('commit', '--allow-empty', '-qm', 'New head')
  const head = git('rev-parse', 'HEAD')
  const linked = join(root, 'linked')
  git('worktree', 'add', '-q', '--detach', linked, head); git('pack-refs', '--all', '--prune')
  await service.status(linked); await service.browse(linked)
  const request = { kind: 'branch', name: 'old-tip', from: head, to: base }
  await assert.rejects(service.previewComparison(root, request), /Refresh/)
  const processes = require('node:child_process') as typeof import('node:child_process')
  const spawn = processes.spawn
  let changed = false
  t.mock.method(processes, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
    if (!changed && options.cwd === linked && args.includes('diff-tree')) {
      git('update-ref', '-d', 'refs/heads/old-tip'); changed = true
    }
    return spawn(command, args, options)
  })
  await assert.rejects(service.previewComparison(linked, request), /references changed/)
  assert.equal(changed, true)
})

test('cached remote comparison stays offline, preserves local work, and rejects unreviewed refs and a same-OID symbolic race', async t => {
  const { root, service, git, base } = await fixture(t)
  const source = join(root, 'source.txt')
  git('checkout', '-qb', 'topic')
  await writeFile(source, 'remote change\n')
  git('add', '--', 'source.txt'); git('commit', '-qm', 'Cached remote revision')
  const to = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  git('branch', 'origin/topic', base)
  git('remote', 'add', 'origin', 'https://example.invalid/offline.git')
  git('update-ref', 'refs/remotes/origin/topic', to)
  git('update-ref', 'refs/remotes/origin/alias-target', to)
  git('update-ref', 'refs/remotes/origin/display-\u202edir', to)
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic')
  git('pack-refs', '--all', '--prune')
  await writeFile(source, 'staged source\n'); git('add', '--', 'source.txt'); await writeFile(source, 'dirty source\n')
  const index = await readFile(join(root, '.git', 'index'))
  const request = { kind: 'cached-remote-branch', name: 'origin/topic', from: base, to }
  await service.status(root)
  await assert.rejects(service.previewComparison(root, request), /reviewed branch/)
  const browse = await service.browse(root)
  assert.deepEqual(browse.cachedRemoteBranches, [
    { name: 'origin/alias-target', oid: to }, { name: 'origin/topic', oid: to },
  ])
  assert.equal(browse.truncated, true)
  for (const bad of [
    { name: 'origin/HEAD' }, { name: 'origin/display-\u202edir' }, { name: 'refs/remotes/origin/topic' },
    { name: 'origin/*' }, { name: 'origin/../topic' }, { to: base }, { from: to }, { kind: 'branch' },
  ]) await assert.rejects(service.previewComparison(root, { ...request, ...bad }), /reviewed branch/)

  const processes = require('node:child_process') as typeof import('node:child_process')
  const spawn = processes.spawn
  let changeDuringPreview = false
  let raced = false
  let gitReads = 0
  t.mock.method(processes, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
    if (options.cwd === root && args.some(argument => argument.startsWith('--git-dir='))) {
      gitReads++
      assert.equal(options.env?.GIT_ALLOW_PROTOCOL, '')
      assert.equal(options.env?.GIT_NO_LAZY_FETCH, '1')
      assert.ok(args.every(argument => !['fetch', 'pull', 'push', 'ls-remote'].includes(argument)))
      if (changeDuringPreview && args.includes('diff-tree')) {
        git('symbolic-ref', 'refs/remotes/origin/topic', 'refs/remotes/origin/alias-target')
        raced = true
      }
    }
    return spawn(command, args, options)
  })
  assert.deepEqual(await service.previewComparison(root, request), { from: base, to, relation: 'ahead',
    changes: [{ status: 'M', path: 'source.txt' }], truncated: false, includesUntrackedParent: false })
  assert.ok(gitReads > 0)
  git('update-ref', 'refs/remotes/origin/topic', base, to)
  await assert.rejects(service.previewComparison(root, request), /references changed/)
  git('update-ref', 'refs/remotes/origin/topic', to, base)
  changeDuringPreview = true
  await assert.rejects(service.previewComparison(root, request), /references changed/)
  assert.equal(raced, true)
  assert.equal(git('rev-parse', 'refs/remotes/origin/topic'), to)
  assert.deepEqual(await readFile(join(root, '.git', 'index')), index)
  assert.equal(await readFile(source, 'utf8'), 'dirty source\n')
  assert.equal(git('rev-parse', 'HEAD'), base)
})

test('comparison bounds file rows, omits unsafe names, and rejects a previously displayed HEAD after it moves', async t => {
  const { root, service, git, base } = await fixture(t)
  git('checkout', '-qb', 'path-review')
  await writeFile(join(root, 'readable.txt'), 'ok')
  await writeFile(join(root, 'direction-\u202e.txt'), 'hidden control character')
  git('add', '-A'); git('commit', '-qm', 'Two paths')
  const small = git('rev-parse', 'HEAD')
  git('checkout', '-qb', 'many')
  await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(join(root, `file-${index}.txt`), 'bounded')))
  git('add', '-A'); git('commit', '-qm', 'Many paths')
  const large = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  await service.status(root); await service.browse(root)
  const request = { kind: 'branch', name: 'path-review', from: base, to: small }
  const short = await service.previewComparison(root, request)
  assert.deepEqual(short.changes, [{ status: 'A', path: 'readable.txt' }]); assert.equal(short.truncated, true)
  const many = await service.previewComparison(root, { ...request, name: 'many', to: large })
  assert.equal(many.truncated, true); assert.equal(many.changes.length, 200)
  git('commit', '--allow-empty', '-qm', 'Advance HEAD')
  await assert.rejects(service.previewComparison(root, request), /references changed/)
})

test('cached remote refs reject metadata paths redirected outside the repository', async t => {
  const { root, service, git, base } = await fixture(t)
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'ion-redirected-git-refs-')))
  t.after(() => rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const remote = join(root, '.git', 'refs', 'remotes', 'origin')
  git('update-ref', 'refs/remotes/origin/topic', base)
  await service.status(root)
  const current = [{ name: 'origin/topic', oid: base }]
  assert.deepEqual((await service.browse(root)).cachedRemoteBranches, current)
  const request = { kind: 'cached-remote-branch', name: 'origin/topic', from: base, to: base }
  const directory = join(outside, 'origin')
  await rename(remote, directory)
  await symlink(directory, remote, process.platform === 'win32' ? 'junction' : 'dir')
  // Git resolves the linked metadata to the same object. Ion still refuses the comparison.
  assert.equal(git('rev-parse', 'refs/remotes/origin/topic'), base)
  await assert.rejects(service.previewComparison(root, request), /references changed/)
  const redirected = await service.browse(root)
  assert.deepEqual(redirected.cachedRemoteBranches, [])
  assert.equal(redirected.truncated, true)

  if (process.platform !== 'win32') {
    await rm(remote)
    await rename(directory, remote)
    assert.deepEqual((await service.browse(root)).cachedRemoteBranches, current)
    const leaf = join(remote, 'topic'), linked = join(outside, 'topic')
    await rename(leaf, linked)
    await symlink(linked, leaf, 'file')
    assert.equal(git('rev-parse', 'refs/remotes/origin/topic'), base)
    await assert.rejects(service.previewComparison(root, request), /references changed/)
    assert.deepEqual((await service.browse(root)).cachedRemoteBranches, [])
  }
})
