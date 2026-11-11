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

export interface SourceControlBridge {
  status(): Promise<SourceControlStatus>
  trust(): Promise<boolean>
  diff(request: SourceControlDiffRequest): Promise<SourceControlDiff>
  change(request: SourceControlChangeRequest): Promise<void>
  commit(request: { message: string }): Promise<void>
  close(): Promise<void>
}
