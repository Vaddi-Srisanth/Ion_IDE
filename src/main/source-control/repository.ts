import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { commandPaths, envFor, onPath } from '../run-console/plans'
import { execute } from '../runner'

export function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isAbsolute(fromRoot)
}

export function absent(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export class UnavailableDiff extends Error {}

export async function readTextFile(path: string, maxBytes: number): Promise<string> {
  const before = await lstat(path)
  if (!before.isFile()) throw new UnavailableDiff('This path is not a regular file.')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new UnavailableDiff('The file changed before it could be opened.')
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
  '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never',
]

export async function git(repository: Repository, signal: AbortSignal, args: string[], options: {
  limit?: number; input?: string; timeout?: number; allowTruncation?: boolean; allowNotFound?: boolean; indexFile?: string
} = {}) {
  const result = await execute(repository.executable, [
    ...gitOptions, ...(options.indexFile ? ['-c', 'core.splitIndex=false'] : []),
    '--git-dir=' + repository.directory, '--work-tree=' + repository.root, ...args,
  ], {
    cwd: repository.root, input: options.input ?? '', signal, timeoutMs: options.timeout ?? 8000,
    budget: { remaining: options.limit ?? 8192 }, splitOutput: true, collectOutput: false,
    environment: { ...envFor(repository.paths, tmpdir()), LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
      ...(options.indexFile && { GIT_INDEX_FILE: options.indexFile }) },
  })
  signal.throwIfAborted()
  if (result.state === 'output-limit') {
    if (options.allowTruncation) return { text: result.stdout ?? '', complete: false }
    if (args[0] === 'cat-file') throw new UnavailableDiff('This file exceeds the text preview limit.')
    throw new Error('Git output exceeded the operation limit.')
  }
  if (result.state === 'exited' && (result.exitCode === 0 || options.allowNotFound && result.exitCode === 1)) {
    return { text: result.stdout ?? '', complete: result.outputComplete !== false }
  }
  const detail = result.stderr?.trim().slice(0, 360)
  if (result.state === 'timeout') throw new Error('Git took too long. Try again or use a terminal for this repository.')
  throw new Error(detail || result.detail || 'Git could not complete the operation.')
}

/** Local config can run arbitrary executables through clean/process filters.
 * Installed global and system filters belong to the user's Git configuration. */
export async function checkRepositoryFilters(repository: Repository, signal: AbortSignal): Promise<void> {
  const { text } = await git(repository, signal, [
    'config', '--includes', '--show-scope', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$',
  ], { allowNotFound: true, limit: 32 * 1024 })
  const fields = text.split('\0')
  for (let index = 0; index < fields.length - 1; index += 2) {
    if (fields[index] === 'local' || fields[index] === 'worktree') {
      throw new Error('This repository configures a local Git filter. Use your terminal if you trust it.')
    }
  }
}
