import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { commandPaths, envFor, onPath } from '../run-console/plans'
import { execute } from '../runner'
import { revision } from '../files'
import { browseLocalRefs } from './browse'
import type { SourceControlComparisonRequest } from '../../shared/source-control'
import { commonGitDirectory, withFrozenConfiguration } from './configuration'
import { withIndexTransaction } from './index-transaction'
import { verifyCachedRemoteBranch } from './remote-branches'
import { safeGitPath } from './status'
import { reviewedRemotes } from './remotes'

export function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isAbsolute(fromRoot)
}

export function absent(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export class UnavailableDiff extends Error {}

export async function readTextFile(path: string, maxBytes: number, expectedRevision?: string): Promise<string> {
  const before = await lstat(path)
  if (!before.isFile()) throw new UnavailableDiff('This path is not a regular file.')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new UnavailableDiff('The file changed before it could be opened.')
    }
    if (expectedRevision && (revision(await handle.stat({ bigint: true })) !== expectedRevision || await realpath(path) !== path)) {
      throw new UnavailableDiff('The selected file changed before inspection.')
    }
    if (opened.size > maxBytes) throw new UnavailableDiff('This file exceeds the text preview limit.')
    const data = Buffer.allocUnsafe(opened.size + 1)
    let count = 0
    while (count < data.length) {
      const { bytesRead } = await handle.read(data, count, data.length - count, count)
      if (!bytesRead) break
      count += bytesRead
    }
    const after = await handle.stat()
    if (count !== opened.size || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size) {
      throw new UnavailableDiff('The file changed while it was being read. Refresh and try again.')
    }
    const bytes = data.subarray(0, count)
    if (bytes.includes(0)) throw new UnavailableDiff('This is a binary file.')
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw new UnavailableDiff('This file is not UTF-8 text.') }
  } finally {
    await handle.close()
  }
}

function metadataPath(text: string, relativeTo: string): string {
  const name = text.replace(/\r?\n$/, '')
  if (!name || /[\r\n]/.test(name)) throw new Error('Git worktree metadata is invalid.')
  return resolve(relativeTo, name)
}

export async function gitDirectory(root: string): Promise<string | null> {
  const marker = join(root, '.git')
  const entry = await lstat(marker).catch((error: unknown) => {
    if (absent(error)) return null
    throw error
  })
  if (!entry) return null
  if (entry.isDirectory()) {
    if (relative(marker, await realpath(marker))) throw new Error('Git metadata escapes the workspace.')
    // A normal .git directory has no common-directory redirect.
    const common = await lstat(join(marker, 'commondir')).then(() => true, (error: unknown) => {
      if (absent(error)) return false
      throw error
    })
    if (common) throw new Error('Open the root of a standard Git repository or linked worktree.')
    return marker
  }
  if (!entry.isFile()) throw new Error('Git metadata must be a regular directory or worktree file.')
  const reference = await readTextFile(marker, 8192)
  if (!reference.startsWith('gitdir: ')) throw new Error('Git worktree metadata is invalid.')
  const directory = await realpath(metadataPath(reference.slice(8), root))
  if (basename(dirname(directory)) !== 'worktrees' || !(await lstat(directory)).isDirectory()) {
    throw new Error('Open the root of a standard Git repository or linked worktree.')
  }
  const reciprocal = await readTextFile(join(directory, 'gitdir'), 8192)
  const common = await readTextFile(join(directory, 'commondir'), 8192)
  if (relative(marker, await realpath(metadataPath(reciprocal, directory)))
    || relative(dirname(dirname(directory)), await realpath(metadataPath(common, directory)))) {
    throw new Error('Git worktree metadata does not match this workspace.')
  }
  return directory
}

export interface Repository {
  root: string
  directory: string
  executable: string
  paths: string[]
}

