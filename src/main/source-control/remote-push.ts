import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceControlPushRequest, SourceControlPushReview } from '../../shared/source-control'
import { execute } from '../runner'
import { isWithin } from '../files'
import { checkRepository } from './github-repository'
import { anonymousGitEnvironment, anonymousGitHelper, anonymousHttpsOptions, externalGitTool } from './clone'
import { git, resolveGit, type Repository } from './repository'
import { gitObjectId } from './commit'

const outputLimit = 64 * 1024
const pushMs = 120_000
const objectLimit = 25_000
const outgoingBytesLimit = 256 * 1024 * 1024

export async function measurePush(repository: Repository, signal: AbortSignal, head: string, previous: string): Promise<Pick<SourceControlPushReview, 'commits' | 'objects' | 'bytes'>> {
  const listed = await git(repository, signal, ['rev-list', '--objects', head, '--not', previous], { limit: 2 * 1024 * 1024 })
  if (!listed.complete) throw new Error('The outgoing Git history is too large to review in Ion.')
  const ids = [...new Set(listed.text.split('\n').filter(Boolean).map(row => row.split(' ', 1)[0]))]
  if (!ids.length || ids.length > objectLimit || ids.some(oid => !gitObjectId.test(oid))) {
    throw new Error('The outgoing Git history exceeds Ion’s review limit.')
  }
  const measured = await git(repository, signal, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    { input: ids.join('\n') + '\n', limit: 2 * 1024 * 1024 })
  if (!measured.complete) throw new Error('The outgoing Git object list could not be verified completely.')
  const rows = measured.text.trim().split(/\r?\n/)
  if (rows.length !== ids.length) throw new Error('Git returned an incomplete outgoing object list.')
  let commits = 0, bytes = 0
  for (let index = 0; index < rows.length; index++) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (commit|tree|blob|tag) ([0-9]+)$/.exec(rows[index])
    if (!match || match[1] !== ids[index]) throw new Error('Git returned an invalid outgoing object size.')
    const size = Number(match[3])
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Git returned an invalid outgoing object size.')
    bytes += size
    if (match[2] === 'commit') commits++
    if (bytes > outgoingBytesLimit) throw new Error('The outgoing Git objects exceed Ion’s 256 MiB push review limit.')
  }
  return { commits, objects: ids.length, bytes }
}

function remoteName(value: string): boolean {
  return value.length <= 100 && !value.includes('..') && !value.includes('@{')
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !/\.lock$/i.test(part)
      && /^[\p{L}\p{N}_.-]+$/u.test(part))
}

