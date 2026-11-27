import assert from 'node:assert/strict'
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { cloneAuthenticatedGitHub, cloneGitHub, clonePublicGitHub } from '../src/main/source-control/clone'
import type { execute } from '../src/main/runner'
import { fileMutations, type FileMutations } from '../src/main/file-mutations'
import { resolveGitHubCli } from '../src/main/source-control/github'

type Run = typeof execute
const success = (stdout = ''): Awaited<ReturnType<Run>> => ({ state: 'exited', exitCode: 0, stdout, output: '', outputComplete: true })
const fixtureToken = 'gho_cloneFixtureCredential0123456789'

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ion-clone-tests-')))
  const root = join(dir, 'workspace'), parent = join(dir, 'picked'), helper = join(dir, 'libexec'), git = await realpath(process.execPath)
  for (const path of [root, parent, helper]) await mkdir(path)
  await writeFile(join(helper, 'git-remote-https' + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o700 })
  const call = (run: Run, name: unknown = 'octocat/Hello-World', signal = new AbortController().signal, move?: FileMutations['move']) =>
    clonePublicGitHub(name, parent, root, [root], signal, { findGit: async () => ({ executable: git, paths: [] }),
      run: async (tool, args, options) => args[0] === '--exec-path' ? success(helper) : run(tool, args, options),
      ...(move ? { mutations: { move } } : {}) })
  const callAuthenticated = (run: Run, name: unknown = 'team/private', signal = new AbortController().signal) =>
    cloneAuthenticatedGitHub(name, parent, root, [root], signal, { findGit: async () => ({ executable: git, paths: [] }),
      findGh: async () => git,
      getToken: async (workspace, roots, scratch, authSignal) => {
        assert.equal(workspace, root); assert.deepEqual(roots, [root]); assert.ok(scratch.startsWith(await realpath(tmpdir())))
        assert.equal(authSignal, signal)
        return { tool: git, token: fixtureToken }
      },
      run: async (tool, args, options) => args[0] === '--exec-path' ? success(helper) : run(tool, args, options) })
  return { dir, root, parent, helper, git, call, callAuthenticated, clean: () => rm(dir, { recursive: true, force: true }) }
}

async function stage(args: string[]) {
  const checkout = args.at(-1)!
  await mkdir(join(checkout, '.git'), { recursive: true })
  await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return success()
}

