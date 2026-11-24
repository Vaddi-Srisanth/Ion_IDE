export const workspaceSearchQueryLimit = 200
export const workspaceSearchResultLimit = 200
export const workspaceReplaceTextLimit = 10_000

export interface WorkspaceSearchMatch {
  line: number
  column: number
  preview: string
}

export interface WorkspaceSearchFile {
  path: string
  relativePath: string
  matches: WorkspaceSearchMatch[]
}

export interface WorkspaceSearchResult {
  files: WorkspaceSearchFile[]
  limit?: 'matches' | 'time' | 'output'
  skipped?: boolean
}

export interface WorkspaceReplaceFile {
  path: string
  relativePath: string
  replacements: number
}

export interface WorkspaceReplacePreview {
  token: string
  files: WorkspaceReplaceFile[]
  replacements: number
  expiresAt: number
}

export interface WorkspaceReplaceResult {
  applied: string[]
  failed: { path: string; message: string }[]
}
