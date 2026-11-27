import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { githubOverview } from '../src/main/source-control/github'
import type { execute } from '../src/main/runner'

type Run = typeof execute
const fixtureRepository = 'ion-fixture/sample.repo'
const ok = (value: unknown): Awaited<ReturnType<Run>> => ({ state: 'exited', exitCode: 0, output: '',
  stdout: JSON.stringify(value), stderr: '', outputComplete: true })
const pull = { number: 7, title: 'Review the files', url: 'https://github.com/' + fixtureRepository + '/pull/7', state: 'open' }

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-gh-test-')))
  const root = join(directory, 'working tree')
  await mkdir(root)
  const binary = await realpath(process.execPath)
  const call = (run: Run, name: unknown = fixtureRepository, signal = new AbortController().signal) =>
    githubOverview(root, [root], name, signal, { run, findGh: async () => binary })
  return { directory, root, binary, call, clean: () => rm(directory, { recursive: true, force: true }) }
}

test('GitHub reads only the selected repository via fixed GitHub.com GETs in one private directory', async t => {
  const f = await fixture(); t.after(f.clean)
  const keys = ['GH_TOKEN', 'GH_CONFIG_DIR', 'GH_DEBUG', 'GIT_SSH_COMMAND', 'HTTPS_PROXY', 'GITHUB_TOKEN']
  const saved = keys.map(key => process.env[key])
  keys.forEach(key => { process.env[key] = 'injected-setting' })
  t.after(() => keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] }))
  let scratch = ''
  const endpoints: string[] = []
  const overview = await f.call(async (binary, args, options) => {
    assert.equal(binary, f.binary)
    assert.deepEqual(args.slice(0, 6), ['api', '--hostname', 'github.com', '--method', 'GET', '--jq'])
    const endpoint = args.at(-1)!
    endpoints.push(endpoint)
    assert.ok(options.timeoutMs <= 15_000)
    assert.equal(options.input, '')
    assert.equal(options.budget.remaining, 64 * 1024)
    scratch ||= options.cwd
    assert.equal(options.cwd, scratch)
    assert.notEqual(options.cwd, f.root)
    for (const key of keys) assert.equal(options.environment[key], key === 'GH_CONFIG_DIR' ? scratch : undefined)
    const env = options.environment
    assert.equal(env.GH_TELEMETRY, '0')
    assert.equal(env.GH_PROMPT_DISABLED, '1')
    assert.equal(env.GH_NO_UPDATE_NOTIFIER, '1')
    assert.equal(env.GH_HOST, 'github.com')
    if (endpoint === 'user') return ok({ login: 'octo-user' })
    if (endpoint.startsWith('repos/')) return ok([pull])
    return ok({ incomplete: false, items: [{ number: 4, title: 'Issue\nwith controls', state: 'open', url: 'https://github.com/' + fixtureRepository + '/issues/4' }] })
  })
  assert.deepEqual(endpoints, ['user', 'repos/ion-fixture/sample.repo/pulls?state=open&sort=updated&direction=desc&per_page=20',
    'search/issues?q=repo%3Aion-fixture%2Fsample.repo%20is%3Aissue%20is%3Aopen&sort=updated&order=desc&per_page=20'])
  assert.deepEqual(overview, { repository: fixtureRepository, login: 'octo-user',
    pullRequests: [{ number: 7, title: pull.title, url: pull.url }],
    issues: [{ number: 4, title: 'Issue with controls', url: 'https://github.com/' + fixtureRepository + '/issues/4' }] })
  await assert.rejects(access(scratch), { code: 'ENOENT' })
})

test('GitHub rejects URLs, extra components, control text and unknown roots before resolving a tool', async t => {
  const f = await fixture(); t.after(f.clean)
  const findGh = async () => { throw new Error('Unexpected CLI resolution') }
  for (const input of [null, 'owner/', 'owner/..', '/x', 'a/b/c', 'x@y/repo', 'owner/repo?x=1', 'https://me:secret@github.com/a/b',
    'a/$(id)', 'a/b\nc', '--hostname/repo', ['owner', 'name']]) {
    await assert.rejects(githubOverview(f.root, [f.root], input, new AbortController().signal, { findGh }), /owner\/name/)
  }
  await assert.rejects(githubOverview(f.root, [], fixtureRepository, new AbortController().signal, { findGh }), /open workspace/)
  const otherRootTool = join(f.directory, 'unsafe')
  await writeFile(otherRootTool, 'fixture', { mode: 0o700 })
  await assert.rejects(githubOverview(f.root, [f.root, f.directory], fixtureRepository, new AbortController().signal,
    { findGh: async () => otherRootTool, run: async () => { throw Error('Ran workspace tool') } }), /CLI changed/)
})

