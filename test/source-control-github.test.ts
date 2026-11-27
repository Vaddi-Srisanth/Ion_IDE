import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGitHubPullRequest, githubOverview, githubPullRequest } from '../src/main/source-control/github'
import { checkCreatePullRequestRequest } from '../src/main/source-control/github-repository'
import type { execute } from '../src/main/runner'

type Run = typeof execute
const fixtureRepository = 'ion-fixture/sample.repo'
const ok = (value: unknown): Awaited<ReturnType<Run>> => ({ state: 'exited', exitCode: 0, output: '',
  stdout: JSON.stringify(value), stderr: '', outputComplete: true })
const pull = { number: 7, title: 'Review the files', url: 'https://github.com/' + fixtureRepository + '/pull/7', state: 'open' }
const pullRequest = { repository: fixtureRepository, number: pull.number }
const pullDetails = { ...pull, merged: false, draft: true, author: 'dependabot[bot]',
  base: 'main', head: 'octo-user:topic/changes', body: '', bodyTruncated: false }

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-gh-test-')))
  const root = join(directory, 'working tree')
  await mkdir(root)
  const binary = await realpath(process.execPath)
  const call = (run: Run, name: unknown = fixtureRepository, signal = new AbortController().signal) =>
    githubOverview(root, [root], name, signal, { run, findGh: async () => binary })
  const detail = (run: Run, request: unknown = pullRequest, signal = new AbortController().signal) =>
    githubPullRequest(root, [root], request, signal, { run, findGh: async () => binary })
  const create = (run: Run, request: unknown = { repository: fixtureRepository, title: 'Add feature', head: 'octo-user:feature/one',
    base: 'main', body: 'Reviewed description', draft: true }, signal = new AbortController().signal) =>
    createGitHubPullRequest(root, [root], request, signal, { run, findGh: async () => binary })
  return { directory, root, binary, call, detail, create, clean: () => rm(directory, { recursive: true, force: true }) }
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

test('PR details use one fixed isolated GET and redact common credentials before returning text', async t => {
  const f = await fixture(); t.after(f.clean)
  const privateToken = 'ghp_' + 'A'.repeat(36)
  let calls = 0, scratch = ''
  const detail = await f.detail(async (binary, args, options) => {
    calls++
    assert.equal(binary, f.binary)
    assert.deepEqual(args.slice(0, 6), ['api', '--hostname', 'github.com', '--method', 'GET', '--jq'])
    assert.match(args[6], /\.body_text.*\[:8192\]/)
    assert.deepEqual(args.slice(7), ['--header', 'Accept: application/vnd.github.text+json',
      'repos/' + fixtureRepository + '/pulls/7'])
    scratch = options.cwd
    assert.notEqual(scratch, f.root)
    assert.equal(options.environment.GH_CONFIG_DIR, scratch)
    assert.equal(options.environment.GH_TOKEN, undefined)
    assert.equal(options.environment.GITHUB_TOKEN, undefined)
    return ok({ ...pullDetails, title: 'Review ' + privateToken, bodyTruncated: true,
      body: ['A note with <script>alert(1)</script>', privateToken, 'Authorization: Basic abc123SECRET',
        'password="test private password"', 'https://octo:private-password@github.com/test/a',
        '-----BEGIN PRIVATE KEY-----', 'secret-pem-data', '-----END PRIVATE KEY-----', 'Final note.'].join('\r\n') })
  })
  assert.equal(calls, 1)
  assert.equal(detail.title, 'Review [redacted token]')
  assert.equal(detail.author, 'dependabot[bot]')
  assert.equal(detail.state, 'open')
  assert.equal(detail.draft, true)
  assert.equal(detail.base, 'main')
  assert.equal(detail.head, 'octo-user:topic/changes')
  assert.equal(detail.bodyTruncated, true)
  assert.match(detail.body, /^A note with <script>alert\(1\)<\/script>/)
  assert.match(detail.body, /Final note\.$/)
  assert.doesNotMatch(JSON.stringify(detail), /ghp_|abc123SECRET|test private password|private-password@|secret-pem-data/)
  assert.doesNotMatch(detail.body, /\r/)
  await assert.rejects(access(scratch), { code: 'ENOENT' })
})

test('PR details reject unreviewable requests and mismatched or oversized responses', async t => {
  const f = await fixture(); t.after(f.clean)
  const forbidden = async () => { throw new Error('Unexpected CLI launch') }
  for (const request of [null, { repository: fixtureRepository, number: -7 }, { repository: fixtureRepository, number: '7' },
    { repository: fixtureRepository, number: 1.5 }, { ...pullRequest, url: pull.url }, { ...pullRequest, repository: 'outside/repo?x=1' }]) {
    await assert.rejects(f.detail(forbidden, request), /loaded GitHub repository|owner\/name/)
  }
  for (const invalid of [{ number: 8 }, { url: 'https://github.com/other/repo/pull/7' }, { url: 'https://outside.invalid' },
    { state: 'unknown' }, { merged: true }, { draft: 'false' }, { author: 'host.example/attacker' },
    { body: 'x'.repeat(16385) }, { bodyTruncated: 1 }]) {
    await assert.rejects(f.detail(async () => ok({ ...pullDetails, ...invalid })), /invalid pull request details/)
  }
  await assert.rejects(f.detail(async () => ok({ ...pullDetails, base: '\u202e' })), /display text/)
  const closed = await f.detail(async () => ok({ ...pullDetails, state: 'closed', merged: true, author: null }))
  assert.equal(closed.state, 'merged')
  assert.equal(closed.author, null)
})

