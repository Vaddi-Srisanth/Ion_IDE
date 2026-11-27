import assert from 'node:assert/strict'
import { execFileSync, type SpawnOptions } from 'node:child_process'
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { SourceControlService } from '../src/main/source-control'
import { resolveGit } from '../src/main/source-control/repository'
import { reviewedRemotes } from '../src/main/source-control/remotes'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-browse-git-')))
  const service = new SourceControlService()
  t.after(async () => {
    service.close()
    await service.drain()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const tool = await resolveGit(root, new AbortController().signal)
  assert.ok(tool, 'Local Git is required for Source Control browsing tests.')
  const git = (args: string[], input?: string) => execFileSync(tool.executable, ['-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { cwd: root, input, encoding: 'utf8', windowsHide: true,
    timeout: 8000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } }).trim()
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Ion Fixture'])
  git(['config', 'user.email', 'fixture@ion.invalid'])
  return { root, service, git }
}

test('Git browser reads HEAD history, namespaced local refs and annotated tag objects without editing saved work', async t => {
  const { root, service, git } = await fixture(t)
  await assert.rejects(service.browse(root), /Refresh/)
  assert.equal((await service.status(root)).kind, 'repository')
  assert.deepEqual(await service.browse(root), { commits: [], branches: [], tags: [], remotes: [], truncated: false })
  const saved = join(root, 'saved.txt')
  await writeFile(saved, 'original\n')
  git(['add', '--', 'saved.txt'])
  git(['commit', '-qm', 'First subject', '-m', 'Body omitted from the browser.'])
  const first = git(['rev-parse', 'HEAD'])
  git(['branch', 'feature/é', first])
  git(['tag', 'feature/é', first])
  git(['update-ref', 'refs/remotes/origin/remote-only', first])
  git(['commit', '-q', '--allow-empty', '-m', 'Second subject'])
  const second = git(['rev-parse', 'HEAD'])
  git(['tag', '-a', 'release', '-m', 'Annotated tag object'])
  const tagObject = git(['rev-parse', 'refs/tags/release'])
  assert.notEqual(tagObject, second)
  git(['pack-refs', '--all', '--prune'])
  git(['config', 'log.showSignature', 'true'])
  git(['config', 'log.follow', 'true'])
  git(['config', 'format.pretty', 'oneline'])
  await writeFile(saved, 'staged\n')
  git(['add', '--', 'saved.txt'])
  await writeFile(saved, 'local edit\n')
  const index = await readFile(join(root, '.git', 'index'))
  const result = await service.browse(root)
  assert.deepEqual(result, {
    commits: [{ oid: second, subject: 'Second subject', author: 'Ion Fixture', time: 1577836800 },
      { oid: first, subject: 'First subject', author: 'Ion Fixture', time: 1577836800 }],
    branches: [{ name: 'feature/é', oid: first }, { name: 'main', oid: second }],
    tags: [{ name: 'feature/é', oid: first }, { name: 'release', oid: tagObject }], remotes: [], truncated: false,
  })
  assert.deepEqual(await readFile(join(root, '.git', 'index')), index)
  assert.equal(await readFile(saved, 'utf8'), 'local edit\n')
  git(['checkout', '--detach', '-q', first])
  const detached = await service.browse(root)
  assert.deepEqual(detached.commits, result.commits.slice(1))
  assert.deepEqual(detached.branches, result.branches)
  assert.deepEqual(detached.tags, result.tags)
  const linked = join(root, 'linked worktree')
  git(['worktree', 'add', '-q', '--detach', linked, second])
  assert.equal((await service.status(linked)).kind, 'repository')
  assert.deepEqual(await service.browse(linked), result)
  await service.createBranch(linked, { name: 'reviewed', from: second })
  assert.ok((await service.browse(linked)).branches.some(ref => ref.name === 'reviewed' && ref.oid === second))
})

test('Git browser enforces independent record limits and length limits for display fields', async t => {
  const { root, service, git } = await fixture(t)
  const history: string[] = []
  for (let index = 0; index < 52; index++) {
    const subject = index === 51 ? 'x'.repeat(700) : `Commit ${index}`
    history.push('commit refs/heads/main', 'committer Ion <ion@fixture.invalid> 1577836800 +0000', `data ${subject.length}`, subject, '')
  }
  git(['fast-import', '--quiet'], history.join('\n') + '\n')
  const oid = git(['rev-parse', 'HEAD'])
  const refs = Array.from({ length: 102 }, (_, index) => {
    const name = String(index).padStart(3, '0')
    return `create refs/heads/branch-${name} ${oid}\ncreate refs/tags/tag-${name} ${oid}\n`
  })
  git(['update-ref', '--stdin'], refs.join(''))
  assert.equal((await service.status(root)).kind, 'repository')
  const result = await service.browse(root)
  assert.equal(result.commits.length, 50)
  assert.equal(result.commits[0].subject, 'x'.repeat(512))
  assert.equal(result.commits[49].subject, 'Commit 2')
  assert.equal(result.branches.length, 100)
  assert.equal(result.tags.length, 100)
  assert.equal(result.truncated, true)
})