test('public clone isolates configuration and publishes the reviewed checkout with a unique no-replace move', async t => {
  const f = await fixture(); t.after(f.clean)
  await mkdir(join(f.parent, 'other-repository'))
  await writeFile(join(f.parent, 'other-repository', 'sentinel'), 'existing')
  const keys = ['GIT_CONFIG_COUNT', 'GIT_DIR', 'GIT_SSH_COMMAND', 'GH_TOKEN', 'HTTP_PROXY', 'GIT_SSL_NO_VERIFY', 'GIT_ASKPASS']
  const saved = keys.map(k => process.env[k])
  keys.forEach(k => { process.env[k] = 'irrelevant-fixture' })
  t.after(() => keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] }))
  let scratch = ''
  const received = await f.call(async (git, args, options) => {
    assert.equal(git, f.git); assert.equal(options.input, '')
    scratch = dirname(options.cwd)
    assert.equal(options.environment.HOME, options.cwd)
    assert.equal(options.environment.GIT_ALLOW_PROTOCOL, 'https')
    assert.equal(options.environment.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(options.environment.GIT_TERMINAL_PROMPT, '0')
    assert.equal(options.environment.GIT_EXEC_PATH, f.helper)
    for (const key of keys) assert.equal(options.environment[key], undefined)
    for (const token of ['--single-branch', '--depth=1', '--no-recurse-submodules', '--no-local', 'credential.helper=', 'http.followRedirects=false',
      'protocol.allow=never', 'protocol.https.allow=always', 'submodule.recurse=false']) assert.ok(args.includes(token), token)
    assert.ok(args.includes('--template=' + options.environment.GIT_TEMPLATE_DIR))
    assert.equal(args.at(-3), '--')
    assert.equal(args.at(-2), 'https://github.com/octocat/Hello-World.git')
    assert.equal(args.some(arg => arg.includes(f.parent)), false)
    assert.ok(options.timeoutMs <= 120_000 && options.budget.remaining <= 65536)
    return stage(args)
  })
  assert.equal(received, join(f.parent, 'Hello-World'))
  assert.equal(await readFile(join(received, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n')
  assert.equal(await readFile(join(f.parent, 'other-repository', 'sentinel'), 'utf8'), 'existing')
  await assert.rejects(access(scratch), { code: 'ENOENT' })
})

test('public clone rejects unreviewed URLs, synthetic checkouts and tools inside another granted root', async t => {
  const f = await fixture(); t.after(f.clean)
  const unexpected: Run = async () => { throw Error('Unexpected execution') }
  for (const name of ['https://github.com/a/b', 'ssh://host/o/n', 'a/../b', 'x/b?token=z', 'x/repo\n']) {
    await assert.rejects(f.call(unexpected, name), /owner\/name/)
  }
  await assert.rejects(f.call(async () => success()), /ENOENT|checkout/)
  await assert.rejects(clonePublicGitHub('o/r', f.parent, f.root, [f.root, dirname(f.git)], new AbortController().signal,
    { findGit: async () => ({ executable: f.git, paths: [] }), run: unexpected }), /outside every open workspace/)
  assert.deepEqual(await readdir(f.parent), [])
  await mkdir(join(f.parent, 'Hello-World'))
  await writeFile(join(f.parent, 'Hello-World', 'keep'), 'unchanged')
  await assert.rejects(f.call(unexpected), /Choose another folder.*already exists/)
  assert.equal(await readFile(join(f.parent, 'Hello-World', 'keep'), 'utf8'), 'unchanged')
})

test('public clone refuses redirected picker parents and preserves competing destinations', async t => {
  const f = await fixture(); t.after(f.clean)
  const outside = join(f.dir, 'outside'), original = join(f.dir, 'original')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'untouched')
  await assert.rejects(f.call(async (_git, args) => {
    await rename(f.parent, original)
    await symlink(outside, f.parent, process.platform === 'win32' ? 'junction' : 'dir')
    return stage(args)
  }), /changed|symbolic link/)
  assert.deepEqual(await readdir(outside), ['keep'])
  await rm(f.parent); await rename(original, f.parent)
  await assert.rejects(f.call(async (_tool, args) => stage(args), 'o/r', new AbortController().signal, async (src, dest, from, to) => {
    await mkdir(dest)
    await writeFile(join(dest, 'competing'), 'important')
    await fileMutations().move(src, dest, from, to)
  }), /already exists/)
  const [preserved] = await readdir(f.parent)
  assert.equal(await readFile(join(f.parent, preserved, 'competing'), 'utf8'), 'important')
})

test('authenticated clone uses the signed-in GitHub CLI in an isolated environment and atomically publishes a credential-free remote', async t => {
  const f = await fixture(); t.after(f.clean)
  const keys = ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_DIR', 'GIT_SSH_COMMAND', 'GIT_ASKPASS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'GIT_SSL_NO_VERIFY', 'GIT_TRACE_CURL']
  const saved = keys.map(key => process.env[key])
  keys.forEach(key => { process.env[key] = 'untrusted-inherited-setting' })
  t.after(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] }))
  let scratch = '', checkoutPath = '', cloneArgs: string[] = []
  const destination = await f.callAuthenticated(async (gh, args, options) => {
    assert.equal(gh, f.git)
    assert.equal(options.input, '')
    cloneArgs = args
    scratch = dirname(options.cwd)
    assert.equal(options.environment.GH_HOST, 'github.com')
    assert.equal(options.environment.GH_PROMPT_DISABLED, '1')
    assert.equal(options.environment.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(options.environment.GIT_TERMINAL_PROMPT, '0')
    assert.equal(options.environment.GIT_ALLOW_PROTOCOL, 'https')
    assert.equal(options.environment.GIT_EXEC_PATH, f.helper)
    assert.equal(options.environment.GH_TOKEN, fixtureToken)
    assert.ok(options.environment.GH_CONFIG_DIR?.startsWith(scratch))
    assert.ok(options.environment.GIT_CONFIG_GLOBAL?.startsWith(scratch))
    assert.equal(await readFile(options.environment.GIT_CONFIG_GLOBAL!, 'utf8'), '')
    for (const key of keys) assert.equal(options.environment[key], key === 'GH_TOKEN' ? fixtureToken : undefined)
    assert.equal(args.includes(fixtureToken), false)
    for (const secret of ['untrusted-inherited-setting', 'token', 'password']) assert.equal(args.join(' ').includes(secret), false)
    for (const option of ['--no-upstream', 'https://github.com/team/private.git', '--depth=1', '--single-branch',
      '--no-tags', '--no-local', '--no-recurse-submodules', 'protocol.allow=never', 'protocol.https.allow=always',
      'http.followRedirects=false', 'http.sslVerify=true', 'submodule.recurse=false']) assert.ok(args.some(arg => arg.includes(option)), option)
    const checkout = args[4]!
    checkoutPath = checkout
    assert.ok(dirname(checkout).startsWith(join(scratch, 'Ion Clone ')))
    assert.equal(basename(checkout), 'private')
    assert.ok(options.timeoutMs <= 120_000 && options.budget.remaining <= 65536)
    await mkdir(join(checkout, '.git'), { recursive: true })
    await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(checkout, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/team/private.git\n')
    return success()
  })
  assert.equal(destination, join(f.parent, 'private'))
  assert.deepEqual(cloneArgs.slice(0, 5), ['repo', 'clone', '--no-upstream', 'https://github.com/team/private.git',
    checkoutPath])
  assert.equal(await readFile(join(destination, '.git', 'config'), 'utf8'), '[remote "origin"]\n\turl = https://github.com/team/private.git\n')
  await assert.rejects(access(scratch), { code: 'ENOENT' })
})

