import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { SourceControlService } from '../src/main/source-control'
import { git as runGit, resolveGit } from '../src/main/source-control/repository'

const execute = promisify(execFile)
type FixtureGit = (...args: string[]) => Promise<string>

async function fixture(body: (context: {
  root: string; parent: string; service: SourceControlService; git: FixtureGit
}) => Promise<void>, beforeGit?: (args: readonly string[], git: FixtureGit) => Promise<void>) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'ion-git-')))
  const root = join(parent, 'code repo')
  let service: SourceControlService | undefined
  try {
    await mkdir(root)
    const tool = await resolveGit(root, new AbortController().signal)
    assert.ok(tool, 'The Source Control integration tests require system Git')
    const git = async (...args: string[]) => (await execute(tool.executable, [
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: root, timeout: 8000, windowsHide: true })).stdout
    service = new SourceControlService(async (...request) => {
      await beforeGit?.(request[2], git)
      return runGit(...request)
    })
    await git('init', '-q', '-b', 'main')
    await git('config', 'user.name', 'Ion Fixture')
    await git('config', 'user.email', 'fixture@ion.invalid')
    await git('config', 'core.autocrlf', 'false')
    await body({ root, parent, service, git })
  } finally {
    service?.close()
    await service?.drain()
    await rm(parent, { recursive: true, force: true })
  }
}

async function status(service: SourceControlService, root: string) {
  const result = await service.status(root)
  assert.equal(result.kind, 'repository')
  return result
}

test('Source Control reports saved and staged content, stages literal paths and commits only the index', async () => {
  await fixture(async ({ root, service, git }) => {
    const path = '-資料 notes.c'
    const disk = join(root, path)
    const oldText = 'int value = 1;\r\n'
    const stagedText = 'int value = 2;\r\n'
    const workingText = 'int value = 3;\r\n'
    await writeFile(disk, oldText)
    await writeFile(join(root, '.gitignore'), 'local-secret\n')
    await git('add', '--', path, '.gitignore')
    await git('commit', '-qm', 'Initial source')
    await writeFile(disk, stagedText)
    await writeFile(join(root, 'local-secret'), 'ignored fixture\n')
    await writeFile(join(root, 'untouched.txt'), 'keep this untracked\n')
    let current = await status(service, root)
    assert.equal(current.branch, 'main')
    assert.equal(current.unborn, false)
    assert.deepEqual(current.entries.map(({ path, index, worktree }) => [path, index, worktree]),
      [[path, '', 'M'], ['untouched.txt', '', '?']])
    assert.deepEqual(await service.diff(root, { path, side: 'working' }), {
      path, absolutePath: disk, previousPath: undefined, side: 'working', kind: 'text', original: oldText, modified: stagedText,
    })
    await assert.rejects(async () => service.change(root, { path: 'local-secret', action: 'stage' }), /Refresh/)
    await assert.rejects(async () => service.change(root, { path: '../outside', action: 'stage' }), /Invalid Git path/)
    await service.change(root, { path, action: 'stage' })
    assert.equal(await git('show', ':' + path), stagedText)
    await writeFile(disk, workingText)
    current = await status(service, root)
    assert.deepEqual(current.entries.map(({ path, index, worktree }) => [path, index, worktree]),
      [[path, 'M', 'M'], ['untouched.txt', '', '?']])
    const index = await service.diff(root, { path, side: 'staged' })
    assert.equal(index.kind, 'text')
    assert.equal(index.original, oldText)
    assert.equal(index.modified, stagedText)
    const working = await service.diff(root, { path, side: 'working' })
    assert.equal(working.kind, 'text')
    assert.equal(working.original, stagedText)
    assert.equal(working.modified, workingText)
    await service.change(root, { path, action: 'unstage' })
    assert.equal(await git('show', ':' + path), oldText)
    assert.equal(await readFile(disk, 'utf8'), workingText)
    await status(service, root)
    await service.change(root, { path, action: 'stage' })
    await status(service, root)
    await service.commit(root, { message: 'Update value' })
    assert.equal(await git('show', 'HEAD:' + path), workingText)
    assert.equal((await git('log', '-1', '--format=%s')).trim(), 'Update value')
    assert.deepEqual((await status(service, root)).entries.map(({ path }) => path), ['untouched.txt'])
  })
})