test('pull request creation uses one isolated authenticated POST with reviewed fields on stdin', async t => {
  const f = await fixture(); t.after(f.clean)
  const keys = ['GH_TOKEN', 'GH_CONFIG_DIR', 'GH_DEBUG', 'GIT_SSH_COMMAND', 'HTTPS_PROXY', 'GITHUB_TOKEN']
  const saved = keys.map(key => process.env[key])
  keys.forEach(key => { process.env[key] = 'injected-setting' })
  t.after(() => keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] }))
  let scratch = '', calls = 0
  const result = await f.create(async (binary, args, options) => {
    calls++
    assert.equal(binary, f.binary)
    assert.deepEqual(args, ['api', '--hostname', 'github.com', '--method', 'POST', '--jq',
      '{number,title,url:.html_url,head:.head.label,base:.base.ref,draft,state}', '--input', '-',
      'repos/' + fixtureRepository + '/pulls'])
    assert.equal(options.timeoutMs, 12_000)
    assert.equal(options.cwd, options.environment.GH_CONFIG_DIR)
    scratch = options.cwd
    assert.notEqual(scratch, f.root)
    assert.deepEqual(JSON.parse(options.input), { title: 'Add feature', head: 'octo-user:feature/one', base: 'main',
      body: 'Reviewed description', draft: true })
    for (const key of keys) assert.equal(options.environment[key], key === 'GH_CONFIG_DIR' ? scratch : undefined)
    assert.equal(options.environment.GH_PROMPT_DISABLED, '1')
    assert.equal(options.environment.GH_HOST, 'github.com')
    return ok({ number: 19, title: 'Add feature', url: 'https://github.com/' + fixtureRepository + '/pull/19',
      head: 'octo-user:feature/one', base: 'main', draft: true, state: 'open' })
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { number: 19, title: 'Add feature', url: 'https://github.com/' + fixtureRepository + '/pull/19',
    head: 'octo-user:feature/one', base: 'main', draft: true })
  assert.equal(optionsHasNoCredential(result), true)
  await assert.rejects(access(scratch), { code: 'ENOENT' })
})

function optionsHasNoCredential(value: unknown) {
  return !/GH_TOKEN|GITHUB_TOKEN|gh[pousr]_|github_pat_/.test(JSON.stringify(value))
}

test('pull request creation validates reviewed fields, rejects malformed API results, and never retries uncertain writes', async t => {
  const f = await fixture(); t.after(f.clean)
  const forbidden = async () => { throw new Error('Unexpected CLI launch') }
  const valid = { repository: fixtureRepository, title: 'Add feature', head: 'octo-user:feature/one', base: 'main', body: '', draft: false }
  for (const invalid of [null, { ...valid, extra: true }, { ...valid, title: '  ' }, { ...valid, title: 'a\nb' },
    { ...valid, title: 'x'.repeat(257) }, { ...valid, head: '../outside' }, { ...valid, head: 'owner:../../topic' },
    { ...valid, head: 'x'.repeat(256) }, { ...valid, draft: 'false' },
    { ...valid, body: 'x'.repeat(8193) }, { ...valid, body: 'x\0y' }]) {
    assert.throws(() => checkCreatePullRequestRequest(invalid))
    await assert.rejects(f.create(forbidden, invalid), /pull request|title|branch|description|owner\/name/i)
  }
  for (const invalid of [{ number: 0 }, { state: 'closed' }, { draft: false }, { head: 'attacker:branch' },
    { url: 'https://outside.invalid/pull/19' }]) {
    await assert.rejects(f.create(async () => ok({ number: 19, title: 'Add feature', head: 'octo-user:feature/one',
      base: 'main', draft: false, state: 'open', url: 'https://github.com/' + fixtureRepository + '/pull/19', ...invalid })),
    /invalid pull request result/)
  }
  let calls = 0
  await assert.rejects(f.create(async () => { calls++; return { ...ok({}), state: 'timeout' } }), /timed out.*before retrying/)
  assert.equal(calls, 1)
  await assert.rejects(f.create(async (_tool, _args, options) => {
    assert.doesNotMatch(options.input, /GH_TOKEN|GITHUB_TOKEN/)
    return { ...ok({}), exitCode: 1, stderr: 'HTTP 422 private diagnostic detail' }
  }), /did not create.*branches, permissions/)
})

test('live authenticated GitHub read for the official Ion repository', { skip: process.env.ION_TEST_GITHUB_LIVE !== '1', timeout: 50_000 }, async t => {
  const f = await fixture(); t.after(f.clean)
  const live = await githubOverview(f.root, [f.root], 'Vaddi-Srisanth/Ion_IDE', new AbortController().signal)
  assert.ok(live.login)
  assert.equal(live.repository, 'Vaddi-Srisanth/Ion_IDE')
  assert.ok(live.pullRequests.length <= 20 && live.issues.length <= 20)
})