export async function resolveGit(root: string, signal: AbortSignal): Promise<Pick<Repository, 'executable' | 'paths'> | null> {
  const paths = await commandPaths(root)
  signal.throwIfAborted()
  if (process.platform === 'win32') {
    const defaults = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, 'Programs')]
    for (const prefix of defaults) {
      if (prefix && isAbsolute(prefix)) paths.push(join(prefix, 'Git', 'cmd'))
    }
  }
  if (process.platform === 'darwin' && paths.includes('/usr/bin')) {
    // The system Git can be a stub that opens the Xcode tools installer.
    const alternate = await onPath('git', root, paths, ['/usr/bin/git'])
    if (alternate && alternate !== '/bin/git') return { executable: alternate, paths }
    const selected = await execute('/usr/bin/xcode-select', ['-p'], {
      cwd: root, input: '', signal, timeoutMs: 2000, budget: { remaining: 8192 },
      environment: envFor(['/usr/bin', '/bin'], tmpdir()),
    })
    if (selected.exitCode !== 0 || !isAbsolute(selected.output.trim())) return null
  }
  const executable = await onPath('git', root, paths)
  return executable ? { executable, paths } : null
}

const gitOptions = [
  '--no-pager', '--no-optional-locks', '--literal-pathspecs',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'commit.gpgSign=false',
  '-c', 'core.alternateRefsCommand=',
  '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never',
]

interface GitOptions {
  limit?: number; input?: string; timeout?: number; allowTruncation?: boolean; allowNotFound?: boolean; indexFile?: string
}