test('Source Control handles first commits, renames, deletion, detached HEAD and bounded diffs', async () => {
  await fixture(async ({ root, service, git }) => {
    const first = 'notes.txt'
    const next = 'renamed notes.txt'
    await writeFile(join(root, first), 'an original line\n')
    assert.equal((await status(service, root)).unborn, true)
    await service.change(root, { path: first, action: 'stage' })
    await status(service, root)
    await service.change(root, { path: first, action: 'unstage' })
    assert.deepEqual((await status(service, root)).entries.map(({ worktree }) => worktree), ['?'])
    await service.change(root, { path: first, action: 'stage' })
    await status(service, root)
    await service.commit(root, { message: 'First commit' })
    await git('mv', '--', first, next)
    const renamed = (await status(service, root)).entries[0]
    assert.equal(renamed.index, 'R')
    assert.equal(renamed.previousPath, first)
    const diff = await service.diff(root, { path: next, side: 'staged' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.original, 'an original line\n')
    assert.equal(diff.modified, diff.original)
    await service.change(root, { path: next, action: 'unstage' })
    assert.equal(await readFile(join(root, next), 'utf8'), diff.modified)
    const deleted = (await status(service, root)).entries.find(({ path }) => path === first)
    assert.equal(deleted?.worktree, 'D')
    const deletion = await service.diff(root, { path: first, side: 'working' })
    assert.equal(deletion.kind, 'text')
    assert.equal(deletion.modified, '')
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(root, 'large.txt'), 'x'.repeat(256 * 1024 + 1))
    await writeFile(join(root, 'long.txt'), 'x\n'.repeat(12_001))
    await git('checkout', '--detach', '-q')
    assert.equal((await status(service, root)).detached, true)
    for (const path of ['binary.dat', 'large.txt', 'long.txt']) {
      assert.equal((await service.diff(root, { path, side: 'working' })).kind, 'unavailable')
    }
  })
})

test('Source Control scopes nested folders and supports only linked worktrees with matching metadata', async () => {
  await fixture(async ({ root, parent, service, git }) => {
    await git('commit', '--allow-empty', '-qm', 'Initial commit')
    const folder = join(root, 'child')
    const worktree = join(parent, 'linked project')
    await mkdir(folder)
    assert.equal((await service.status(folder)).kind, 'none')
    await git('worktree', 'add', '-q', '-b', 'linked', worktree)
    await writeFile(join(worktree, 'linked.txt'), 'owned by the linked worktree')
    assert.equal((await status(service, worktree)).branch, 'linked')
    await assert.rejects(async () => service.change(root, { path: 'linked.txt', action: 'stage' }), /Refresh/)
    await service.change(worktree, { path: 'linked.txt', action: 'stage' })
    assert.equal((await status(service, worktree)).entries[0].index, 'A')
    assert.equal(await git('diff', '--cached', '--name-only'), '')
    const forged = join(parent, 'forged workspace')
    await mkdir(forged)
    await writeFile(join(forged, '.git'), await readFile(join(worktree, '.git')))
    await assert.rejects(service.status(forged), /does not match this workspace/)
    const outstanding = service.status(root)
    service.close()
    await assert.rejects(outstanding, { name: 'AbortError' })
  })
})

test('Source Control avoids hooks and local filters and detects an externally changed index before committing', async () => {
  await fixture(async ({ root, service, git }) => {
    const hook = join(root, '.git', 'hooks', 'post-commit')
    await writeFile(hook, '#!/bin/sh\ntouch ion-hook-ran\n')
    await chmod(hook, 0o755)
    await git('config', 'core.hooksPath', '.git/hooks')
    await writeFile(join(root, 'one.txt'), 'one\n')
    await writeFile(join(root, 'two.txt'), 'two\n')
    await status(service, root)
    await service.change(root, { path: 'one.txt', action: 'stage' })
    await status(service, root)
    await git('add', '--', 'two.txt')
    await assert.rejects(async () => service.commit(root, { message: 'Stale' }), /Staged changes.*changed/)
    await status(service, root)
    await service.commit(root, { message: 'Explicit commit' })
    await assert.rejects(readFile(join(root, 'ion-hook-ran')), { code: 'ENOENT' })
    await git('config', 'filter.untrusted.clean', 'touch ion-filter-ran')
    await writeFile(join(root, '.gitattributes'), '*.txt filter=untrusted\n')
    await writeFile(join(root, 'one.txt'), 'modified\n')
    await assert.rejects(service.status(root), /configures a local Git filter/)
    await assert.rejects(readFile(join(root, 'ion-filter-ran')), { code: 'ENOENT' })
  })
})