test('GitHub reports fixed sign-in, network, rate-limit and completeness errors without echoing CLI diagnostics', async t => {
  const f = await fixture(); t.after(f.clean)
  for (const [stderr, code, expected] of [
    ['secret-test diagnostic: gh auth login', 4, /Sign in/], ['secret-test HTTP 401', 1, /Sign in/],
    ['secret-test HTTP 404', 1, /unavailable/], ['secret-test HTTP 429', 1, /rate-limited/], ['secret-test diagnostic', 1, /read failed/],
  ] as const) {
    let calls = 0
    await assert.rejects(f.call(async () => { calls++; return { ...ok({}), exitCode: code, stderr } }),
      error => error instanceof Error && expected.test(error.message) && !error.message.includes('secret-test'))
    assert.equal(calls, 1)
  }
  for (const result of [{ ...ok({}), outputComplete: false }, { ...ok({}), state: 'output-limit' as const },
    { ...ok({}), stdout: 'x'.repeat(65537) }]) {
    await assert.rejects(f.call(async () => result), /limit/)
  }
  await assert.rejects(f.call(async () => ({ ...ok({}), state: 'timeout' })), /timed out/)
})

test('GitHub validates repository and type of every result and rejects truncated searches', async t => {
  const f = await fixture(); t.after(f.clean)
  for (const [items, expected] of [
    [[{ ...pull, url: 'https://outside.invalid/a/b/pull/7' }], /outside/],
    [[{ ...pull, url: 'https://github.com/other/repo/pull/7' }], /outside/],
    [[{ ...pull, url: 'https://github.com/' + fixtureRepository + '/issues/7' }], /outside/],
    [[{ ...pull, state: 'closed' }], /invalid/], [[pull, pull], /invalid/],
    [Array.from({ length: 21 }, () => pull), /number of items/],
  ] as const) {
    await assert.rejects(f.call(async (_tool, args) => args.at(-1) === 'user' ? ok({ login: 'octo-user' }) : ok(items)), expected)
  }
  await assert.rejects(f.call(async (_tool, args) => args.at(-1) === 'user' ? ok({ login: 'octo-user' })
    : args.at(-1)?.startsWith('repos/') ? ok([]) : ok({ incomplete: true, items: [] })), /incomplete/)
})

test('GitHub cancellation drains the active GET and removes its private directory', async t => {
  const f = await fixture(); t.after(f.clean)
  const cancel = new AbortController()
  let start!: () => void, finish!: () => void, scratch = ''
  const started = new Promise<void>(yes => { start = yes })
  const wait = new Promise<void>(yes => { finish = yes })
  let calls = 0
  const result = f.call(async (_binary, _args, options) => {
    calls++; scratch = options.cwd; assert.equal(options.signal, cancel.signal); start()
    await wait
    return { ...ok({}), state: 'cancelled' }
  }, fixtureRepository, cancel.signal)
  await started
  cancel.abort()
  await access(scratch)
  finish()
  await assert.rejects(result, { name: 'AbortError' })
  await assert.rejects(access(scratch), { code: 'ENOENT' })
  assert.equal(calls, 1)
  await assert.rejects(f.call(async () => { throw Error('Unexpected CLI launch') }, fixtureRepository, cancel.signal), { name: 'AbortError' })
})

test('live authenticated GitHub read for the official Ion repository', { skip: process.env.ION_TEST_GITHUB_LIVE !== '1', timeout: 50_000 }, async t => {
  const f = await fixture(); t.after(f.clean)
  const live = await githubOverview(f.root, [f.root], 'Vaddi-Srisanth/Ion_IDE', new AbortController().signal)
  assert.ok(live.login)
  assert.equal(live.repository, 'Vaddi-Srisanth/Ion_IDE')
  assert.ok(live.pullRequests.length <= 20 && live.issues.length <= 20)
})