function branchName(value: string): boolean {
  return value.length <= 1024 && !/[\x00-\x20\x7f\u202a-\u202e\u2066-\u2069~^:?*\[\\<>"|]/u.test(value)
    && !value.includes('..') && !value.includes('@{')
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !/\.lock$/i.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

/** Push exactly the reviewed commit to one GitHub branch, with a lease on its reviewed previous OID. */
export async function pushGitHubBranch(repository: Repository, workspaceRoots: readonly string[], selection: SourceControlPushRequest,
  signal: AbortSignal, validate: () => Promise<void>, deps: {
    run?: typeof execute; findGit?: typeof resolveGit
    getToken?: (root: string, roots: readonly string[], scratch: string, signal: AbortSignal) => Promise<{ tool: string; token: string }>
    findGh?: (root: string, roots: readonly string[], signal: AbortSignal) => Promise<string>
  } = {}): Promise<string> {
  const slug = checkRepository(selection?.repository)
  const { remote, branch, previous, head } = selection
  if (typeof remote !== 'string' || !remoteName(remote) || typeof branch !== 'string' || !branchName(branch)
    || typeof previous !== 'string' || !gitObjectId.test(previous) || typeof head !== 'string' || !gitObjectId.test(head)
    || previous.length !== head.length) throw new Error('Choose a reviewed GitHub branch push.')
  const temp = await realpath(tmpdir())
  if (workspaceRoots.some(root => inside(root, temp))) throw new Error('GitHub push requires private temporary storage outside all workspaces.')
  const scratch = await mkdtemp(join(temp, 'ion-git-push-'))
  try {
    const neutral = join(scratch, 'environment')
    const template = join(scratch, 'empty-template')
    await mkdir(neutral, { mode: 0o700 })
    await mkdir(template, { mode: 0o700 })
    const tool = await (deps.findGit ?? resolveGit)(neutral, signal)
    if (!tool) throw new Error('Install Git to push a GitHub branch.')
    const binary = await externalGitTool(tool.executable, workspaceRoots)
    const environment: NodeJS.ProcessEnv = await anonymousGitEnvironment(binary, workspaceRoots, neutral, scratch, template)
    const tokenProvider = deps.getToken ?? (async (root, roots, directory, authSignal) => {
      const { githubToken } = await import('./github')
      return githubToken(root, roots, directory, authSignal, { run: deps.run ?? execute, findGh: deps.findGh })
    })
    const { token } = await tokenProvider(repository.root, workspaceRoots, scratch, signal)
    if (!/^[A-Za-z0-9_=-]{20,4096}$/.test(token)) throw new Error('GitHub authentication did not return a valid credential.')
    const authorization = Buffer.from('x-access-token:' + token, 'utf8').toString('base64')
    Object.assign(environment, {
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: 'Authorization: basic ' + authorization,
    })
    if (environment.GIT_ALLOW_PROTOCOL !== 'https' || environment.GIT_TERMINAL_PROMPT !== '0'
      || environment.GIT_CONFIG_NOSYSTEM !== '1'
      || environment.GIT_CONFIG_GLOBAL !== (process.platform === 'win32' ? 'NUL' : '/dev/null')) {
      throw new Error('GitHub push transport isolation could not be verified.')
    }
    const execPath = (await run(['--exec-path'], 5000, 4096)).trim()
    environment.GIT_EXEC_PATH = await anonymousGitHelper(execPath, workspaceRoots)
    const endpoint = 'https://github.com/' + slug + '.git'
    const ref = 'refs/heads/' + branch
    const source = head + ':' + ref
    await validate()
    signal.throwIfAborted()
    const push = await run([...anonymousHttpsOptions(template), '--git-dir=' + repository.directory,
      '--work-tree=' + repository.root, 'push', '--porcelain', '--no-verify', '--no-follow-tags',
      '--no-recurse-submodules', '--force-with-lease=' + ref + ':' + previous, '--', endpoint, source], pushMs)
    if (!push.includes('To https://github.com/' + slug + '.git')) {
      throw new Error('GitHub did not confirm the reviewed push destination.')
    }
    const check = await run([...anonymousHttpsOptions(template), '--git-dir=' + repository.directory,
      '--work-tree=' + repository.root, 'ls-remote', '--refs', '--', endpoint, ref], 15_000, 4096)
    const rows = check.trim().split(/\r?\n/).filter(Boolean)
    if (rows.length !== 1 || rows[0].split('\t')[0] !== head || rows[0].split('\t')[1] !== ref) {
      throw new Error('The push completed, but GitHub did not confirm the requested branch commit. Refresh the remote branch before retrying.')
    }
    return head

    async function run(args: string[], timeoutMs = 8000, limit = outputLimit): Promise<string> {
      signal.throwIfAborted()
      if (await externalGitTool(binary, workspaceRoots) !== binary) throw new Error('The installed Git changed.')
      const result = await (deps.run ?? execute)(binary, args, { cwd: neutral, input: '', signal, timeoutMs,
        budget: { remaining: limit }, environment, splitOutput: true, collectOutput: false })
      if (result.outputComplete === false || result.state === 'timeout') throw new Error('The GitHub push timed out or returned incomplete output.')
      if (result.state !== 'exited' || result.exitCode !== 0
        || Buffer.byteLength(result.stdout ?? '') + Buffer.byteLength(result.stderr ?? '') > limit) {
        // Do not expose Git diagnostics, which can include transport or remote details.
        throw new Error('GitHub did not accept the reviewed push. Check branch permissions and refresh the remote state.')
      }
      return result.stdout ?? ''
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function inside(root: string, path: string): boolean {
  return isWithin(root, path)
}
