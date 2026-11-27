import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SourceControlGitHub, SourceControlGitHubCreatedPullRequest, SourceControlGitHubIssue, SourceControlGitHubPullRequest } from '../../shared/source-control'
import { isWithin } from '../files'
import { commandPaths, envFor, executable, onPath } from '../run-console/plans'
import { execute } from '../runner'
import { windowsSystemDirectory } from '../windows-process'
import { accountName, checkCreatePullRequestRequest, checkIssueRequest, checkPullRequestRequest, checkRepository, issueUrl, pullRequestUrl } from './github-repository'
export { checkRepository } from './github-repository'

const pageSize = 20
const outputLimit = 64 * 1024
const requestMs = 12_000
const bodyLimit = 8192

export async function resolveGitHubCli(root: string, roots: readonly string[], signal: AbortSignal) {
  const paths = await commandPaths(root)
  if (process.platform === 'win32' && process.env.ProgramFiles && isAbsolute(process.env.ProgramFiles)) {
    paths.unshift(join(process.env.ProgramFiles, 'GitHub CLI'))
  }
  for (const path of paths) {
    signal.throwIfAborted()
    if (roots.some(other => isWithin(other, path))) continue
    const candidate = await onPath('gh', root, [path])
    if (!candidate) continue
    const canonical = await realpath(candidate)
    if (roots.every(other => !isWithin(other, candidate) && !isWithin(other, canonical))) return canonical
  }
  throw new Error('Install the GitHub CLI outside your open workspaces and add gh to PATH.')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub returned unexpected data.')
  return value as Record<string, unknown>
}

