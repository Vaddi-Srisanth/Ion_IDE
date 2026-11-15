/** On-demand, offline structure evidence. Nothing here establishes working behavior. */
export interface ProjectLensLimits {
  depth: number; visits: number; files: number; manifestBytes: number
  totalManifestBytes: number; durationMs: number; resultBytes: number
}
export const projectLensLimits: Readonly<ProjectLensLimits> = Object.freeze({
  depth: 6, visits: 2500, files: 500, manifestBytes: 64 * 1024,
  totalManifestBytes: 256 * 1024, durationMs: 5000, resultBytes: 128 * 1024,
})
export type ProjectLensExclusion = 'hidden-or-generated' | 'secret' | 'binary' | 'lockfile' | 'symlink-or-special'
  | 'depth' | 'unreadable-or-changed' | 'manifest-size' | 'manifest-budget' | 'invalid-manifest' | 'long-path'
export interface ProjectLensReference {
  /** Relative to the exact granted root, never a new filesystem grant. */
  path: string
  revision: string
  /** Present only for a completely read, stable UTF-8 manifest. One-based UTF-16 columns. */
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number }
}
export interface ProjectLensFile {
  reference: ProjectLensReference
  language: string
  bytes: number
}
export interface ProjectLensManifest {
  kind: string
  reference: ProjectLensReference
  status: 'parsed' | 'recognized-text' | 'malformed'
  dependencies: Array<{ name: string; version: string; group: string }>
  /** Inert, bounded, redacted text. Never an execution configuration. */
  scripts: Array<{ name: string; command: string }>
}
export interface ProjectLensFramework {
  name: string
  confidence: 'declared' | 'structure-only'
  reason: string
  reference: ProjectLensReference
}
export interface ProjectLensEntryPoint {
  kind: 'existing-candidate' | 'manifest-reference'
  /** Existing path for candidates; declared relative path for unverified references. */
  path: string
  reference: ProjectLensReference
  reason: string
}
export interface ProjectLensSnapshot {
  version: 1
  root: string
  status: 'complete' | 'partial' | 'cancelled' | 'invalidated'
  durationMs: number
  limits: ProjectLensLimits
  counts: { visitedEntries: number; directoriesInspected: number; regularFilesSeen: number;
    filesInspected: number; returnedFiles: number; manifestBytesRead: number }
  languages: Array<{ id: string; label: string; files: number }>
  files: ProjectLensFile[]
  manifests: ProjectLensManifest[]
  frameworks: ProjectLensFramework[]
  entryPoints: ProjectLensEntryPoint[]
  documentation: ProjectLensReference[]
  tests: ProjectLensReference[]
  exclusions: Partial<Record<ProjectLensExclusion, number>>
  truncated: string[]
  limitations: string[]
}

export interface ProjectLensOpenResult {
  entry: { path: string; name: string; kind: 'file' }
  range?: ProjectLensReference['range']
}

/** Narrow, explicit IPC surface. Analysis never grants filesystem authority. */
export interface ProjectLensBridge {
  analyze(root: string): Promise<ProjectLensSnapshot>
  cancel(): Promise<void>
  openReference(root: string, reference: ProjectLensReference): Promise<ProjectLensOpenResult>
}