test('authenticated clone rejects embedded credentials and never returns CLI diagnostics', async t => {
  const f = await fixture(); t.after(f.clean)
  const pending = f.callAuthenticated(async (_gh, args) => {
    const checkout = args[4]!
    await mkdir(join(checkout, '.git'), { recursive: true })
    await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(checkout, '.git', 'config'), '[remote "origin"]\n\turl = https://x-access-token:do-not-leak@github.com/team/private.git\n')
    return success()
  })
  await assert.rejects(pending, /remote did not match/)
  assert.deepEqual(await readdir(f.parent), [])

  await assert.rejects(f.callAuthenticated(async (_gh, args) => {
    const checkout = args[4]!
    await mkdir(join(checkout, '.git'), { recursive: true })
    await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(checkout, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/team/private.git\n'
      + '[credential "https://github.com"]\n\thelper = !echo do-not-persist\n')
    return success()
  }), /remote did not match/)
  assert.deepEqual(await readdir(f.parent), [])

  await assert.rejects(f.callAuthenticated(async () => ({ ...success(), exitCode: 128,
    stderr: 'fatal: https://x-access-token:do-not-leak@github.com/team/private.git denied' })), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Authenticated clone failed/)
      assert.equal(error.message.includes('do-not-leak'), false)
      return true
    })
  assert.deepEqual(await readdir(f.parent), [])

  const workspaceGh = join(f.root, 'gh')
  await writeFile(workspaceGh, '', { mode: 0o700 })
  await assert.rejects(cloneAuthenticatedGitHub('team/private', f.parent, f.root, [f.root], new AbortController().signal, {
    findGit: async () => ({ executable: f.git, paths: [] }), findGh: async () => workspaceGh,
    run: async () => { throw new Error('The workspace GitHub CLI must not execute.') },
  }), /outside every open workspace/)
  await assert.rejects(cloneGitHub('team/private', 'unexpected' as never, f.parent, f.root, [f.root], new AbortController().signal),
    /public or authenticated/)
  assert.deepEqual(await readdir(f.parent), [])
})

