import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileMutations } from '../src/main/file-mutations'
import { execute } from '../src/main/runner'
import { SourceControlService } from '../src/main/source-control'
import type { RemoteFetchDependencies } from '../src/main/source-control/remote-fetch'
import { resolveGit } from '../src/main/source-control/repository'

const repositorySlug = 'ion-fixture/source-control-test'

async function fixture(t: TestContext, service?: SourceControlService, auth: RemoteFetchDependencies = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-fetch-git-')))
  const remote = join(root, 'public.git')
  const publisher = join(root, 'publisher')
  const serviceRoot = join(root, 'workspace')
  await mkdir(serviceRoot)
  const tool = await resolveGit(serviceRoot, new AbortController().signal)
  assert.ok(tool)
  const git = (cwd: string, ...args: string[]) => execFileSync(tool.executable,
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
      cwd, windowsHide: true, encoding: 'utf8', timeout: 8000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    }).trim()
  git(serviceRoot, 'init', '-q', '-b', 'main'); git(serviceRoot, 'config', 'user.name', 'Ion fixture')
  git(serviceRoot, 'config', 'user.email', 'fixture@ion.invalid')
  await writeFile(join(serviceRoot, 'source.txt'), 'base\n')
  git(serviceRoot, 'add', '--', 'source.txt'); git(serviceRoot, 'commit', '-qm', 'Base')
  const base = git(serviceRoot, 'rev-parse', 'HEAD')
  git(root, 'clone', '--bare', serviceRoot, remote)
  git(root, 'clone', remote, publisher); git(publisher, 'config', 'user.name', 'Ion publisher')
  git(publisher, 'config', 'user.email', 'publisher@ion.invalid')
  git(serviceRoot, 'remote', 'add', 'origin', 'https://github.com/' + repositorySlug + '.git')
  git(serviceRoot, 'update-ref', 'refs/remotes/origin/main', base)
  const helper = git(serviceRoot, '--exec-path')
  let fetches = 0
  let oversizedFetch = false
  let afterFetch: (() => void) | undefined
  const fakeNetwork: typeof execute = async (binary, args, options) => {
    if (args.length === 1 && args[0] === '--exec-path') {
      return { state: 'exited', exitCode: 0, output: helper + '\n', stdout: helper + '\n', stderr: '', outputComplete: true }
    }
    const urlIndex = args.indexOf('https://github.com/' + repositorySlug + '.git')
    if (urlIndex >= 0) {
      fetches++
      assert.equal(options.environment.GIT_ALLOW_PROTOCOL, 'https')
      assert.equal(options.environment.GIT_TERMINAL_PROMPT, '0')
      assert.equal(options.environment.GIT_CONFIG_NOSYSTEM, '1')
      assert.equal(options.environment.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null')
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'HTTP_PROXY', 'HTTPS_PROXY']) {
        assert.equal(options.environment[name], undefined)
      }
      if (options.environment.GIT_CONFIG_COUNT === '2') {
        assert.equal(options.environment.GIT_CONFIG_KEY_0, 'http.extraHeader')
        assert.equal(options.environment.GIT_CONFIG_VALUE_0, '')
        assert.equal(options.environment.GIT_CONFIG_KEY_1, 'http.extraHeader')
        assert.equal(Buffer.from(options.environment.GIT_CONFIG_VALUE_1!.replace('Authorization: basic ', ''), 'base64').toString(),
          'x-access-token:fixture-github-token-0123456789')
        assert.equal(args.some(value => value.includes('fixture-github-token')), false)
      } else assert.equal(options.environment.GIT_CONFIG_COUNT, undefined)
      assert.ok(args.includes('--depth=256'))
      assert.ok(args.includes('fetch.fsckObjects=true'))
      assert.ok(args.includes('transfer.fsckObjects=true'))
      if (oversizedFetch) {
        const repository = args.find(value => value.startsWith('--git-dir='))?.slice('--git-dir='.length)
        assert.ok(repository)
        const pack = join(repository, 'objects', 'pack', 'tmp_pack_oversized')
        await writeFile(pack, '')
        await truncate(pack, 256 * 1024 * 1024 + 1)
        afterFetch?.()
        return { state: 'exited', exitCode: 0, output: '', stdout: '', stderr: '', outputComplete: true }
      }
      const rewritten = [...args]
      rewritten[urlIndex] = remote
      // Test the real Git fetch and pack publication without contacting GitHub.
      const result = await execute(binary, rewritten, { ...options, environment: { ...options.environment, GIT_ALLOW_PROTOCOL: 'file' } })
      afterFetch?.()
      return result
    }
    return execute(binary, args, options)
  }
  const actualService = service ?? new SourceControlService(undefined, { run: fakeNetwork, ...auth })
  t.after(async () => { actualService.close(); await actualService.drain(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { root, serviceRoot, remote, publisher, base, git, service: actualService,
    fetchCount: () => fetches, afterFetch: (operation: () => void) => { afterFetch = operation },
    makeOversizedFetch: () => { oversizedFetch = true } }
}

async function publish(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  await writeFile(join(f.publisher, 'source.txt'), text)
  f.git(f.publisher, 'add', '--', 'source.txt'); f.git(f.publisher, 'commit', '-qm', 'Remote update')
  f.git(f.publisher, 'push', 'origin', 'main')
  return f.git(f.publisher, 'rev-parse', 'HEAD')
}

test('public GitHub fetch publishes a verified fast-forward pack and leaves the user index and files alone', async t => {
  const f = await fixture(t)
  const next = await publish(f, 'remote update\n')
  const source = join(f.serviceRoot, 'source.txt')
  await writeFile(source, 'staged user change\n'); f.git(f.serviceRoot, 'add', '--', 'source.txt')
  await writeFile(source, 'unstaged user change\n')
  await writeFile(join(f.serviceRoot, 'untracked.txt'), 'untracked user file\n')
  const index = await readFile(join(f.serviceRoot, '.git', 'index'))
  assert.equal((await f.service.status(f.serviceRoot)).kind, 'repository')
  const browse = await f.service.browse(f.serviceRoot)
  assert.deepEqual(browse.cachedRemoteBranches, [{ name: 'origin/main', oid: f.base }])
  const selection = { repository: repositorySlug, remote: 'origin', branch: 'main', previous: f.base, access: 'public' as const }
  assert.equal(await f.service.fetchGitHub(f.serviceRoot, selection, [f.serviceRoot], fileMutations(), async () => false), null)
  assert.equal(f.fetchCount(), 0)
  assert.equal(f.git(f.serviceRoot, 'rev-parse', 'refs/remotes/origin/main'), f.base)
  const result = await f.service.fetchGitHub(f.serviceRoot, selection, [f.serviceRoot], fileMutations(), async review => {
    assert.deepEqual(review, { ...selection })
    return true
  })
  assert.deepEqual(result, { oid: next, changed: true })
  assert.equal(f.fetchCount(), 1)
  assert.equal(f.git(f.serviceRoot, 'rev-parse', 'refs/remotes/origin/main'), next)
  assert.deepEqual(await readFile(join(f.serviceRoot, '.git', 'index')), index)
  assert.equal(await readFile(source, 'utf8'), 'unstaged user change\n')
  assert.equal(await readFile(join(f.serviceRoot, 'untracked.txt'), 'utf8'), 'untracked user file\n')
  assert.equal((await f.service.status(f.serviceRoot)).kind, 'repository')
})

test('authenticated GitHub fetch keeps the official credential in child environment and leaves worktree data alone', async t => {
  let approved = false, credentialRequested = false
  const f = await fixture(t, undefined, { getToken: async (_root, _roots, _scratch, signal) => {
    assert.equal(approved, true, 'Credential retrieval waits for explicit approval.')
    assert.equal(signal.aborted, false)
    credentialRequested = true
    return { tool: process.execPath, token: 'fixture-github-token-0123456789' }
  } })
  const next = await publish(f, 'private remote update\n')
  const source = join(f.serviceRoot, 'source.txt')
  await writeFile(source, 'local working copy\n')
  const index = await readFile(join(f.serviceRoot, '.git', 'index'))
  await f.service.status(f.serviceRoot); await f.service.browse(f.serviceRoot)
  const selection = { repository: repositorySlug, remote: 'origin', branch: 'main', previous: f.base, access: 'authenticated' as const }
  const result = await f.service.fetchGitHub(f.serviceRoot, selection, [f.serviceRoot], fileMutations(), async review => {
    assert.deepEqual(review, selection)
    approved = true
    return true
  })
  assert.equal(credentialRequested, true)
  assert.deepEqual(result, { oid: next, changed: true })
  assert.equal(f.git(f.serviceRoot, 'rev-parse', 'refs/remotes/origin/main'), next)
  assert.deepEqual(await readFile(join(f.serviceRoot, '.git', 'index')), index)
  assert.equal(await readFile(source, 'utf8'), 'local working copy\n')
  assert.equal((await f.service.status(f.serviceRoot)).kind, 'repository')
})

test('public GitHub fetch refuses force-pushes, changed refs and unreviewed remotes without publishing', async t => {
  const f = await fixture(t)
  const next = await publish(f, 'remote first update\n')
  await f.service.status(f.serviceRoot); await f.service.browse(f.serviceRoot)
  const initial = { repository: repositorySlug, remote: 'origin', branch: 'main', previous: f.base, access: 'public' as const }
  assert.deepEqual(await f.service.fetchGitHub(f.serviceRoot, initial, [f.serviceRoot], fileMutations(), async () => true),
    { oid: next, changed: true })
  await f.service.status(f.serviceRoot); await f.service.browse(f.serviceRoot)
  const selection = { ...initial, previous: next }
  const before = f.git(f.serviceRoot, 'rev-parse', 'refs/remotes/origin/main')
  f.git(f.publisher, 'reset', '--hard', 'HEAD~1')
  await writeFile(join(f.publisher, 'source.txt'), 'force-pushed replacement\n')
  f.git(f.publisher, 'add', '--', 'source.txt'); f.git(f.publisher, 'commit', '-qm', 'Replacement')
  f.git(f.publisher, 'push', '--force', 'origin', 'main')
  await assert.rejects(f.service.fetchGitHub(f.serviceRoot, selection, [f.serviceRoot], fileMutations(), async () => true), /not a fast-forward/)
  assert.equal(f.git(f.serviceRoot, 'rev-parse', 'refs/remotes/origin/main'), before)

  await f.service.status(f.serviceRoot); await f.service.browse(f.serviceRoot)
  const bad = { ...selection, repository: 'outside/repository' }
  assert.throws(() => f.service.fetchGitHub(f.serviceRoot, bad, [f.serviceRoot], fileMutations(), async () => true), /Refresh the repository browser/)
  assert.equal(f.fetchCount(), 2)
  assert.equal(next, before)
})

test('public fetch rechecks the reviewed cached ref after network I/O and publishes no packs on a race', async t => {
  const f = await fixture(t)
  await publish(f, 'remote update\n')
  await f.service.status(f.serviceRoot); await f.service.browse(f.serviceRoot)
  f.afterFetch(() => f.git(f.serviceRoot, 'update-ref', '-d', 'refs/remotes/origin/main'))
  const selection = { repository: repositorySlug, remote: 'origin', branch: 'main', previous: f.base, access: 'public' as const }
  await assert.rejects(f.service.fetchGitHub(f.serviceRoot, selection, [f.serviceRoot], fileMutations(), async () => true), /cached branch or remote changed/)
  assert.equal(f.fetchCount(), 1)
  assert.equal(f.git(f.serviceRoot, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin'), '')
  assert.deepEqual(await (await import('node:fs/promises')).readdir(join(f.serviceRoot, '.git', 'objects', 'pack')), [])
})

test('public fetch cancels an oversized incoming pack before it reaches the repository', async t => {
  const f = await fixture(t)
  await publish(f, 'remote update\n')
  await f.service.status(f.serviceRoot); await f.service.browse(f.serviceRoot)
  f.makeOversizedFetch()
  const selection = { repository: repositorySlug, remote: 'origin', branch: 'main', previous: f.base, access: 'public' as const }
  await assert.rejects(f.service.fetchGitHub(f.serviceRoot, selection, [f.serviceRoot], fileMutations(), async () => true), /exceeded Ion’s 256 MiB limit/)
  assert.equal(f.fetchCount(), 1)
  assert.equal(f.git(f.serviceRoot, 'rev-parse', 'refs/remotes/origin/main'), f.base)
  assert.deepEqual(await (await import('node:fs/promises')).readdir(join(f.serviceRoot, '.git', 'objects', 'pack')), [])
})