/** GitHub descriptions are untrusted text and can contain accidentally pasted credentials. */
function redactHostedText(value: string): string {
  return value.replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/-----BEGIN [A-Z0-9 ]{0,48}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,48}PRIVATE KEY-----|$)/gi, '[redacted private key]')
    .replace(/\b(?:https?|ssh|git\+https?):\/\/[^\s"'<>/@]+@[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/(\bAuthorization\s*:\s*)(?:Bearer|Basic)\s+[\w.+/=-]+/gi, '$1[redacted authorization]')
    .replace(/\bBearer\s+[\w.+/=-]+/gi, '[redacted authorization]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/g, '[redacted token]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted key]')
    .replace(/([\w.-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[\w.-]*["']?\s*[:=]\s*)(?!\[redacted\b)(?:"[^"\n]*"|'[^'\n]*'|[^\s;]+)/gi, '$1[redacted]')
}

function displayLine(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('GitHub returned invalid display text.')
  const label = Array.from(redactHostedText(value).replace(/[\n\t]/g, ' ').trim()).slice(0, limit).join('')
  if (!label) throw new Error('GitHub returned empty display text.')
  return label
}

function items(value: unknown, repository: string, segment: 'pull' | 'issues') {
  if (!Array.isArray(value) || value.length > pageSize) throw new Error('GitHub returned an unexpected number of items.')
  const seen = new Set<number>()
  return value.map(item => {
    const { number, title, url, state } = record(item)
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || seen.has(number)
      || typeof title !== 'string' || !title.trim() || title.length > 2048 || state !== 'open') throw new Error('GitHub returned an invalid open item.')
    const link = 'https://github.com/' + repository + '/' + segment + '/' + number
    if (typeof url !== 'string' || url.toLowerCase() !== link.toLowerCase()) throw new Error('GitHub returned an item outside the requested repository.')
    seen.add(number)
    return { number, title: displayLine(title, 256), url: link }
  })
}

interface Dependencies {
  run?: typeof execute
  findGh?: typeof resolveGitHubCli
}

/** Retrieve a GitHub.com token through the user's official CLI/keyring. Keep it main-process-only. */
export async function githubToken(root: string, workspaceRoots: readonly string[], scratch: string, signal: AbortSignal,
  dependencies: Dependencies = {}): Promise<{ tool: string; token: string }> {
  const tool = await (dependencies.findGh ?? resolveGitHubCli)(root, workspaceRoots, signal)
  if (!isAbsolute(tool) || await realpath(tool) !== tool || !await executable(tool, root)
    || workspaceRoots.some(other => isWithin(other, tool))) throw new Error('The installed GitHub CLI changed. Review the repository again.')
  const helperPaths = process.platform === 'win32' ? [windowsSystemDirectory] : ['/usr/bin', '/bin']
  const systemPaths: string[] = []
  for (const path of helperPaths) {
    const canonical = await realpath(path).catch(() => null)
    if (canonical && workspaceRoots.every(other => !isWithin(other, path) && !isWithin(other, canonical))) systemPaths.push(canonical)
  }
  const authEnvironment = { ...envFor(systemPaths, scratch), GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_TELEMETRY: '0', DO_NOT_TRACK: '1', NO_COLOR: '1' }
  const auth = await (dependencies.run ?? execute)(tool,
    ['auth', 'token', '--hostname', 'github.com'],
    { cwd: scratch, input: '', signal, timeoutMs: requestMs, budget: { remaining: 4096 }, environment: authEnvironment,
      splitOutput: true, collectOutput: false })
  signal.throwIfAborted()
  const token = auth.state === 'exited' && auth.exitCode === 0 && auth.outputComplete !== false
    && typeof auth.stdout === 'string' && Buffer.byteLength(auth.stdout) <= 4096
    ? auth.stdout.trim() : ''
  if (!/^[A-Za-z0-9_=-]{20,4096}$/.test(token)) {
    throw new Error('Sign in to github.com with gh auth login using your OS credential store.')
  }
  return { tool, token }
}

type ApiRequest = (endpoint: string, filter: string, options?: { textBody?: boolean; method?: 'GET' | 'POST'; input?: string }) => Promise<unknown>

/** GH_CONFIG_DIR isolates endpoints, sockets, aliases and pagers. gh obtains credentials through its configured OS credential flow. */
async function withGitHubClient<T>(root: string, workspaceRoots: readonly string[], repository: string, signal: AbortSignal,
  dependencies: Dependencies, read: (get: ApiRequest) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  if (!isAbsolute(root) || !workspaceRoots.includes(root)) throw new Error('Choose an open workspace root.')
  const temp = await realpath(tmpdir())
  if (workspaceRoots.some(other => isWithin(other, temp))) throw new Error('GitHub requires a temporary directory outside the open workspaces.')
  const scratch = await mkdtemp(join(temp, 'ion-gh-read-'))
  try {
    // Ask the user's installed gh to retrieve its official credential while it
    // can still see the normal config/keyring. Keep the token in this main-
    // process closure and pass it only to the isolated API subprocess below.
    const { tool, token } = await githubToken(root, workspaceRoots, scratch, signal, dependencies)
    const helperPaths = process.platform === 'win32' ? [windowsSystemDirectory] : ['/usr/bin', '/bin']
    const systemPaths = (await Promise.all(helperPaths.map(async path => ({ path, canonical: await realpath(path).catch(() => null) }))))
      .filter(({ path, canonical }) => canonical && workspaceRoots.every(other => !isWithin(other, path) && !isWithin(other, canonical)))
      .map(({ canonical }) => canonical!)
    const environment = { ...envFor(systemPaths, scratch), GH_TOKEN: token, GH_HOST: 'github.com', GH_REPO: 'github.com/' + repository,
      GH_CONFIG_DIR: scratch, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_TELEMETRY: '0', DO_NOT_TRACK: '1', NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(scratch, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: temp }
    async function get(endpoint: string, filter: string, options: { textBody?: boolean; method?: 'GET' | 'POST'; input?: string } = {}): Promise<unknown> {
      signal.throwIfAborted()
      if (!isAbsolute(tool) || await realpath(tool) !== tool || !await executable(tool, root) || workspaceRoots.some(other => isWithin(other, tool))) {
        throw new Error('The installed GitHub CLI changed. Review the repository again.')
      }
      if (typeof options.input !== 'undefined' && Buffer.byteLength(options.input) > 10 * 1024) throw new Error('The GitHub request exceeded its limit.')
      const method = options.method ?? 'GET'
      const headers = options.textBody ? ['--header', 'Accept: application/vnd.github.text+json'] : []
      const body = method === 'POST' ? ['--input', '-'] : []
      const result = await (dependencies.run ?? execute)(tool,
        ['api', '--hostname', 'github.com', '--method', method, '--jq', filter, ...headers, ...body, endpoint],
        { cwd: scratch, input: options.input ?? '', signal, timeoutMs: requestMs, budget: { remaining: outputLimit }, environment, splitOutput: true, collectOutput: false })
      signal.throwIfAborted()
      if (result.state === 'timeout') throw new Error(method === 'POST'
        ? 'The GitHub request timed out. Load the pull request list before retrying.'
        : 'The GitHub read timed out.')
      if (result.state === 'output-limit' || result.outputComplete === false || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > outputLimit) {
        throw new Error(method === 'POST'
          ? 'GitHub could not confirm the pull request result. Load the pull request list before retrying.'
          : 'The GitHub CLI response exceeded its limit or could not be fully read.')
      }
      if (result.state !== 'exited' || result.exitCode !== 0) {
        // CLI diagnostics can contain request URLs, settings or account details. Return only fixed messages.
        const stderr = result.stderr ?? ''
        if (result.exitCode === 4 || /HTTP 401|auth login/i.test(stderr)) throw new Error('Sign in to github.com with gh auth login using your OS credential store.')
        if (/rate limit|HTTP 429/i.test(stderr)) throw new Error(method === 'POST'
          ? 'GitHub rate-limited the request. Load the pull request list before retrying.'
          : 'GitHub rate-limited this read. Try again later.')
        if (/HTTP (403|404|422)/i.test(stderr)) {
          if (method === 'POST') throw new Error('GitHub did not create the pull request. Check the branches, permissions, or whether one already exists.')
          throw new Error('The repository is unavailable to the current GitHub account.')
        }
        throw new Error(method === 'POST' ? 'GitHub could not confirm the pull request result. Load the repository again before retrying.'
          : 'The GitHub read failed. Check connectivity and your GitHub CLI sign-in.')
      }
      try { return JSON.parse(result.stdout) as unknown } catch {
        throw new Error(method === 'POST'
          ? 'GitHub returned an invalid result. Load the pull request list before retrying.'
          : 'GitHub returned an invalid response.')
      }
    }
    return await read(get)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function githubOverview(root: string, workspaceRoots: readonly string[], input: unknown, signal: AbortSignal,
  dependencies: Dependencies = {}): Promise<SourceControlGitHub> {
  const repository = checkRepository(input)
  return withGitHubClient(root, workspaceRoots, repository, signal, dependencies, async get => {
    const account = record(await get('user', '{login}'))
    if (typeof account.login !== 'string' || !accountName.test(account.login)) throw new Error('GitHub returned an invalid account.')
    const fields = '{number,title,url:.html_url,state}'
    const pullRequests = items(await get('repos/' + repository + '/pulls?state=open&sort=updated&direction=desc&per_page=' + pageSize,
      '[.[] | ' + fields + ']'), repository, 'pull')
    // The repository issues endpoint includes PRs. Search for issues explicitly so PRs cannot consume the page.
    const query = encodeURIComponent('repo:' + repository + ' is:issue is:open')
    const response = record(await get('search/issues?q=' + query + '&sort=updated&order=desc&per_page=' + pageSize,
      '{incomplete:.incomplete_results,items:[.items[] | ' + fields + ']}'))
    if (response.incomplete !== false) throw new Error('GitHub returned an incomplete issue search. Try again.')
    return { repository, login: account.login, pullRequests, issues: items(response.items, repository, 'issues') }
  })
}

export async function githubPullRequest(root: string, workspaceRoots: readonly string[], input: unknown, signal: AbortSignal,
  dependencies: Dependencies = {}): Promise<SourceControlGitHubPullRequest> {
  const request = checkPullRequestRequest(input)
  return withGitHubClient(root, workspaceRoots, request.repository, signal, dependencies, async get => {
    const description = '(.body_text // "")'
    const fields = '{number,title,url:.html_url,state,merged,draft,author:.user.login,base:.base.ref,head:.head.label'
      + ',body:' + description + '[:' + bodyLimit + '],bodyTruncated:(' + description + ' | length > ' + bodyLimit + ')}'
    const result = record(await get('repos/' + request.repository + '/pulls/' + request.number, fields,
      { textBody: true }))
    const { number, title, url, state, merged, draft, author, base, head, body, bodyTruncated } = result
    const expectedUrl = pullRequestUrl(request)
    if (number !== request.number || typeof url !== 'string' || url.toLowerCase() !== expectedUrl.toLowerCase()
      || (state !== 'open' && state !== 'closed') || typeof merged !== 'boolean' || (merged && state !== 'closed')
      || typeof draft !== 'boolean' || (author !== null && (typeof author !== 'string' || !accountName.test(author.replace(/\[bot\]$/, ''))))
      || typeof body !== 'string' || body.length > bodyLimit * 2 || typeof bodyTruncated !== 'boolean') {
      throw new Error('GitHub returned invalid pull request details.')
    }
    const cleanBody = redactHostedText(body)
    const characters = Array.from(cleanBody)
    return { number: request.number, title: displayLine(title, 256), url: expectedUrl, state: merged ? 'merged' : state,
      draft, author, base: displayLine(base, 160), head: displayLine(head, 160), body: characters.slice(0, bodyLimit).join('').trim(),
      bodyTruncated: bodyTruncated || characters.length > bodyLimit }
  })
}

export async function githubIssue(root: string, workspaceRoots: readonly string[], input: unknown, signal: AbortSignal,
  dependencies: Dependencies = {}): Promise<SourceControlGitHubIssue> {
  const request = checkIssueRequest(input)
  return withGitHubClient(root, workspaceRoots, request.repository, signal, dependencies, async get => {
    const description = '(.body_text // "")'
    const fields = '{number,title,url:.html_url,state,author:.user.login,body:' + description + '[:' + bodyLimit
      + '],bodyTruncated:(' + description + ' | length > ' + bodyLimit + '),isPullRequest:(.pull_request != null)}'
    const result = record(await get('repos/' + request.repository + '/issues/' + request.number, fields, { textBody: true }))
    const { number, title, url, state, author, body, bodyTruncated, isPullRequest } = result
    const expectedUrl = issueUrl(request)
    if (number !== request.number || typeof url !== 'string' || url.toLowerCase() !== expectedUrl.toLowerCase()
      || (state !== 'open' && state !== 'closed') || isPullRequest !== false
      || (author !== null && (typeof author !== 'string' || !accountName.test(author.replace(/\[bot\]$/, ''))))
      || typeof body !== 'string' || body.length > bodyLimit * 2 || typeof bodyTruncated !== 'boolean') {
      throw new Error('GitHub returned invalid issue details.')
    }
    const cleanBody = redactHostedText(body)
    const characters = Array.from(cleanBody)
    return { number: request.number, title: displayLine(title, 256), url: expectedUrl, state, author,
      body: characters.slice(0, bodyLimit).join('').trim(), bodyTruncated: bodyTruncated || characters.length > bodyLimit }
  })
}

export async function createGitHubPullRequest(root: string, workspaceRoots: readonly string[], input: unknown, signal: AbortSignal,
  dependencies: Dependencies = {}): Promise<SourceControlGitHubCreatedPullRequest> {
  const request = checkCreatePullRequestRequest(input)
  return withGitHubClient(root, workspaceRoots, request.repository, signal, dependencies, async api => {
    const fields = '{number,title,url:.html_url,head:.head.label,base:.base.ref,draft,state}'
    const response = record(await api('repos/' + request.repository + '/pulls', fields, {
      method: 'POST', input: JSON.stringify({ title: request.title, head: request.head, base: request.base,
        body: request.body, draft: request.draft }),
    }))
    const expectedUrl = 'https://github.com/' + request.repository + '/pull/' + response.number
    const responseHead = typeof response.head === 'string' ? response.head.split(':') : []
    const requestedHead = request.head.split(':')
    const selectedBranch = requestedHead.at(-1)
    const headMatches = responseHead.length === 2 && responseHead[1] === selectedBranch
      && (requestedHead.length === 1 || responseHead[0].toLowerCase() === requestedHead[0].toLowerCase())
    if (!Number.isSafeInteger(response.number) || (response.number as number) < 1 || response.state !== 'open'
      || response.draft !== request.draft || response.title !== request.title || response.base !== request.base || !headMatches
      || typeof response.url !== 'string'
      || response.url.toLowerCase() !== expectedUrl.toLowerCase()) {
      throw new Error('GitHub returned an invalid pull request result. Load the repository to check whether it was created.')
    }
    return { number: response.number as number, title: displayLine(response.title, 256), url: expectedUrl,
      head: displayLine(response.head, 256), base: displayLine(response.base, 160), draft: response.draft }
  })
}
