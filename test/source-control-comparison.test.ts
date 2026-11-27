import assert from 'node:assert/strict'
import { execFileSync, type SpawnOptions } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
  const index = await readFile(join(root, '.git', 'index'))
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
  assert.deepEqual(await readFile(join(root, '.git', 'index')), index)
  assert.equal(await readFile(source, 'utf8'), 'dirty source\n')
  assert.equal(git('rev-parse', 'HEAD'), head)
  git('update-ref', '-d', 'refs/stash')
  await assert.rejects(service.previewComparison(root, request), /references changed/)
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