test('a late external stage stays in the real index and outside the reviewed commit', async () => {
  let realIndexAfterStage: Buffer | undefined
  let workingRoot = ''
  let injected = false
  await fixture(async ({ root, service, git }) => {
    workingRoot = root
    await writeFile(join(root, 'reviewed.txt'), 'before\n')
    await writeFile(join(root, 'old name.txt'), 'rename this\n')
    await writeFile(join(root, 'removed.txt'), 'remove this\n')
    await git('add', '--', 'reviewed.txt', 'old name.txt', 'removed.txt')
    await git('commit', '-qm', 'Initial commit')
    await writeFile(join(root, 'reviewed.txt'), 'reviewed\n')
    await writeFile(join(root, 'not-reviewed.txt'), 'outside the reviewed tree\n')
    await git('add', '--', 'reviewed.txt')
    await git('mv', '--', 'old name.txt', 'new name.txt')
    await git('rm', '--', 'removed.txt')
    const current = await status(service, root)
    assert.deepEqual(current.entries.filter(entry => entry.index).map(({ path, index }) => [path, index]),
      [['new name.txt', 'R'], ['removed.txt', 'D'], ['reviewed.txt', 'M']])
    await service.commit(root, { message: 'Publish reviewed changes locally' })
    assert.equal(injected, true)
    assert.equal(await git('ls-tree', '--name-only', 'HEAD'), 'new name.txt\nreviewed.txt\n')
    assert.equal(await git('show', 'HEAD:reviewed.txt'), 'reviewed\n')
    assert.equal(await git('show', ':reviewed.txt'), 'staged during commit\n')
    assert.equal(await git('show', ':not-reviewed.txt'), 'outside the reviewed tree\n')
    assert.deepEqual(await readFile(join(root, '.git', 'index')), realIndexAfterStage)
  }, async (args, git) => {
    if (args[0] !== 'update-ref') return
    injected = true
    await writeFile(join(workingRoot, 'reviewed.txt'), 'staged during commit\n')
    await git('add', '--', 'not-reviewed.txt', 'reviewed.txt')
    realIndexAfterStage = await readFile(join(workingRoot, '.git', 'index'))
  })
})

test('a concurrent branch advance fails the ref compare-and-swap without modifying the index', async () => {
  let externalCommit = ''
  await fixture(async ({ root, service, git }) => {
    await git('commit', '--allow-empty', '-qm', 'Initial commit')
    await writeFile(join(root, 'reviewed.txt'), 'will remain staged\n')
    await git('add', '--', 'reviewed.txt')
    await status(service, root)
    const index = await readFile(join(root, '.git', 'index'))
    await assert.rejects(async () => service.commit(root, { message: 'Stale parent' }), /cannot lock ref/)
    assert.ok(externalCommit)
    assert.equal((await git('rev-parse', 'HEAD')).trim(), externalCommit)
    assert.equal(await git('diff', '--cached', '--name-only'), 'reviewed.txt\n')
    assert.deepEqual(await readFile(join(root, '.git', 'index')), index)
  }, async (args, git) => {
    if (args[0] !== 'update-ref') return
    const old = (await git('rev-parse', 'HEAD')).trim()
    const tree = (await git('rev-parse', 'HEAD^{tree}')).trim()
    externalCommit = (await git('commit-tree', tree, '-p', old, '-m', 'External commit')).trim()
    await git('update-ref', 'refs/heads/main', externalCommit, old)
  })
})

test('committing a linked worktree keeps its real index and blocks detached and sequencer state', async () => {
  await fixture(async ({ root, parent, service, git }) => {
    await git('commit', '--allow-empty', '-qm', 'Initial commit')
    const head = (await git('rev-parse', 'HEAD')).trim()
    const worktree = join(parent, 'second workspace')
    await git('worktree', 'add', '-q', '-b', 'linked', worktree)
    await writeFile(join(worktree, 'linked.txt'), 'linked commit\n')
    await status(service, worktree)
    await service.change(worktree, { path: 'linked.txt', action: 'stage' })
    await status(service, worktree)
    await service.commit(worktree, { message: 'Commit from linked worktree' })
    assert.equal(await git('show', 'linked:linked.txt'), 'linked commit\n')
    assert.equal((await git('rev-parse', 'HEAD')).trim(), head)
    await writeFile(join(root, 'staged.txt'), 'remain staged')
    await git('add', '--', 'staged.txt')
    await writeFile(join(root, '.git', 'MERGE_HEAD'), head + '\n')
    await status(service, root)
    await assert.rejects(async () => service.commit(root, { message: 'Pending merge' }), /Finish the active Git operation/)
    assert.equal((await git('rev-parse', 'HEAD')).trim(), head)
    await rm(join(root, '.git', 'MERGE_HEAD'))
    await git('checkout', '--detach', '-q')
    await status(service, root)
    await assert.rejects(async () => service.commit(root, { message: 'Detached' }), /Switch to a branch/)
    assert.equal((await git('rev-parse', 'HEAD')).trim(), head)
    assert.equal(await git('diff', '--cached', '--name-only'), 'staged.txt\n')
  })
})