test('Git browser drops an incomplete byte-capped record and rechecks repository configuration on every read', async t => {
  const { root, service, git } = await fixture(t)
  git(['commit', '-q', '--allow-empty', '-F', '-'], '界'.repeat(50_000))
  assert.equal((await service.status(root)).kind, 'repository')
  const result = await service.browse(root)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.commits, [])
  assert.equal(result.branches[0].name, 'main')
  await assert.rejects(service.browse(join(root, 'other')), /Refresh/)
  git(['config', 'filter.fixture.clean', 'cat'])
  await assert.rejects(service.browse(root), /local Git filter/)
  git(['config', '--unset', 'filter.fixture.clean'])
  const read = service.browse(root)
  service.close()
  await assert.rejects(read, /abort/i)
  await assert.rejects(service.browse(root), /Refresh/)
})

test('Git browser exposes local remote names and only unambiguous anonymous HTTPS or canonical GitHub SSH identities', async t => {
  const { root, service, git } = await fixture(t)
  // Global SSH rewrites and credentials vary by machine. Run the real config command with only this fixture's settings.
  const processes = require('node:child_process') as typeof import('node:child_process')
  const spawn = processes.spawn
  t.mock.method(processes, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
    if (options.cwd === root && args.includes('--show-scope')) {
      options = { ...options, env: { ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }
    }
    return spawn(command, args, options)
  })
  const destinations = [
    ['origin', 'https://github.com/owner/ion-core.git'], ['ssh', 'git@github.com:example/another.git'],
    ['mirror', 'https://example.invalid/internal.git'], ['port', 'https://github.com:222/owner/name'],
    ['userinfo', 'https://user:private-fixture@github.com/owner/name'], ['query', 'https://github.com/owner/name?token=private-fixture'],
    ['fragment', 'https://github.com/owner/name#private-fixture'], ['encoded', 'https://github.com/owner%2fother/name'],
    ['local', '../saved-project'], ['ambiguous', 'https://github.com/owner/a'], ['ambiguous', 'https://github.com/owner/b'],
    ['rewrite', 'https://github.com/rewritten/name'], ['helper', 'https://github.com/owner/name'],
  ]
  await appendFile(join(root, '.git', 'config'), destinations.map(([name, value]) => `[remote "${name}"]\n\turl = "${value}"\n`).join('')
    + '[remote "origin"]\n\tpushurl = https://example.invalid/private-fixture\n'
    + '[remote "push-only"]\n\tpushurl = https://github.com/owner/push-only\n'
    + '[remote "helper"]\n\tvcs = fixture-helper\n'
    + '[url "https://example.invalid/private-fixture/"]\n\tinsteadOf = https://github.com/rewritten/\n'
    + '[url "https://github.com/example/"]\n\tinsteadOf = git@github.com:example/\n')
  assert.equal((await service.status(root)).kind, 'repository')
  const result = await service.browse(root)
  const expected = new Map<string, string | null>(destinations.map(([name]) => [name, null]))
  expected.set('origin', 'owner/ion-core'); expected.set('ssh', 'example/another'); expected.set('push-only', null)
  assert.deepEqual(result.remotes, [...expected.keys()].sort().map(name => ({ name, repository: expected.get(name) })))
  assert.equal(result.truncated, false)
  assert.doesNotMatch(JSON.stringify(result), /private-fixture|https?:|git@|example\.invalid/)

  // Git itself quotes invalid configuration values in stderr. Public browse errors must be fixed text.
  git(['config', 'log.showSignature', 'https://user:private-fixture@example.invalid/'])
  await assert.rejects(service.browse(root), { message: 'Git could not read the repository information.' })
})

test('remote review bounds identities and counts inherited or late duplicate URLs without exposing unrelated global remotes', () => {
  const entry = (scope: string, key: string, value: string) => `${scope}\0${key}\n${value}\0`
  const many = Array.from({ length: 105 }, (_, index) => entry('local', `remote.r${String(index).padStart(3, '0')}.url`, 'git@github.com:example/repo'))
  const config = entry('global', 'remote.global-only.url', 'https://github.com/other/global') + many.join('')
    + entry('global', 'remote.r000.url', 'https://github.com/another/project')
    + entry('local', 'remote.https://user:private-fixture@example.invalid/.url', 'https://github.com/hidden/name')
  const summary = reviewedRemotes(config)
  assert.equal(summary.truncated, true)
  assert.equal(summary.remotes.length, 100)
  assert.deepEqual(summary.remotes[0], { name: 'r000', repository: null })
  assert.deepEqual(summary.remotes[99], { name: 'r099', repository: 'example/repo' })
  assert.doesNotMatch(JSON.stringify(summary), /global-only|private-fixture|https?:/)
})
