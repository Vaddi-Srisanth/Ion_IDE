export const workspaceSearchQueryLimit = 200
export const workspaceSearchResultLimit = 200

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
