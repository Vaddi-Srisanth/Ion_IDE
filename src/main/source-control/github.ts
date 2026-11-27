import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SourceControlGitHub } from '../../shared/source-control'
import { isWithin } from '../files'
import { commandPaths, envFor, executable, onPath } from '../run-console/plans'
import { execute } from '../runner'
import { windowsSystemDirectory } from '../windows-process'
import { accountName, checkRepository } from './github-repository'
export { checkRepository } from './github-repository'

const pageSize = 20
const outputLimit = 64 * 1024
const requestMs = 12_000

async function trustedGh(root: string, roots: readonly string[], signal: AbortSignal) {
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

function items(value: unknown, repository: string, segment: 'pull' | 'issues') {
  if (!Array.isArray(value) || value.length > pageSize) throw new Error('GitHub returned an unexpected number of items.')
  const seen = new Set<number>()
  return value.map(item => {
    const { number, title, url, state } = record(item)
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || seen.has(number)
      || typeof title !== 'string' || !title.trim() || title.length > 2048 || state !== 'open') throw new Error('GitHub returned an invalid open item.')
    const link = 'https://github.com/' + repository + '/' + segment + '/' + number
    if (typeof url !== 'string' || url.toLowerCase() !== link.toLowerCase()) throw new Error('GitHub returned an item outside the requested repository.')
    const label = Array.from(title.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').trim()).slice(0, 256).join('')
    if (!label) throw new Error('GitHub returned an empty item title.')
    seen.add(number)
    return { number, title: label, url: link }
  })
}

interface Dependencies {
  run?: typeof execute
  findGh?: typeof trustedGh
}

/** Explicit read only. GH_CONFIG_DIR isolates the endpoint, socket, aliases and pager. gh obtains its own credential from the OS keyring. */
export async function githubOverview(root: string, workspaceRoots: readonly string[], input: unknown, signal: AbortSignal,
  dependencies: Dependencies = {}): Promise<SourceControlGitHub> {
  const repository = checkRepository(input)
  signal.throwIfAborted()
  if (!isAbsolute(root) || !workspaceRoots.includes(root)) throw new Error('Choose an open workspace root.')
  const tool = await (dependencies.findGh ?? trustedGh)(root, workspaceRoots, signal)
  const temp = await realpath(tmpdir())
  if (workspaceRoots.some(other => isWithin(other, temp))) throw new Error('GitHub requires a temporary directory outside the open workspaces.')
  const scratch = await mkdtemp(join(temp, 'ion-gh-read-'))
  try {
    const helperPaths = process.platform === 'win32' ? [windowsSystemDirectory] : ['/usr/bin', '/bin']
    const systemPaths: string[] = []
    for (const path of helperPaths) {
      const canonical = await realpath(path).catch(() => null)
      if (canonical && workspaceRoots.every(other => !isWithin(other, path) && !isWithin(other, canonical))) systemPaths.push(canonical)
    }
    const environment = { ...envFor(systemPaths, scratch), GH_HOST: 'github.com', GH_REPO: 'github.com/' + repository,
      GH_CONFIG_DIR: scratch, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_TELEMETRY: '0', DO_NOT_TRACK: '1', NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(scratch, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: temp }
    async function get(endpoint: string, filter: string): Promise<unknown> {
      signal.throwIfAborted()
      if (!isAbsolute(tool) || await realpath(tool) !== tool || !await executable(tool, root) || workspaceRoots.some(other => isWithin(other, tool))) {
        throw new Error('The installed GitHub CLI changed. Review the repository again.')
      }
      const result = await (dependencies.run ?? execute)(tool, ['api', '--hostname', 'github.com', '--method', 'GET', '--jq', filter, endpoint],
        { cwd: scratch, input: '', signal, timeoutMs: requestMs, budget: { remaining: outputLimit }, environment, splitOutput: true, collectOutput: false })
      signal.throwIfAborted()
      if (result.state === 'timeout') throw new Error('The GitHub read timed out.')
      if (result.state === 'output-limit' || result.outputComplete === false || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > outputLimit) {
        throw new Error('The GitHub CLI response exceeded its limit or could not be fully read.')
      }
      if (result.state !== 'exited' || result.exitCode !== 0) {
        // CLI diagnostics can contain request URLs, settings or account details. Return only fixed messages.
        const stderr = result.stderr ?? ''
        if (result.exitCode === 4 || /HTTP 401|auth login/i.test(stderr)) throw new Error('Sign in to github.com with gh auth login using your OS credential store.')
        if (/rate limit|HTTP 429/i.test(stderr)) throw new Error('GitHub rate-limited this read. Try again later.')
        if (/HTTP (403|404|422)/i.test(stderr)) throw new Error('The repository is unavailable to the current GitHub account.')
        throw new Error('The GitHub read failed. Check connectivity and your GitHub CLI sign-in.')
      }
      try { return JSON.parse(result.stdout) as unknown } catch { throw new Error('GitHub returned an invalid response.') }
    }
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
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