test('authenticated clone cancellation waits for the GitHub CLI to drain before removing staging', async t => {
  const f = await fixture(); t.after(f.clean)
  const controller = new AbortController()
  let started!: () => void, finish!: () => void, scratch = ''
  const pending = new Promise<void>(resolve => { started = resolve }), drained = new Promise<void>(resolve => { finish = resolve })
  const request = f.callAuthenticated(async (_gh, args, options) => {
    const checkout = args[4]!
    await mkdir(join(checkout, '.git'), { recursive: true })
    await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(checkout, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/team/private.git\n')
    scratch = dirname(options.cwd)
    started()
    await drained
    assert.equal(options.signal.aborted, true)
    return { ...success(), state: 'cancelled' }
  }, 'team/private', controller.signal)
  await pending
  controller.abort()
  await access(scratch)
  finish()
  await assert.rejects(request, { name: 'AbortError' })
  await assert.rejects(access(scratch), { code: 'ENOENT' })
  assert.deepEqual(await readdir(f.parent), [])
})

test('clone aborts an oversized incoming pack before publishing the repository', async t => {
  const f = await fixture(); t.after(f.clean)
  const pending = f.callAuthenticated(async (_gh, args, options) => {
    const checkout = args[4]!
    const packDirectory = join(checkout, '.git', 'objects', 'pack')
    await mkdir(packDirectory, { recursive: true })
    const pack = await open(join(packDirectory, 'pack-large.pack'), 'w')
    try { await pack.truncate(256 * 1024 * 1024 + 1) } finally { await pack.close() }
    if (!options.signal.aborted) await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
    return { ...success(), state: 'cancelled' }
  })
  await assert.rejects(pending, /256 MiB limit; the clone was canceled before publication/)
  assert.deepEqual(await readdir(f.parent), [])
})

test('native clone publication rejects a parent replaced after its last JavaScript check', async t => {
  const f = await fixture(); t.after(f.clean)
  const outside = join(f.dir, 'outside')
  await mkdir(outside)
  await assert.rejects(f.call(async (_tool, args) => stage(args), 'o/r', new AbortController().signal, async (src, dest, from, to) => {
    await rename(f.parent, join(f.dir, 'original'))
    await symlink(outside, f.parent, process.platform === 'win32' ? 'junction' : 'dir')
    await fileMutations().move(src, dest, from, to)
  }))
  assert.deepEqual(await readdir(outside), [])
  assert.deepEqual(await readdir(join(f.dir, 'original')), [])
})

test('failed clone retains foreign content when its private checkout directory is replaced', async t => {
  const f = await fixture(); t.after(f.clean)
  let scratch = '', checkout = ''
  await assert.rejects(f.call(async (_tool, args, options) => {
    scratch = dirname(options.cwd); checkout = args.at(-1)!
    await rename(checkout, join(f.dir, 'original-checkout'))
    await mkdir(checkout)
    await writeFile(join(checkout, 'foreign'), 'keep')
    return { ...success(), exitCode: 1 }
  }), /Could not verify or remove/)
  assert.equal(await readFile(join(checkout, 'foreign'), 'utf8'), 'keep')
  await rm(scratch, { recursive: true, force: true })
})

test('public clone awaits cancellation, cleans verified staging and retains unverified cleanup evidence', async t => {
  const f = await fixture(); t.after(f.clean)
  const controller = new AbortController()
  let started!: () => void, finish!: () => void, scratch = ''
  const pending = new Promise<void>(resolve => { started = resolve }), drained = new Promise<void>(resolve => { finish = resolve })
  const request = f.call(async (_tool, args, options) => {
    await stage(args); scratch = dirname(options.cwd); started(); await drained
    assert.equal(options.signal.aborted, true)
    return { ...success(), state: 'cancelled' }
  }, 'o/r', controller.signal)
  await pending
  controller.abort()
  await access(scratch); finish()
  await assert.rejects(request, { name: 'AbortError' })
  await assert.rejects(access(scratch), { code: 'ENOENT' })
  assert.deepEqual(await readdir(f.parent), [])
  await assert.rejects(f.call(async (_tool, _args, options) => {
    scratch = dirname(options.cwd); return { ...success(), outputComplete: false }
  }), /Private staging retained/)
  assert.ok((await lstat(scratch)).isDirectory())
  await rm(scratch, { recursive: true })
})

test('live authenticated clone of the public Ion repository with the official GitHub keyring',
  { skip: process.env.ION_TEST_GITHUB_AUTH_CLONE_LIVE !== '1' && process.env.ION_TEST_GITHUB_CLONE_LIVE !== '1', timeout: 150_000 }, async t => {
    const f = await fixture(); t.after(f.clean)
    const signal = new AbortController().signal
    const gh = await resolveGitHubCli(f.root, [f.root], signal)
    const destination = await cloneAuthenticatedGitHub('Vaddi-Srisanth/Ion_IDE', f.parent, f.root, [f.root], signal, {
      findGh: async () => gh,
    })
    assert.equal(destination, join(f.parent, 'Ion_IDE'))
    const config = await readFile(join(destination, '.git', 'config'), 'utf8')
    assert.match(config, /url = https:\/\/github\.com\/Vaddi-Srisanth\/Ion_IDE\.git/)
    assert.doesNotMatch(config, /(?:extraheader|credential\s*=|token\s*=|password\s*=|x-access-token:)/i)
    assert.ok((await readdir(destination)).includes('package.json'))
  })

test('anonymous public GitHub shallow clone of octocat/Hello-World', {
  skip: process.env.ION_TEST_GITHUB_PUBLIC_CLONE_LIVE !== '1' && process.env.ION_TEST_GITHUB_CLONE_LIVE !== '1', timeout: 140_000,
}, async t => {
  const f = await fixture(); t.after(f.clean)
  const checkout = await clonePublicGitHub('octocat/Hello-World', f.parent, f.root, [f.root], new AbortController().signal)
  assert.ok((await readFile(join(checkout, '.git', 'shallow'), 'utf8')).trim())
  assert.match(await readFile(join(checkout, '.git', 'config'), 'utf8'), /https:\/\/github\.com\/octocat\/Hello-World.git/)
  assert.match(await readFile(join(checkout, 'README'), 'utf8'), /Hello World/i)
})
