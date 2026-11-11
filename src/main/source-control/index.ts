import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { SourceControlDiff, SourceControlEntry, SourceControlStatus } from '../../shared/source-control'
import { commitReviewedChanges, gitObjectId } from './commit'
import { absent, git, gitDirectory, inside, readTextFile, resolveGit,
  type Repository, UnavailableDiff } from './repository'
import { parseStatus, safeGitPath, type ParsedStatus, type StatusEntry } from './status'

const textLimit = 256 * 1024
const statusLimit = 512 * 1024
const regularMode = /^100[0-7]{3}$/
const lineLimit = 12_000

function exceedsLineLimit(text: string): boolean {
  let offset = -1
  for (let line = 1; line <= lineLimit; line++) {
    offset = text.indexOf('\n', offset + 1)
    if (offset < 0) return false
  }
  return true
}

async function statusOf(repository: Repository, signal: AbortSignal): Promise<ParsedStatus> {
  const { text, complete } = await git(repository, signal, [
    'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty', '--find-renames=50%',
  ], { limit: statusLimit, allowTruncation: true })
  const result = parseStatus(repository.root, text, complete)
  if (!result.head || !result.branch) throw new Error('Git returned an incomplete repository status.')
  return result
}

function requestObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Invalid Source Control request.')
  return value as Record<string, unknown>
}

function requestPath(value: unknown): string {
  if (typeof value !== 'string' || !safeGitPath(value)) throw new Error('Invalid Git path.')
  return value
}

async function fileWithin(repository: Repository, path: string): Promise<void> {
  let parent = dirname(path)
  while (inside(repository.root, parent)) {
    const actual = await realpath(parent).catch((error: unknown) => {
      if (absent(error)) return undefined
      throw error
    })
    if (actual) {
      if (relative(parent, actual)) throw new Error('This file is reached through a symbolic link.')
      return
    }
    if (!relative(repository.root, parent)) break
    parent = dirname(parent)
  }
  throw new Error('This file is outside the open repository.')
}

async function blob(repository: Repository, signal: AbortSignal, mode?: string, object?: string): Promise<string> {
  if (!mode || mode === '000000') return ''
  if (!regularMode.test(mode)) throw new UnavailableDiff('Symlinks and Git links do not have a text preview.')
  if (!object || !gitObjectId.test(object)) throw new Error('Git returned an invalid object identifier.')
  const { text } = await git(repository, signal, ['cat-file', 'blob', object], { limit: textLimit })
  if (text.includes('\0') || text.includes('\uFFFD')) throw new UnavailableDiff('This Git object is not UTF-8 text.')
  return text
}

const stagedEntry = (entry: StatusEntry) => Boolean(entry.index)

function stagedIdentity(status: ParsedStatus) {
  const entries = [...status.entries.values()].filter(stagedEntry)
  return JSON.stringify([status.head, status.branch, entries.map(({ path, previousPath, index, indexMode, indexObject }) =>
    [path, previousPath, index, indexMode, indexObject])])
}

interface Snapshot {
  repository: Repository
  status: ParsedStatus
}

export class SourceControlService {
  private read?: AbortController
  private write?: Promise<void>
  private writeController?: AbortController
  private snapshot?: Snapshot

  constructor(private readonly runGit: typeof git = git) {}

  async status(root: string): Promise<SourceControlStatus> {
    const controller = this.beginRead()
    try {
      await this.write?.catch(() => {})
      controller.signal.throwIfAborted()
      const directory = await gitDirectory(root)
      controller.signal.throwIfAborted()
      if (!directory) {
        this.snapshot = undefined
        return { kind: 'none', message: 'Open the root folder of a Git repository to see its changes.' }
      }
      const existing = this.snapshot?.repository
      const tool = existing?.root === root && existing.directory === directory ? existing : await resolveGit(root, controller.signal)
      controller.signal.throwIfAborted()
      if (!tool) return { kind: 'missing', message: 'Install Git and reopen Ion to use Source Control.' }
      const repository: Repository = { root, directory, executable: tool.executable, paths: tool.paths }
      const status = await statusOf(repository, controller.signal)
      controller.signal.throwIfAborted()
      this.snapshot = { repository, status }
      const entries = [...status.entries.values()].map(({ path, absolutePath, previousPath, index, worktree, unmerged }):
        SourceControlEntry => ({ path, absolutePath, previousPath, index, worktree, unmerged }))
      return { kind: 'repository', root, branch: status.branch, detached: status.detached, unborn: status.unborn,
        truncated: status.truncated, entries }
    } finally {
      if (this.read === controller) this.read = undefined
    }
  }

