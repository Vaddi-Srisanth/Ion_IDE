export type ManualProgress = 'not-started' | 'in-progress' | 'manually-completed'
export type TestOutcome = 'test-verified' | 'test-failed' | 'unable-to-verify'
export type EvidenceKind = 'behavior' | 'environment' | 'configuration' | 'interrupted'

export interface SuggestedFile {
  path: string
  purpose: string
  required: boolean
}

export interface ProjectMilestone {
  id: string
  title: string
  description: string
  dependsOn: string[]
  acceptance: string[]
  status: ManualProgress
}

export interface ProjectTest {
  id: string
  milestoneId: string
  title: string
  source: string
  stdin: string
  expectedOutput: string
  match: 'exact' | 'contains'
  exitCode: number
}

export interface ProjectSpec {
  version: 1
  title: string
  description: string
  goal: string
  technologies: string[]
  files: SuggestedFile[]
  milestones: ProjectMilestone[]
  environment: string[]
  tests: ProjectTest[]
}

export interface TestEvidence {
  testId: string
  outcome: TestOutcome
  kind: EvidenceKind
  message: string
  captured: string
  compilerOutput: string
  exitCode: number | null
  durationMs: number
  checkedAt: number
  stale: boolean
  stderr?: string
  programMs?: number
  location?: { line: number; column: number; path: string }
}

export interface ProjectRecord {
  spec: ProjectSpec
  revision: string
  approved: string[]
  automatic?: string[]
  evidence: TestEvidence[]
}

export interface ProviderSettings {
  endpoint: string
  model: string
  hasKey: boolean
}

export interface ProviderUpdate {
  endpoint: string
  model: string
  apiKey?: string
  forgetKey?: boolean
}

export interface ProjectSuiteResult {
  record: ProjectRecord
  cancelled: boolean
  completed: string[]
}

export interface ProjectsBridge {
  open(path: string): Promise<ProjectRecord | null>
  save(path: string, spec: ProjectSpec, revision: string | null): Promise<ProjectRecord>
  approve(path: string, testId: string, revision: string): Promise<ProjectRecord>
  run(path: string, testId: string, revision: string): Promise<ProjectRecord>
  runSuite(path: string, testIds: string[], revision: string): Promise<ProjectSuiteResult>
  cancelSuite(path: string): Promise<boolean>
  setAutomatic(path: string, testId: string, revision: string, enabled: boolean): Promise<ProjectRecord>
  provider(): Promise<ProviderSettings>
  configure(value: ProviderUpdate): Promise<ProviderSettings>
  propose(goal: string): Promise<ProjectSpec | null>
  onSourceSaved?(callback: (path: string) => void): () => void
}
