export type GitStatusCode = '' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'
export type GitDiffSide = 'staged' | 'working'

export interface SourceControlEntry {
  path: string
  absolutePath: string
  previousPath?: string
  index: GitStatusCode
  worktree: GitStatusCode
  unmerged: boolean
}

export type SourceControlStatus =
  | { kind: 'none' | 'missing' | 'untrusted'; message: string }
  | { kind: 'repository'; root: string; branch: string; detached: boolean; unborn: boolean
      entries: SourceControlEntry[]; truncated: boolean }

export interface SourceControlDiffRequest {
  path: string
  side: GitDiffSide
}

export type SourceControlDiff = SourceControlDiffRequest & Pick<SourceControlEntry, 'absolutePath' | 'previousPath'> & (
  | { kind: 'text'; original: string; modified: string }
  | { kind: 'unavailable'; message: string }
)

export interface SourceControlChangeRequest {
  path: string
  action: 'stage' | 'unstage'
}

export interface SourceControlDiscardRequest { path: string }

export interface SourceControlConflict {
  path: string
  absolutePath: string
  base: string | null
  ours: string | null
  theirs: string | null
}

export interface SourceControlBlame {
  path: string
  head: string
  ranges: { start: number; count: number; oid: string; author: string; time: number; subject: string }[]
  truncated: boolean
}

export interface SourceControlComparisonRequest {
  kind: 'branch' | 'cached-remote-branch' | 'stash'
  name: string
  from: string
  to: string
}
export interface SourceControlComparison {
  from: string
  to: string
  relation: 'same' | 'ahead' | 'behind' | 'diverged' | 'stash'
  changes: { path: string; status: 'A' | 'M' | 'D' | 'T' }[]
  truncated: boolean
  includesUntrackedParent: boolean
}

export interface SourceControlBrowse {
  stash: { oid: string } | null
  commits: { oid: string; subject: string; author: string; time: number }[]
  branches: { name: string; oid: string }[]
  cachedRemoteBranches: { name: string; oid: string }[]
  tags: { name: string; oid: string }[]
  remotes: { name: string; repository: string | null }[]
  truncated: boolean
}

export interface SourceControlGitHub {
  repository: string
  login: string
  pullRequests: { number: number; title: string; url: string }[]
  issues: { number: number; title: string; url: string }[]
}

export interface SourceControlGitHubAuthEvent {
  kind: 'device-code'
  code: string
}

export interface SourceControlSwitchRequest {
  current: string
  target: string
  from: string
  to: string
}

export interface SourceControlFetchRequest {
  repository: string
  remote: string
  branch: string
  previous: string
  access: 'public' | 'authenticated'
}

export interface SourceControlFetchResult {
  oid: string
  changed: boolean
}

export interface SourceControlStashPopResult { applied: boolean; conflicts: boolean }
export interface SourceControlStashPopRequest { oid: string; dirtyPaths: string[] }
export interface SourceControlMergeRequest extends SourceControlSwitchRequest { targetKind: 'local' | 'cached-remote'; dirtyPaths: string[] }
export interface SourceControlMergeResult { applied: boolean; conflicts: boolean }
export interface SourceControlPushRequest { repository: string; remote: string; branch: string; previous: string; head: string; dirtyPaths: string[] }
export interface SourceControlPushReview extends Omit<SourceControlPushRequest, 'dirtyPaths'> { commits: number; objects: number; bytes: number }
export interface SourceControlPushResult { head: string; cachedRefUpdated: boolean }

export interface SourceControlGitHubPullRequestRequest {
  repository: string
  number: number
}

export interface SourceControlGitHubIssueRequest {
  repository: string
  number: number
}

export interface SourceControlGitHubCreatePullRequestRequest {
  repository: string
  title: string
  head: string
  base: string
  body: string
  draft: boolean
}

export interface SourceControlGitHubCreatedPullRequest {
  number: number
  title: string
  url: string
  head: string
  base: string
  draft: boolean
}

export interface SourceControlGitHubPullRequest {
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  author: string | null
  base: string
  head: string
  body: string
  bodyTruncated: boolean
}

export interface SourceControlGitHubIssue {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  author: string | null
  body: string
  bodyTruncated: boolean
}

export interface SourceControlBridge {
  createTag(request: { name: string; from: string }): Promise<void>
  createBranch(request: { name: string; from: string }): Promise<void>
  switchBranch(request: SourceControlSwitchRequest): Promise<boolean>
  fetchGitHub(request: SourceControlFetchRequest): Promise<SourceControlFetchResult | null>
  saveStashSnapshot(): Promise<string | null>
  popStash(request: SourceControlStashPopRequest): Promise<SourceControlStashPopResult | null>
  mergeBranch(request: SourceControlMergeRequest): Promise<SourceControlMergeResult | null>
  pushGitHub(request: SourceControlPushRequest): Promise<SourceControlPushResult | null>
  conflict(request: { path: string }): Promise<SourceControlConflict>
  cancelBlame(path: string): Promise<void>
  blame(request: { path: string }): Promise<SourceControlBlame>
  previewComparison(request: SourceControlComparisonRequest): Promise<SourceControlComparison>
  browse(): Promise<SourceControlBrowse>
  github(repository: string): Promise<SourceControlGitHub>
  githubSignIn(): Promise<boolean>
  githubSignOut(): Promise<boolean>
  onGitHubAuthEvent(callback: (event: SourceControlGitHubAuthEvent) => void): () => void
  githubPullRequest(request: SourceControlGitHubPullRequestRequest): Promise<SourceControlGitHubPullRequest>
  githubIssue(request: SourceControlGitHubIssueRequest): Promise<SourceControlGitHubIssue>
  createGitHubPullRequest(request: SourceControlGitHubCreatePullRequestRequest): Promise<SourceControlGitHubCreatedPullRequest | null>
  cloneGitHub(repository: string, access: 'public' | 'authenticated'): Promise<string | null>
  closeGitHub(): Promise<void>
  openGitHubPage(url: string): Promise<void>
  status(): Promise<SourceControlStatus>
  trust(): Promise<boolean>
  diff(request: SourceControlDiffRequest): Promise<SourceControlDiff>
  change(request: SourceControlChangeRequest): Promise<void>
  discardWorking(request: SourceControlDiscardRequest): Promise<boolean>
  commit(request: { message: string }): Promise<void>
  close(): Promise<void>
}