const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function switchTransaction(input: string): boolean {
  const lines = input.split('\n')
  if (lines.length !== 8 || lines[0] !== 'start' || lines[1] !== 'option no-deref'
    || lines[3] !== 'option no-deref' || lines[5] !== 'prepare' || lines[6] !== 'commit' || lines[7] !== '') return false
  const update = /^symref-update HEAD refs\/heads\/([^\s]+) oid ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(lines[2])
  const target = /^verify refs\/heads\/([^\s]+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(lines[4])
  if (!update || !target || update[1] !== target[1] || update[1] === '@' || update[2].length !== target[2].length) return false
  const safeBranch = (name: string) => name.length <= 1024 && name !== '@' && !name.startsWith('-')
    && !/[\x00-\x20\x7f~^:?*\[\\<>"|]/u.test(name) && !name.includes('..') && !name.includes('@{')
    && name.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !/\.lock$/i.test(part))
  return safeBranch(update[1])
}

function plumbingCommand(args: string[], input = ''): boolean {
  const fetchedRef = args.length === 7 && args[1] === '--no-deref' && args[2] === '-m'
    && args[3] === 'fetch: updated in Ion' && args[4].startsWith('refs/remotes/')
    && objectId.test(args[5]) && objectId.test(args[6]) && args[5].length === args[6].length
    && args[5] !== args[6] && args[6] !== '0'.repeat(args[6].length)
    && args[4].slice('refs/remotes/'.length).split('/').every(part => part && !part.startsWith('.')
      && !part.endsWith('.') && !/\.lock$/i.test(part) && !/[\x00-\x20\x7f~^:?*\[\\<>"|]/u.test(part)
      && !part.includes('..') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  switch (args[0]) {
    case 'rev-parse': return args.join(' ') === 'rev-parse --verify HEAD'
      || args.length === 3 && args[1] === '--verify' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\^\{tree\}$/.test(args[2])
    case 'cat-file': return args.length === 3 && args[1] === 'blob' && objectId.test(args[2])
      || args.length === 3 && args[1] === '-t' && objectId.test(args[2])
    case 'ls-tree': return args.length === 5 && args[1] === '-z' && objectId.test(args[2]) && args[3] === '--' && safeGitPath(args[4])
    case 'ls-files': return args.length === 5 && (args[1] === '--unmerged' || args[1] === '--stage') && args[2] === '-z' && args[3] === '--' && safeGitPath(args[4])
    case 'read-tree': return args.length === 2 && (args[1] === '--empty' || objectId.test(args[1]))
    case 'update-index': return args.join(' ') === 'update-index -z --index-info'
      || args.length >= 4 && args[1] === '--force-remove' && args[2] === '--'
    case 'write-tree': return args.length === 1
    case 'restore': return args.length >= 4
      && (args[1] === '--staged' && args[2] === '--source=HEAD' && args[3] === '--'
        || args[1] === '--worktree' && args[2] === '--')
    case 'commit-tree': return (args.length === 5 || args.length === 7) && objectId.test(args[1])
      && args.slice(-3).join(' ') === '--no-gpg-sign -F -'
      && (args.length === 5 || args[2] === '-p' && objectId.test(args[3]))
    case 'symbolic-ref': return args.join(' ') === 'symbolic-ref --quiet --no-recurse HEAD'
    case 'worktree': return args.length === 4 && args[1] === 'list' && args[2] === '--porcelain' && args[3] === '-z'
    case 'update-ref': return fetchedRef || args.length === 7 && args[1] === '--no-deref' && args[2] === '-m'
      && objectId.test(args[5]) && objectId.test(args[6])
      && (args[4].startsWith('refs/heads/') || args[4].startsWith('refs/tags/')
        && args[3] === 'tag: created in Ion' && args[6] === '0'.repeat(args[5].length))
      || args.length === 2 && args[1] === '--stdin' && switchTransaction(input)
    default: return false
  }
}

export async function git(repository: Repository, signal: AbortSignal, args: string[], options: GitOptions = {}) {
  if (args[0] === 'status' || args[0] === 'add' || args[0] === 'stash') {
    if (args[0] === 'add' && (args.length < 4 || args[1] !== '-A' || args[2] !== '--')
      || args[0] === 'status' && args.join(' ') !== 'status --porcelain=v2 -z --branch --untracked-files=all --ignore-submodules=dirty --find-renames=50%') {
      throw new Error('This Git operation is outside Ion Source Control.')
    }
    if (args[0] === 'stash' && !(args.length === 2 && args[1] === 'create'
      || args.length === 5 && args[1] === 'store' && args[2] === '-m' && args[3] === 'Ion local snapshot'
        && objectId.test(args[4]))) throw new Error('This Git stash operation is outside Ion Source Control.')
    return withProjectedRepository(repository, signal, (projected, environment, verifyMetadata) => {
      if (args[0] === 'stash') return invokeGit(projected, signal, args, options, environment)
      if (args[0] === 'add') return withIndexTransaction(repository.directory, signal, async indexFile => {
        const result = await invokeGit(projected, signal, args, { ...options, indexFile }, environment)
        await verifyMetadata()
        return result
      })
      return invokeGit(projected, signal, args, options, environment)
    }, args[0] === 'stash' ? 'stash' : 'workspace')
  }
  if (args[0] === 'blame') {
    const flags = ['--incremental', '--root', '--no-progress', '--no-ext-diff', '--no-textconv', '--ignore-revs-file', '']
    if (args.length !== 11 || flags.some((flag, i) => args[i + 1] !== flag)
      || !objectId.test(args[8]) || args[9] !== '--' || !safeGitPath(args[10])) throw new Error('Invalid committed blame request.')
    // Blame of a commit needs only the object database. Keep the live tree's .mailmap and attributes out of this read.
    return withProjectedRepository(repository, signal, (projected, environment) => invokeGit({ ...projected, root: projected.directory },
      signal, args, options, { ...environment, GIT_ATTR_NOSYSTEM: '1' }), 'committed-history')
  }
  if (!plumbingCommand(args, options.input)) throw new Error('This Git operation is outside Ion Source Control.')
  if (!options.indexFile && ['read-tree', 'update-index', 'restore', 'write-tree'].includes(args[0])) {
    return withIndexTransaction(repository.directory, signal, indexFile =>
      invokeGit(repository, signal, args, { ...options, indexFile }))
  }
  return invokeGit(repository, signal, args, options)
}

async function withProjectedRepository<T>(repository: Repository, signal: AbortSignal,
  run: (projected: Repository, environment: NodeJS.ProcessEnv, verifyMetadata: () => Promise<void>, configuration: string) => Promise<T>,
  view: 'workspace' | 'committed-history' | 'stash' = 'workspace') {
  const captured = await invokeGit(repository, signal, ['config', '--includes', '--show-scope', '--null', '--list'], { limit: 256 * 1024 })
  if (!captured.complete) throw new Error('Git returned incomplete configuration.')
  return withFrozenConfiguration(repository, captured.text, signal, (directory, environment, verifyMetadata) =>
    run({ ...repository, directory }, environment, verifyMetadata, captured.text), view)
}

export function browseRepository(repository: Repository, signal: AbortSignal) {
  return withProjectedRepository(repository, signal, (projected, environment, _verify, configuration) => browseLocalRefs(async args => {
    signal.throwIfAborted()
    return invokeGit(projected, signal, args, { limit: 128 * 1024, allowTruncation: true }, environment)
  }, commonGitDirectory(repository), reviewedRemotes(configuration)))
}

/** Recheck only the reviewed public remote and exact cached branch before a fetch. */
export function verifyFetchSelection(repository: Repository, signal: AbortSignal,
  selection: { repository: string; remote: string; branch: string; previous: string }): Promise<boolean> {
  return withProjectedRepository(repository, signal, async (projected, environment, _verify, configuration) => {
    const remotes = reviewedRemotes(configuration).remotes
    if (!remotes.some(row => row.name === selection.remote && row.repository === selection.repository)) return false
    const ref = selection.remote + '/' + selection.branch
    return verifyCachedRemoteBranch(async args => {
      signal.throwIfAborted()
      return invokeGit(projected, signal, args, { limit: 4096 }, environment)
    }, commonGitDirectory(repository), ref, selection.previous)
  })
}

export async function compareRepository(repository: Repository, signal: AbortSignal, request: SourceControlComparisonRequest) {
  const { compareTrees, verifyComparisonRefs } = await import('./comparison')
  const common = commonGitDirectory(repository)
  const read = (projected: Repository, environment: NodeJS.ProcessEnv) => (args: string[]) => {
    signal.throwIfAborted()
    const paths = args[0] === 'diff-tree'
    return invokeGit(projected, signal, args, { limit: paths ? 128 * 1024 : 4096, allowTruncation: paths,
      allowNotFound: args[0] === 'merge-base' }, environment)
  }
  const result = await withProjectedRepository(repository, signal, (projected, env) => compareTrees(request, read(projected, env), common))
  // HEAD and packed-refs are copied into each frozen view. Reopen them after the diff so a concurrent
  // checkout, deletion, repack or stash update cannot be mistaken for the reviewed identities.
  await withProjectedRepository(repository, signal, (projected, env) => verifyComparisonRefs(request, read(projected, env), common))
  return result
}

async function invokeGit(repository: Repository, signal: AbortSignal, args: string[], options: GitOptions = {},
  environment: NodeJS.ProcessEnv = {}) {
  const result = await execute(repository.executable, [
    ...gitOptions, ...(args[0] === 'blame' ? ['-c', 'mailmap.file=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c', 'mailmap.blob=', '-c', 'core.attributesFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null')] : []), ...(options.indexFile ? ['-c', 'core.splitIndex=false'] : []),
    '--git-dir=' + repository.directory, '--work-tree=' + repository.root, ...args,
  ], {
    cwd: repository.root, input: options.input ?? '', signal, timeoutMs: options.timeout ?? 8000,
    budget: { remaining: options.limit ?? 8192 }, splitOutput: true, collectOutput: false,
    environment: { ...envFor(repository.paths, tmpdir()), LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
      ...environment,
      ...(options.indexFile && { GIT_INDEX_FILE: options.indexFile }) },
  })
  signal.throwIfAborted()
  // Registry diagnostics may contain paths or indicate an omitted registration, even on a successful exit.
  if (args[0] === 'worktree' && (result.stderr || result.state !== 'exited' || result.exitCode !== 0)) {
    throw new Error('Git could not verify the registered worktrees.')
  }
  if (result.state === 'output-limit') {
    if (options.allowTruncation) return { text: result.stdout ?? '', complete: false }
    if (args[0] === 'cat-file') throw new UnavailableDiff('This file exceeds the text preview limit.')
    throw new Error('Git output exceeded the operation limit.')
  }
  if (result.state === 'exited' && (result.exitCode === 0 || options.allowNotFound && result.exitCode === 1)) {
    return { text: result.stdout ?? '', complete: result.outputComplete !== false }
  }
  if (result.state === 'timeout') throw new Error('Git took too long. Try again or use a terminal for this repository.')
  if (args[0] === 'show-ref') throw new Error('The selected Git references changed or could not be verified. Refresh the repository browser.')
  // Git diagnostics from repository inspection can quote unredacted configuration values.
  if (['config', 'status', 'log', 'for-each-ref', 'merge-base', 'rev-list', 'rev-parse', 'diff-tree', 'blame', 'ls-tree', 'ls-files', 'cat-file'].includes(args[0])) throw new Error('Git could not read the repository information.')
  const detail = result.stderr?.trim().slice(0, 360)
  throw new Error(detail || result.detail || 'Git could not complete the operation.')
}
