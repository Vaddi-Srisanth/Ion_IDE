import { lstat, opendir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { git, type Repository } from './repository'

const limit = 256
const incomplete = 'Git could not verify the registered worktrees.'

export function sameWorktreePath(left: string, right: string, platform = process.platform): boolean {
  if (platform === 'win32') {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
  }
  return resolve(left) === resolve(right)
}

async function registeredCount(repository: Repository, signal: AbortSignal): Promise<number> {
  const primary = !relative(join(repository.root, '.git'), repository.directory)
  const common = primary ? repository.directory : dirname(dirname(repository.directory))
  const registry = join(common, 'worktrees')
  // Git may omit a malformed entry entirely. Compare its output against the
  // bounded count of actual administration directories, including the primary.
  let count = 1
  try {
    const stat = await lstat(registry).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!stat) return count
    if (!stat.isDirectory()) throw new Error(incomplete)
    for await (const entry of await opendir(registry)) {
      signal.throwIfAborted()
      if (!entry.isDirectory() || ++count > limit) throw new Error(incomplete)
    }
  } catch {
    signal.throwIfAborted()
    throw new Error(incomplete)
  }
  return count
}

function branchKey(ref: string): string {
  // An unborn ref has no file to resolve. Treat case and Unicode normalization
  // aliases conservatively on platforms that commonly use insensitive volumes.
  return process.platform === 'win32' || process.platform === 'darwin' ? ref.normalize('NFC').toLowerCase() : ref
}

export async function verifyBranchUnoccupied(repository: Repository, signal: AbortSignal, ref: string, oidLength: number) {
  const count = await registeredCount(repository, signal)
  const result = await git(repository, signal, ['worktree', 'list', '--porcelain', '-z'], { limit: 128 * 1024 })
  if (!result.complete || !result.text.endsWith('\0\0') || result.text.includes('\uFFFD')) throw new Error(incomplete)

  const records = result.text.slice(0, -2).split('\0\0')
  if (records.length !== count) throw new Error(incomplete)
  const paths = new Set<string>()
  const target = branchKey(ref)
  for (const [index, record] of records.entries()) {
    const [location, head, state, ...extra] = record.split('\0')
    if (!location.startsWith('worktree ') || !isAbsolute(location.slice(9))) throw new Error(incomplete)
    const path = relative(repository.root, location.slice(9))
    if (paths.has(path)) throw new Error(incomplete)
    paths.add(path)
    if (index === 0 && head === 'bare' && state === undefined) continue
    if (!head?.startsWith('HEAD ') || head.length !== oidLength + 5 || !/^[0-9a-f]+$/.test(head.slice(5))) {
      throw new Error(incomplete)
    }
    // Prunable registrations, unknown attributes and contradictory states
    // cannot establish that a branch is free. A locked worktree still counts.
    if (extra.length && (extra.length !== 1 || !(extra[0] === 'locked' || extra[0].startsWith('locked ')))) {
      throw new Error(incomplete)
    }
    if (state === 'detached' && !/^0+$/.test(head.slice(5))) continue
    if (!state?.startsWith('branch refs/heads/')) throw new Error(incomplete)
    const branch = state.slice('branch '.length)
    if (/[\x00-\x20\x7f~^:?*\[\\]/u.test(branch) || branch.includes('..') || branch.includes('@{')
      || branch.endsWith('.') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
      throw new Error(incomplete)
    }
    const occupied = branchKey(branch)
    if (target === occupied || target.startsWith(occupied + '/') || occupied.startsWith(target + '/')) {
      throw new Error('A registered worktree already uses this branch name. Choose another name.')
    }
  }
  if (!paths.has('')) throw new Error(incomplete)
}

/** Branch switching only changes HEAD today, so keep it to the one ordinary checkout Ion can fully observe. */
export async function verifySingleWorktree(repository: Repository, signal: AbortSignal, ref: string, oid: string): Promise<void> {
  if (relative(join(repository.root, '.git'), repository.directory)) {
    throw new Error('Switch branches from the primary repository, not a linked worktree.')
  }
  if (await registeredCount(repository, signal) !== 1) {
    throw new Error('Branch switching is unavailable while this repository has linked worktrees.')
  }
  const result = await git(repository, signal, ['worktree', 'list', '--porcelain', '-z'], { limit: 128 * 1024 })
  if (!result.complete || !result.text.endsWith('\0\0')) throw new Error(incomplete)
  const records = result.text.slice(0, -2).split('\0\0')
  if (records.length !== 1) throw new Error('Branch switching is unavailable while this repository has linked worktrees.')
  const [location, head, branch, ...extra] = records[0].split('\0')
  if (!location?.startsWith('worktree ') || !sameWorktreePath(location.slice('worktree '.length), repository.root)
    || !head?.startsWith('HEAD ')
    || head !== 'HEAD ' + oid || branch !== 'branch ' + ref || extra.length) {
    throw new Error(incomplete)
  }
}
