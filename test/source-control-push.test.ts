import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { SourceControlService } from '../src/main/source-control'
import type { RemoteFetchDependencies } from '../src/main/source-control/remote-fetch'
import { execute } from '../src/main/runner'
import { resolveGit } from '../src/main/source-control/repository'

const slug = 'ion-fixture/source-control-push'
const token = 'fixture-github-token-0123456789'

async function fixture(t: TestContext, service?: SourceControlService) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-push-git-')))
  const serviceRoot = join(root, 'workspace'), remote = join(root, 'remote.git'), publisher = join(root, 'publisher')
  await mkdir(serviceRoot)
  const tool = await resolveGit(serviceRoot, new AbortController().signal)
  assert.ok(tool)
  const git = (cwd: string, ...args: string[]) => execFileSync(tool.executable,
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, windowsHide: true, encoding: 'utf8', timeout: 8000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim()
  git(serviceRoot, 'init', '-q', '-b', 'main'); git(serviceRoot, 'config', 'user.name', 'Ion fixture')
  git(serviceRoot, 'config', 'user.email', 'fixture@ion.invalid')
  await writeFile(join(serviceRoot, 'source.txt'), 'base\n')
  git(serviceRoot, 'add', '--', 'source.txt'); git(serviceRoot, 'commit', '-qm', 'Base')
  const base = git(serviceRoot, 'rev-parse', 'HEAD')
  git(root, 'clone', '--bare', serviceRoot, remote)
  git(root, 'clone', remote, publisher)
  git(publisher, 'config', 'user.name', 'Publisher'); git(publisher, 'config', 'user.email', 'publisher@ion.invalid')
  git(serviceRoot, 'remote', 'add', 'origin', 'https://github.com/' + slug + '.git')
  git(serviceRoot, 'update-ref', 'refs/remotes/origin/main', base)
  await writeFile(join(serviceRoot, 'local.txt'), 'local commit\n')
  git(serviceRoot, 'add', '--', 'local.txt'); git(serviceRoot, 'commit', '-qm', 'Local commit')
  const head = git(serviceRoot, 'rev-parse', 'HEAD')
  let networkCalls = 0, tokenCalls = 0
  const run: typeof execute = async (binary, args, options) => {
    const endpoint = 'https://github.com/' + slug + '.git'
    if (!args.includes(endpoint)) return execute(binary, args, options)
    networkCalls++
    assert.equal(options.environment.GIT_ALLOW_PROTOCOL, 'https')
    assert.equal(options.environment.GIT_TERMINAL_PROMPT, '0')
    assert.equal(options.environment.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(options.environment.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null')
    assert.equal(options.environment.GIT_CONFIG_COUNT, '2')
    assert.equal(options.environment.GIT_CONFIG_KEY_0, 'http.extraHeader')
    assert.equal(options.environment.GIT_CONFIG_VALUE_0, '')
    assert.equal(options.environment.GIT_CONFIG_KEY_1, 'http.extraHeader')
    assert.equal(Buffer.from(options.environment.GIT_CONFIG_VALUE_1!.replace('Authorization: basic ', ''), 'base64').toString(),
      'x-access-token:' + token)
    assert.equal(args.some(value => value.includes(token)), false)
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'HTTPS_PROXY', 'HTTP_PROXY']) {
      assert.equal(options.environment[key], undefined)
    }
    if (args.includes('push')) {
      assert.ok(args.includes('--no-verify'))
      assert.ok(args.includes('--no-follow-tags'))
      assert.ok(args.includes('--no-recurse-submodules'))
      assert.ok(args.some(value => value.startsWith('--force-with-lease=refs/heads/main:' + base)))
      assert.equal(args.some(value => value === '--force' || value === '-f'), false)
    }
    const rewritten = [...args]
    const urlIndex = rewritten.indexOf(endpoint)
    rewritten[urlIndex] = remote
    const commandIndex = rewritten.findIndex(value => value === 'push' || value === 'ls-remote')
    rewritten.splice(commandIndex, 0, '-c', 'protocol.file.allow=always')
    const result = await execute(binary, rewritten, { ...options, environment: { ...options.environment, GIT_ALLOW_PROTOCOL: 'file' } })
    if (args.includes('push') && result.state === 'exited' && result.exitCode === 0) {
      return { ...result, stdout: (result.stdout ?? '').replace('To ' + remote, 'To ' + endpoint) }
    }
    return result
  }
  const dependencies: RemoteFetchDependencies = {
    run, getToken: async () => { tokenCalls++; return { tool: '/fake/gh', token } },
  }
  const actualService = service ?? new SourceControlService(undefined, dependencies)
  t.after(async () => { actualService.close(); await actualService.drain(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { root, serviceRoot, remote, publisher, base, head, git, service: actualService,
    networkCalls: () => networkCalls, tokenCalls: () => tokenCalls }
}

async function review(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await f.service.status(f.serviceRoot)).kind, 'repository')
  await f.service.browse(f.serviceRoot)
  return { repository: slug, remote: 'origin', branch: 'main', previous: f.base, head: f.head, dirtyPaths: [] }
}

test('reviewed GitHub push uses a scoped credential, pins one commit, and updates only the reviewed cached ref', async t => {
  const f = await fixture(t)
  const request = await review(f)
  assert.equal(await f.service.pushGitHub(f.serviceRoot, request, [f.serviceRoot], async () => false), null)
  assert.equal(f.networkCalls(), 0)
  assert.equal(f.tokenCalls(), 0)
  await f.service.status(f.serviceRoot); await f.service.browse(f.serviceRoot)
  const source = join(f.serviceRoot, 'source.txt')
  const before = await readFile(source)
  const result = await f.service.pushGitHub(f.serviceRoot, request, [f.serviceRoot], async plan => {
    assert.deepEqual(plan, { repository: slug, remote: 'origin', branch: 'main', previous: f.base, head: f.head,
      commits: 1, objects: plan.objects, bytes: plan.bytes })
    assert.ok(plan.objects > 0 && plan.bytes > 0 && plan.bytes <= 256 * 1024 * 1024)
    return true
  })
  assert.deepEqual(result, { head: f.head, cachedRefUpdated: true })
  assert.equal(f.networkCalls(), 2, 'push and post-push remote verification are the only network Git requests')
  assert.equal(f.tokenCalls(), 1)
  assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/main'), f.head)
  assert.equal(f.git(f.serviceRoot, 'rev-parse', 'refs/remotes/origin/main'), f.head)
  assert.deepEqual(await readFile(source), before)
  assert.equal(f.git(f.serviceRoot, 'status', '--porcelain'), '')
})

test('reviewed push fails safely when GitHub moves the branch after approval', async t => {
  const f = await fixture(t)
  const request = await review(f)
  await assert.rejects(f.service.pushGitHub(f.serviceRoot, request, [f.serviceRoot], async () => {
    await writeFile(join(f.publisher, 'remote.txt'), 'independent remote commit\n')
    f.git(f.publisher, 'add', '--', 'remote.txt'); f.git(f.publisher, 'commit', '-qm', 'Remote advance')
    f.git(f.publisher, 'push', 'origin', 'main')
    return true
  }), /did not accept the reviewed push/)
  assert.notEqual(f.git(f.remote, 'rev-parse', 'refs/heads/main'), f.head)
  assert.equal(f.git(f.serviceRoot, 'rev-parse', 'refs/remotes/origin/main'), f.base)
})
