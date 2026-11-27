import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { SourceControlBlame, SourceControlBrowse, SourceControlComparison, SourceControlConflict, SourceControlDiff,
  SourceControlEntry, SourceControlFetchRequest, SourceControlFetchResult, SourceControlGitHub, SourceControlGitHubCreatedPullRequest,
  SourceControlGitHubCreatePullRequestRequest, SourceControlGitHubIssue, SourceControlGitHubIssueRequest,
  SourceControlGitHubPullRequest, SourceControlGitHubPullRequestRequest,
  SourceControlMergeRequest, SourceControlStatus, SourceControlSwitchRequest } from '../../shared/source-control'
import type { FileMutations } from '../file-mutations'
import { commitReviewedChanges, gitObjectId } from './commit'
import { absent, browseRepository, compareRepository, git, gitDirectory, inside, readTextFile, resolveGit,
  type Repository, UnavailableDiff, verifyFetchSelection } from './repository'
import { parseStatus, safeGitPath, type ParsedStatus, type StatusEntry } from './status'
import { blob, checkLines, textLimit } from './text-preview'
import type { RemoteFetchDependencies } from './remote-fetch'

const statusLimit = 512 * 1024

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
  private activeBlame?: { path: string; controller: AbortController }
  private githubRead?: AbortController
  private githubCreate?: Promise<SourceControlGitHubCreatedPullRequest>
  private clone?: { controller: AbortController; done: Promise<string> }
  private write?: Promise<unknown>
  private writeController?: AbortController
  private snapshot?: Snapshot
  private reviewedRefs?: {
    root: string; head?: string; branches: Map<string, string>; cachedRemoteBranches: Map<string, string>
    remotes: Map<string, string | null>; stash?: string
  }

  constructor(private readonly runGit: typeof git = git, private readonly remoteFetchDependencies: RemoteFetchDependencies = {}) {}

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

  async browse(root: string): Promise<SourceControlBrowse> {
    if (this.write) throw new Error('Wait for the Git operation to finish.')
    const { repository } = this.requireSnapshot(root)
    const controller = this.beginRead()
    try {
      await this.verifyRepository(repository, controller.signal)
      const result = await browseRepository(repository, controller.signal)
      controller.signal.throwIfAborted()
      this.reviewedRefs = {
        root, head: result.commits[0]?.oid, branches: new Map(result.branches.map(ref => [ref.name, ref.oid])),
        cachedRemoteBranches: new Map(result.cachedRemoteBranches.map(ref => [ref.name, ref.oid])),
        remotes: new Map(result.remotes.map(remote => [remote.name, remote.repository])), stash: result.stash?.oid,
      }
      return result
    } finally {
      if (this.read === controller) this.read = undefined
    }
  }

  async previewComparison(root: string, value: unknown): Promise<SourceControlComparison> {
    if (this.write) throw new Error('Wait for the Git operation to finish.')
    const { repository } = this.requireSnapshot(root)
    const { kind, name, from, to } = requestObject(value)
    const reviewed = this.reviewedRefs
    const reviewedTo = typeof name !== 'string' ? undefined
      : kind === 'branch' ? reviewed?.branches.get(name)
      : kind === 'cached-remote-branch' ? reviewed?.cachedRemoteBranches.get(name)
      : kind === 'stash' && name === 'refs/stash' ? reviewed?.stash : undefined
    if (!reviewed || reviewed.root !== root || (kind !== 'branch' && kind !== 'cached-remote-branch' && kind !== 'stash')
      || typeof name !== 'string' || typeof from !== 'string' || !gitObjectId.test(from)
      || typeof to !== 'string' || !gitObjectId.test(to) || from !== reviewed.head || to !== reviewedTo) {
      throw new Error('Refresh the repository browser and choose a reviewed branch, cached remote branch, or stash.')
    }
    const controller = this.beginRead()
    try {
      await this.verifyRepository(repository, controller.signal)
      const result = await compareRepository(repository, controller.signal, { kind, name, from, to })
      await this.verifyRepository(repository, controller.signal)
      return result
    } finally {
      if (this.read === controller) this.read = undefined
    }
  }

  github(root: string, selected: unknown, workspaceRoots: readonly string[]): Promise<SourceControlGitHub> {
    return this.readGitHub(root, async signal => {
      const { githubOverview } = await import('./github')
      signal.throwIfAborted()
      return githubOverview(root, workspaceRoots, selected, signal)
    })
  }

  githubPullRequest(root: string, request: SourceControlGitHubPullRequestRequest,
    workspaceRoots: readonly string[]): Promise<SourceControlGitHubPullRequest> {
    return this.readGitHub(root, async signal => {
      const { githubPullRequest } = await import('./github')
      signal.throwIfAborted()
      return githubPullRequest(root, workspaceRoots, request, signal)
    })
  }

  githubIssue(root: string, request: SourceControlGitHubIssueRequest,
    workspaceRoots: readonly string[]): Promise<SourceControlGitHubIssue> {
    return this.readGitHub(root, async signal => {
      const { githubIssue } = await import('./github')
      signal.throwIfAborted()
      return githubIssue(root, workspaceRoots, request, signal)
    })
  }

  githubSignIn(root: string, workspaceRoots: readonly string[], onDeviceCode: (code: string) => void): Promise<boolean> {
    if (this.githubCreate) throw new Error('Wait for the GitHub pull request request to finish.')
    const { repository } = this.requireSnapshot(root)
    this.githubRead?.abort()
    const controller = new AbortController()
    this.githubRead = controller
    return this.verifyRepository(repository, controller.signal).then(async () => {
      const { githubSignIn } = await import('./github')
      return githubSignIn(root, workspaceRoots, controller.signal, onDeviceCode)
    }).finally(() => { if (this.githubRead === controller) this.githubRead = undefined })
  }

  githubSignOut(root: string, account: string, workspaceRoots: readonly string[]): Promise<boolean> {
    if (this.githubCreate) throw new Error('Wait for the GitHub pull request request to finish.')
    const { repository } = this.requireSnapshot(root)
    this.githubRead?.abort()
    const controller = new AbortController()
    this.githubRead = controller
    return this.verifyRepository(repository, controller.signal).then(async () => {
      const { githubSignOut } = await import('./github')
      return githubSignOut(root, workspaceRoots, account, controller.signal)
    }).finally(() => { if (this.githubRead === controller) this.githubRead = undefined })
  }

  createGitHubPullRequest(root: string, request: SourceControlGitHubCreatePullRequestRequest,
    workspaceRoots: readonly string[]): Promise<SourceControlGitHubCreatedPullRequest> {
    if (this.githubCreate) throw new Error('A GitHub pull request is already being created.')
    const { repository } = this.requireSnapshot(root)
    this.githubRead?.abort()
    const controller = new AbortController()
    const result = this.verifyRepository(repository, controller.signal).then(async () => {
      const { createGitHubPullRequest } = await import('./github')
      return createGitHubPullRequest(root, workspaceRoots, request, controller.signal)
    }).finally(() => { this.githubCreate = undefined })
    this.githubCreate = result
    return result
  }

  private async readGitHub<T>(root: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.githubCreate) throw new Error('Wait for the GitHub pull request request to finish.')
    const { repository } = this.requireSnapshot(root)
    this.githubRead?.abort()
    const controller = new AbortController()
    this.githubRead = controller
    try {
      await this.verifyRepository(repository, controller.signal)
      const result = await operation(controller.signal)
      controller.signal.throwIfAborted()
      return result
    } finally {
      if (this.githubRead === controller) this.githubRead = undefined
    }
  }

  closeGitHub(): void {
    this.githubRead?.abort()
    this.githubRead = undefined
    this.clone?.controller.abort()
  }

  cloneGitHub(root: string, selected: unknown, access: 'public' | 'authenticated', parent: string,
    workspaceRoots: readonly string[], mutations: FileMutations): Promise<string> {
    const { repository } = this.requireSnapshot(root)
    if (this.clone) throw new Error('A GitHub clone is already running.')
    const controller = new AbortController()
    const done = this.verifyRepository(repository, controller.signal).then(async () => {
      const { cloneGitHub } = await import('./clone')
      controller.signal.throwIfAborted()
      return cloneGitHub(selected, access, parent, root, workspaceRoots, controller.signal, { mutations })
    }).finally(() => { this.clone = undefined })
    this.clone = { controller, done }
    return done
  }

  createBranch(root: string, value: unknown) { return this.createRef(root, value, 'branch') }
  createTag(root: string, value: unknown) { return this.createRef(root, value, 'tag') }

  switchBranch(root: string, value: unknown,
    approve: (review: SourceControlSwitchRequest, signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    const { repository, status } = this.requireSnapshot(root)
    const request = requestObject(value)
    if (Array.isArray(value) || Object.keys(request).length !== 4
      || !['current', 'target', 'from', 'to'].every(key => Object.hasOwn(request, key))) {
      throw new Error('Choose a reviewed local branch.')
    }
    const { current, target, from, to } = request
    const refs = this.reviewedRefs
    if (!refs || refs.root !== root || status.detached || status.unborn || status.truncated || typeof current !== 'string'
      || typeof from !== 'string' || !gitObjectId.test(from) || from !== status.head || from !== refs.head
      || current !== status.branch || typeof target !== 'string' || target === current
      || typeof to !== 'string' || !gitObjectId.test(to) || refs.branches.get(target) !== to) {
      throw new Error('Refresh the repository browser and choose a reviewed local branch.')
    }
    const review = { current, target, from, to }
    return this.mutate(async signal => {
      await this.verifyRepository(repository, signal)
      if (!await approve(review, signal)) return false
      await this.verifyRepository(repository, signal)
      const { switchBranchAtSameTree } = await import('./switch-branch')
      await switchBranchAtSameTree(repository, signal, review, this.runGit)
      this.reviewedRefs = undefined
      return true
    })
  }

  mergeBranch(root: string, value: unknown,
    approve: (review: SourceControlMergeRequest, signal: AbortSignal) => Promise<boolean>): Promise<{ applied: boolean; conflicts: boolean } | null> {
    const { repository, status } = this.requireSnapshot(root)
    const request = requestObject(value)
    if (Array.isArray(value) || Object.keys(request).length !== 6
      || !['current', 'target', 'from', 'to', 'targetKind', 'dirtyPaths'].every(key => Object.hasOwn(request, key))) {
      throw new Error('Choose a reviewed local branch to merge.')
    }
    const { current, target, from, to, targetKind, dirtyPaths } = request
    const refs = this.reviewedRefs
    if (!refs || refs.root !== root || status.detached || status.unborn || status.truncated || status.entries.size
      || typeof current !== 'string' || current !== status.branch || typeof from !== 'string' || from !== status.head
      || !gitObjectId.test(from) || from !== refs.head || typeof target !== 'string' || target === current
      || (targetKind !== 'local' && targetKind !== 'cached-remote')
      || typeof to !== 'string' || !gitObjectId.test(to) || (targetKind === 'local'
        ? refs.branches.get(target) !== to : refs.cachedRemoteBranches.get(target) !== to)
      || !Array.isArray(dirtyPaths) || dirtyPaths.length > 512
      || dirtyPaths.some(path => typeof path !== 'string' || !isAbsolute(path) || !inside(repository.root, path))) {
      throw new Error('Refresh and choose a reviewed branch in a clean repository.')
    }
    if (dirtyPaths.length) throw new Error('Save or close modified editor files before merging a branch.')
    const review: SourceControlMergeRequest = { current, target, from, to, targetKind, dirtyPaths: [] }
    return this.mutate(async signal => {
      await this.verifyRepository(repository, signal)
      const before = await statusOf(repository, signal)
      const browser = await browseRepository(repository, signal)
      if (before.head !== from || before.branch !== current || before.truncated || before.entries.size
        || (targetKind === 'local' ? browser.branches : browser.cachedRemoteBranches).find(branch => branch.name === target)?.oid !== to) {
        throw new Error('The repository or selected branch changed. Refresh and review again.')
      }
      for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']) {
        const found = await lstat(join(repository.directory, name)).then(() => true, (error: unknown) => {
          if (absent(error)) return false
          throw error
        })
        if (found) throw new Error('Finish the active Git operation in your terminal before merging from Ion.')
      }
      if (!await approve(review, signal)) return null
      await this.verifyRepository(repository, signal)
      const currentStatus = await statusOf(repository, signal)
      const currentBrowser = await browseRepository(repository, signal)
      if (currentStatus.head !== from || currentStatus.branch !== current || currentStatus.truncated || currentStatus.entries.size
        || (targetKind === 'local' ? currentBrowser.branches : currentBrowser.cachedRemoteBranches).find(branch => branch.name === target)?.oid !== to) {
        throw new Error('The repository or selected branch changed during review. Refresh and try again.')
      }
      await git(repository, signal, ['merge', '--no-commit', '--no-ff', '--no-edit', '--no-progress', '--no-stat', '--strategy=ort', to],
        { allowNotFound: true })
      const after = await statusOf(repository, signal)
      const conflicts = [...after.entries.values()].some(entry => entry.unmerged)
      const mergePending = await lstat(join(repository.directory, 'MERGE_HEAD')).then(() => true, (error: unknown) => {
        if (absent(error)) return false
        throw error
      })
      if (after.head !== from || after.branch !== current) throw new Error('Git changed the active branch unexpectedly. Inspect the repository before continuing.')
      this.reviewedRefs = undefined
      return { applied: mergePending, conflicts }
    })
  }

  fetchGitHub(root: string, value: unknown, workspaceRoots: readonly string[], mutations: FileMutations,
    approve: (review: SourceControlFetchRequest, signal: AbortSignal) => Promise<boolean>): Promise<SourceControlFetchResult | null> {
    const { repository } = this.requireSnapshot(root)
    const request = requestObject(value)
    if (Array.isArray(value) || Object.keys(request).length !== 5
      || !['repository', 'remote', 'branch', 'previous', 'access'].every(key => Object.hasOwn(request, key))) {
      throw new Error('Choose a reviewed cached branch on a GitHub remote.')
    }
    const { repository: slug, remote, branch, previous, access } = request
    if (access !== 'public' && access !== 'authenticated') throw new Error('Choose public or signed-in GitHub access.')
    const refs = this.reviewedRefs
    if (!refs || refs.root !== root || typeof slug !== 'string' || typeof remote !== 'string'
      || refs.remotes.get(remote) !== slug || typeof branch !== 'string' || typeof previous !== 'string'
      || !gitObjectId.test(previous) || refs.cachedRemoteBranches.get(remote + '/' + branch) !== previous) {
      throw new Error('Refresh the repository browser and choose a cached branch on a reviewed GitHub remote.')
    }
    // Ref names may include slashes. Refuse a cached name that could belong to a more specific configured remote.
    if ([...refs.remotes.keys()].some(name => name.length > remote.length && (remote + '/' + branch).startsWith(name + '/'))) {
      throw new Error('This cached Git branch has an ambiguous remote name.')
    }
    const review: SourceControlFetchRequest = { repository: slug, remote, branch, previous, access }
    return this.mutate(async signal => {
      const validate = async () => {
        await this.verifyRepository(repository, signal)
        if (!await verifyFetchSelection(repository, signal, review)) {
          throw new Error('The cached branch or remote changed. Refresh and review it again.')
        }
      }
      if (!await approve(review, signal)) return null
      const { fetchGitHubBranch } = await import('./remote-fetch')
      const result = await fetchGitHubBranch(repository, workspaceRoots, review, signal, validate, mutations, this.remoteFetchDependencies)
      this.reviewedRefs = undefined
      return result
    }, { preserveSnapshot: true })
  }

  saveStashSnapshot(root: string, approve: (review: { branch: string; head: string; files: number }, signal: AbortSignal) => Promise<boolean>): Promise<string | null> {
    const { repository, status } = this.requireSnapshot(root)
    const signature = (value: ParsedStatus) => JSON.stringify([value.head, value.branch, value.truncated,
      [...value.entries.values()].map(({ path, previousPath, index, worktree, unmerged, indexMode, indexObject }) =>
        [path, previousPath, index, worktree, unmerged, indexMode, indexObject])])
    const changed = [...status.entries.values()].filter(entry => entry.index || entry.worktree && entry.worktree !== '?')
    if (status.unborn || status.detached || status.truncated || !changed.length
      || [...status.entries.values()].some(entry => entry.unmerged)) {
      throw new Error('Refresh and resolve conflicts before saving a tracked-change stash snapshot.')
    }
    const review = { branch: status.branch, head: status.head, files: changed.length }
    return this.mutate(async signal => {
      await this.verifyRepository(repository, signal)
      const before = await statusOf(repository, signal)
      if (signature(before) !== signature(status)) throw new Error('Repository changes moved. Refresh and review them again.')
      if (!await approve(review, signal)) return null
      await this.verifyRepository(repository, signal)
      const current = await statusOf(repository, signal)
      if (signature(current) !== signature(status)) throw new Error('Repository changes moved during review. Refresh and try again.')
      const result = await this.runGit(repository, signal, ['stash', 'create'], { limit: 128 })
      const oid = result.text.trim()
      if (!gitObjectId.test(oid) || oid.length !== status.head.length) throw new Error('Git did not create a valid stash snapshot.')
      await this.runGit(repository, signal, ['stash', 'store', '-m', 'Ion local snapshot', oid], { limit: 256 })
      this.reviewedRefs = undefined
      return oid
    })
  }

  popStash(root: string, value: unknown, dirtyPaths: unknown,
    approve: (review: { branch: string; oid: string }, signal: AbortSignal) => Promise<boolean>): Promise<{ applied: boolean; conflicts: boolean } | null> {
    const request = requestObject(value)
    if (Array.isArray(value) || Object.keys(request).length !== 1 || !Object.hasOwn(request, 'oid')) {
      throw new Error('Choose the reviewed stash snapshot.')
    }
    const oid = request.oid
    const { repository, status } = this.requireSnapshot(root)
    const reviewed = this.reviewedRefs
    if (!reviewed || reviewed.root !== root || reviewed.stash !== oid || typeof oid !== 'string' || !gitObjectId.test(oid)
      || status.detached || status.unborn || status.truncated || status.entries.size || reviewed.head !== status.head) {
      throw new Error('Refresh and choose a reviewed stash in a clean repository.')
    }
    if (!Array.isArray(dirtyPaths) || dirtyPaths.length > 512
      || dirtyPaths.some(path => typeof path !== 'string' || !isAbsolute(path) || !inside(repository.root, path))) {
      throw new Error('The open editor state could not be verified. Save or close modified files and refresh.')
    }
    if (dirtyPaths.length) throw new Error('Save or close modified editor files before applying a stash.')
    const review = { branch: status.branch, oid }
    return this.mutate(async signal => {
      await this.verifyRepository(repository, signal)
      const before = await statusOf(repository, signal)
      const stashBefore = await browseRepository(repository, signal)
      if (before.head !== status.head || before.branch !== status.branch || before.truncated || before.entries.size
        || stashBefore.stash?.oid !== oid) throw new Error('The repository or selected stash changed. Refresh and review again.')
      if (!await approve(review, signal)) return null
      await this.verifyRepository(repository, signal)
      const current = await statusOf(repository, signal)
      const currentStash = await browseRepository(repository, signal)
      if (current.head !== status.head || current.branch !== status.branch || current.truncated || current.entries.size
        || currentStash.stash?.oid !== oid) throw new Error('The repository or selected stash changed during review. Refresh and try again.')
      await git(repository, signal, ['stash', 'pop', 'stash@{0}'], { allowNotFound: true })
      const after = await statusOf(repository, signal)
      const remaining = await browseRepository(repository, signal)
      this.reviewedRefs = undefined
      if ([...after.entries.values()].some(entry => entry.unmerged)) return { applied: false, conflicts: true }
      if (remaining.stash?.oid === oid) throw new Error('Git kept the stash without reporting merge conflicts. Refresh and inspect the repository.')
      return { applied: true, conflicts: false }
    })
  }

  private createRef(root: string, value: unknown, kind: 'branch' | 'tag'): Promise<void> {
    const { repository, status } = this.requireSnapshot(root)
    if (status.unborn || !gitObjectId.test(status.head) || requestObject(value).from !== status.head) {
      throw new Error('Refresh and review the current commit before creating a ' + kind + '.')
    }
    return this.mutate(async signal => {
      await this.verifyRepository(repository, signal)
      const { createLocalRef } = await import('./branches')
      signal.throwIfAborted()
      await createLocalRef(repository, signal, value, status.head, kind)
    }, { preserveSnapshot: true }) // Creating another ref leaves the reviewed HEAD, index and worktree intact.
  }

  async blame(root: string, value: unknown): Promise<SourceControlBlame> {
    const request = requestObject(value)
    if (Array.isArray(request) || Object.keys(request).length !== 1 || !Object.hasOwn(request, 'path')) throw new Error('Invalid blame request.')
    const path = requestPath(request.path)
    if (this.write) throw new Error('Wait for the Git operation to finish.')
    const { repository, status } = this.requireSnapshot(root)
    const controller = this.beginRead()
    this.activeBlame = { path, controller }
    try {
      await this.verifyRepository(repository, controller.signal)
      const { readBlame } = await import('./blame')
      return await readBlame(repository, path, status.head, controller.signal, this.runGit)
    } finally {
      if (this.activeBlame?.controller === controller) this.activeBlame = undefined
      if (this.read === controller) this.read = undefined
    }
  }

  cancelBlame(path: unknown): boolean {
    const active = this.activeBlame
    if (!active || active.path !== path || active.controller.signal.aborted) return false
    active.controller.abort()
    return true
  }

  async conflict(root: string, value: unknown): Promise<SourceControlConflict> {
    const path = requestPath(requestObject(value).path)
    if (this.write) throw new Error('Wait for the Git operation to finish.')
    const { repository, status } = this.requireSnapshot(root)
    const entry = status.entries.get(path)
    if (!entry?.unmerged) throw new Error('Refresh to review the current merge conflict.')
    const controller = this.beginRead()
    try {
      await this.verifyRepository(repository, controller.signal)
      const { readConflict } = await import('./conflict')
      controller.signal.throwIfAborted()
      const result = await readConflict(repository, entry, controller.signal, this.runGit)
      controller.signal.throwIfAborted()
      return result
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
      checkLines(original)
      checkLines(modified)
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

  async discardWorking(root: string, value: unknown, confirm: (review: { path: string; status: string; staged: boolean }) => Promise<boolean>): Promise<boolean> {
    const path = requestPath(requestObject(value).path)
    const { repository, status } = this.requireSnapshot(root)
    const entry = status.entries.get(path)
    if (!entry || !entry.worktree || entry.worktree === '?' || entry.unmerged || status.truncated || status.unborn) {
      throw new Error('Only a reviewed tracked, non-conflicted working change can be discarded.')
    }
    const initial = await this.workingFingerprint(repository, path)
    const approved = await confirm({ path, status: entry.worktree, staged: Boolean(entry.index) })
    if (!approved) return false
    await this.mutate(async signal => {
      await this.verifyRepository(repository, signal)
      const current = await statusOf(repository, signal)
      const now = current.entries.get(path)
      if (current.truncated || current.head !== status.head || current.branch !== status.branch
        || !now || now.worktree !== entry.worktree || now.index !== entry.index || now.unmerged
        || now.headMode !== entry.headMode || now.headObject !== entry.headObject
        || now.indexMode !== entry.indexMode || now.indexObject !== entry.indexObject) {
        throw new Error('The reviewed file or Git state changed. Refresh and review again.')
      }
      if (await this.workingFingerprint(repository, path) !== initial) {
        throw new Error('The reviewed file changed after confirmation. Refresh and review again.')
      }
      await git(repository, signal, ['restore', '--worktree', '--', path])
    })
    return true
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
    this.closeGitHub()
    this.writeController?.abort()
    this.read = undefined
    this.snapshot = undefined
    this.reviewedRefs = undefined
  }

  async drain(): Promise<void> {
    await Promise.all([this.write?.catch(() => {}), this.clone?.done.catch(() => {})])
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

  private async workingFingerprint(repository: Repository, path: string): Promise<string> {
    const absolute = join(repository.root, path)
    await fileWithin(repository, absolute)
    const info = await lstat(absolute).catch((error: unknown) => { if (absent(error)) return undefined; throw error })
    if (!info) return 'missing'
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) {
      throw new Error('Discard is limited to regular tracked files up to 32 MiB.')
    }
    const bytes = await readFile(absolute)
    const after = await lstat(absolute).catch((error: unknown) => { if (absent(error)) return undefined; throw error })
    if (!after?.isFile() || after.isSymbolicLink() || after.size !== info.size || after.mtimeMs !== info.mtimeMs
      || after.ino !== info.ino || bytes.length !== info.size) throw new Error('The file changed while it was being reviewed.')
    return createHash('sha256').update(bytes).digest('hex')
  }

  private mutate<T>(operation: (signal: AbortSignal) => Promise<T>, { preserveSnapshot = false } = {}): Promise<T> {
    if (this.write) throw new Error('Another Git operation is running.')
    this.read?.abort()
    const current = this.snapshot
    const controller = new AbortController()
    this.writeController = controller
    const pending = operation(controller.signal).then(result => {
      if (!preserveSnapshot && result !== false && result !== null && this.snapshot === current) this.snapshot = undefined
      return result
    }).finally(() => {
      this.write = undefined
      this.writeController = undefined
    })
    this.write = pending
    return pending
  }
}

export { gitDirectory } from './repository'