  async diff(root: string, value: unknown): Promise<SourceControlDiff> {
    const request = requestObject(value)
    const path = requestPath(request.path)
    const { side } = request
    if (side !== 'working' && side !== 'staged') throw new Error('Choose a staged or working tree diff.')
    if (this.write) throw new Error('Wait for the Git operation to finish.')
    const { repository, status } = this.requireSnapshot(root)
    const entry = status.entries.get(path)
    if (!entry || !(side === 'staged' ? entry.index : entry.worktree)) throw new Error('Refresh to review current changes.')
    const identity = { path, absolutePath: entry.absolutePath, previousPath: entry.previousPath, side } as const
    if (entry.unmerged) return { ...identity, kind: 'unavailable', message: 'Resolve this conflict before opening a two-way diff.' }
    const controller = this.beginRead()
    const signal = controller.signal
    try {
      await this.verifyRepository(repository, signal)
      let original: string
      let modified: string
      if (side === 'staged') {
        original = entry.index === 'A' ? '' : await blob(repository, signal, entry.headMode, entry.headObject)
        modified = await blob(repository, signal, entry.indexMode, entry.indexObject)
      } else {
        original = await blob(repository, signal, entry.indexMode, entry.indexObject)
        modified = ''
        if (entry.worktree !== 'D') {
          await fileWithin(repository, entry.absolutePath)
          modified = await readTextFile(entry.absolutePath, textLimit)
        }
      }
      signal.throwIfAborted()
      if (exceedsLineLimit(original) || exceedsLineLimit(modified)) {
        throw new UnavailableDiff('This file exceeds the 12,000-line preview limit.')
      }
      return { ...identity, kind: 'text', original, modified }
    } catch (error) {
      if (error instanceof UnavailableDiff) return { ...identity, kind: 'unavailable', message: error.message }
      if (absent(error)) return { ...identity, kind: 'unavailable', message: 'The file moved or was removed. Refresh changes.' }
      throw error
    } finally {
      if (this.read === controller) this.read = undefined
    }
  }

  change(root: string, value: unknown): Promise<void> {
    const request = requestObject(value)
    const path = requestPath(request.path)
    const { action } = request
    if (action !== 'stage' && action !== 'unstage') throw new Error('Choose Stage or Unstage.')
    const { repository, status } = this.requireSnapshot(root)
    const entry = status.entries.get(path)
    if (!entry || !(action === 'stage' ? entry.worktree : entry.index)) throw new Error('Refresh to review current changes.')
    if (entry.unmerged && action === 'unstage') throw new Error('Resolve this conflict before unstaging.')
    return this.mutate(async (signal) => {
      await this.verifyRepository(repository, signal)
      const code = action === 'stage' ? entry.worktree : entry.index
      const paths = code === 'R' && entry.previousPath ? [path, entry.previousPath] : [path]
      if (action === 'stage') {
        for (const name of paths) {
          const absolute = join(repository.root, name)
          await fileWithin(repository, absolute)
          const entry = await lstat(absolute).catch((error: unknown) => {
            if (absent(error)) return undefined
            throw error
          })
          if (entry && !entry.isFile() && !entry.isSymbolicLink()) throw new Error('Stage files individually from their repository.')
        }
        await git(repository, signal, ['add', '-A', '--', ...paths])
      } else {
        const current = await statusOf(repository, signal)
        if (current.head !== status.head || current.branch !== status.branch) throw new Error('The branch changed. Refresh and try again.')
        if (status.unborn) await git(repository, signal, ['update-index', '--force-remove', '--', ...paths])
        else await git(repository, signal, ['restore', '--staged', '--source=HEAD', '--', ...paths])
      }
    })
  }

  commit(root: string, value: unknown): Promise<void> {
    const request = requestObject(value)
    const { message } = request
    if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 4096 || message.includes('\0')) {
      throw new Error('Enter a commit message up to 4 KiB.')
    }
    const { repository, status } = this.requireSnapshot(root)
    const entries = [...status.entries.values()]
    if (status.truncated || entries.some(({ unmerged }) => unmerged) || !entries.some(stagedEntry)) {
      throw new Error('Review the complete staged changes and resolve any conflicts before committing.')
    }
    return this.mutate(async (signal) => {
      await this.verifyRepository(repository, signal)
      const current = await statusOf(repository, signal)
      if (current.truncated || [...current.entries.values()].some(({ unmerged }) => unmerged)
        || stagedIdentity(current) !== stagedIdentity(status)) {
        throw new Error('Staged changes or the branch changed. Refresh and review before committing.')
      }
      await commitReviewedChanges(repository, status, message, signal, this.runGit)
    })
  }

  close(): void {
    this.read?.abort()
    this.writeController?.abort()
    this.read = undefined
    this.snapshot = undefined
  }

  async drain(): Promise<void> {
    await this.write?.catch(() => {})
  }

  private beginRead(): AbortController {
    this.read?.abort()
    const controller = new AbortController()
    this.read = controller
    return controller
  }

  private requireSnapshot(root: string): Snapshot {
    const current = this.snapshot
    if (!current || current.repository.root !== root) throw new Error('Refresh to review current changes.')
    return current
  }

  private async verifyRepository(repository: Repository, signal: AbortSignal): Promise<void> {
    const actual = await gitDirectory(repository.root)
    signal.throwIfAborted()
    if (!actual || relative(actual, repository.directory)) throw new Error('The repository moved. Refresh before continuing.')
  }

  private mutate(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.write) throw new Error('Another Git operation is running.')
    this.read?.abort()
    const current = this.snapshot
    const controller = new AbortController()
    this.writeController = controller
    const pending = operation(controller.signal).then(() => {
      if (this.snapshot === current) this.snapshot = undefined
    }).finally(() => {
      this.write = undefined
      this.writeController = undefined
    })
    this.write = pending
    return pending
  }
}
