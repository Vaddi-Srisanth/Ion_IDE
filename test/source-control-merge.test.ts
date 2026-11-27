import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { SourceControlService } from '../src/main/source-control'
import { resolveGit } from '../src/main/source-control/repository'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-merge-git-')))
  const service = new SourceControlService()
  t.after(async () => { service.close(); await service.drain(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const tool = await resolveGit(root, new AbortController().signal)
  assert.ok(tool)
  const git = (...args: string[]) => execFileSync(tool.executable, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 8000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Ion fixture'); git('config', 'user.email', 'fixture@ion.invalid')
  // Keep the byte-level fixture independent of a host-wide Git for Windows
  // autocrlf default, so it tests merge behavior rather than checkout policy.
  git('config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'source.txt'), 'base\n')
  git('add', '--', 'source.txt'); git('commit', '-qm', 'Base')
  const base = git('rev-parse', 'HEAD')
  return { root, service, git, base, source: join(root, 'source.txt') }
}

async function prepare(root: string, service: SourceControlService) {
  assert.equal((await service.status(root)).kind, 'repository')
  await service.browse(root)
}

test('pull from a reviewed cached remote branch is explicit, keeps HEAD until commit, and refuses dirty editors', async t => {
  const { root, service, git, base, source } = await fixture(t)
  git('checkout', '-qb', 'topic')
  await writeFile(join(root, 'topic.txt'), 'topic\n'); git('add', '--', 'topic.txt'); git('commit', '-qm', 'Topic')
  const topic = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/topic', topic)
  git('checkout', '-q', 'main')
  await prepare(root, service)
  const request = { current: 'main', target: 'origin/topic', from: base, to: topic, targetKind: 'cached-remote' as const, dirtyPaths: [] }
  assert.throws(() => service.mergeBranch(root, { ...request, dirtyPaths: [source] }, async () => { throw new Error('must not prompt') }),
    /Save or close modified editor files before merging a branch/)
  assert.equal(await service.mergeBranch(root, request, async () => false), null)
  assert.equal(git('rev-parse', 'HEAD'), base)
  assert.equal(await readFile(join(root, 'topic.txt')).then(() => true, () => false), false)
  await prepare(root, service)
  await writeFile(join(root, '.git', 'ORIG_HEAD'), 'f'.repeat(40) + '\n')
  assert.deepEqual(await service.mergeBranch(root, request, async review => {
    assert.deepEqual(review, { current: 'main', target: 'origin/topic', from: base, to: topic, targetKind: 'cached-remote', dirtyPaths: [] })
    return true
  }), { applied: true, conflicts: false })
  assert.equal(git('rev-parse', 'HEAD'), base)
  assert.equal(git('rev-parse', 'MERGE_HEAD'), topic)
  assert.equal(await readFile(join(root, '.git', 'ORIG_HEAD'), 'utf8'), base + '\n')
  assert.equal(await readFile(join(root, 'topic.txt'), 'utf8'), 'topic\n')
  assert.match(git('status', '--porcelain'), /A  topic.txt/)
  await service.status(root)
  await service.commit(root, { message: 'Merge topic' })
  assert.deepEqual(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' '), [git('rev-parse', 'HEAD'), base, topic])
  assert.equal(await readFile(join(root, '.git', 'MERGE_HEAD')).then(() => true, () => false), false)
})

test('reviewed merge honors an explicit Git autocrlf policy when writing incoming files', async t => {
  const { root, service, git, base } = await fixture(t)
  git('config', 'core.autocrlf', 'true')
  git('checkout', '-qb', 'topic')
  await writeFile(join(root, 'topic.txt'), 'topic\n')
  git('add', '--', 'topic.txt'); git('commit', '-qm', 'Topic')
  const topic = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/topic', topic)
  git('checkout', '-q', 'main')
  await prepare(root, service)
  const request = { current: 'main', target: 'origin/topic', from: base, to: topic, targetKind: 'cached-remote' as const, dirtyPaths: [] }
  assert.deepEqual(await service.mergeBranch(root, request, async () => true), { applied: true, conflicts: false })
  assert.equal(await readFile(join(root, 'topic.txt'), 'utf8'), 'topic\r\n')
})

test('reviewed merge conflicts remain visible and an external merge driver is refused', async t => {
  const { root, service, git, source } = await fixture(t)
  git('checkout', '-qb', 'topic')
  await writeFile(source, 'topic edit\n'); git('add', '--', 'source.txt'); git('commit', '-qm', 'Topic edit')
  const topic = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  await writeFile(source, 'main edit\n'); git('add', '--', 'source.txt'); git('commit', '-qm', 'Main edit')
  const head = git('rev-parse', 'HEAD')
  await prepare(root, service)
  const request = { current: 'main', target: 'topic', from: head, to: topic, targetKind: 'local' as const, dirtyPaths: [] }
  assert.deepEqual(await service.mergeBranch(root, request, async () => true), { applied: true, conflicts: true })
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('rev-parse', 'MERGE_HEAD'), topic)
  assert.match(await readFile(source, 'utf8'), /<<<<<<< HEAD/)
  await writeFile(source, 'resolved\n')
  await service.status(root)
  await service.change(root, { path: 'source.txt', action: 'stage' })
  await service.status(root)
  await service.commit(root, { message: 'Resolve merge' })
  assert.deepEqual(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' '), [git('rev-parse', 'HEAD'), head, topic])
  assert.equal(await readFile(source, 'utf8'), 'resolved\n')

  const other = await fixture(t)
  other.git('checkout', '-qb', 'topic')
  const targetFile = join(other.root, 'other.txt')
  await writeFile(targetFile, 'target\n'); other.git('add', '--', 'other.txt'); other.git('commit', '-qm', 'Other')
  const target = other.git('rev-parse', 'HEAD')
  other.git('checkout', '-q', 'main')
  other.git('config', 'merge.untrusted.driver', 'touch /tmp/ion-should-not-run')
  await other.service.status(other.root); await other.service.browse(other.root)
  await assert.rejects(other.service.mergeBranch(other.root,
    { current: 'main', target: 'topic', from: other.base, to: target, targetKind: 'local', dirtyPaths: [] }, async () => true), /external merge driver/)
  assert.equal(other.git('rev-parse', 'HEAD'), other.base)
})
