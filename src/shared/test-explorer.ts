export type TestAdapter = 'pytest' | 'vitest' | 'junit'
export interface TestNode {
  id: string
  parentId: string | null
  kind: 'suite' | 'file' | 'test'
  label: string
  location?: { path: string; line: number }
}
export interface TestCaseResult {
  id: string
  label?: string
  outcome: 'passed' | 'failed' | 'skipped' | 'error' | 'cancelled'
  durationMs: number
  message: string
  output: string
  location?: { path: string; line: number }
}
export interface TestRun {
  adapter?: TestAdapter
  id: string
  checkedAt: number
  durationMs: number
  status: 'completed' | 'cancelled' | 'failed'
  selectedIds: string[]
  cases: TestCaseResult[]
  stale: boolean
  restored?: boolean
}
export interface TestSnapshot {
  root: string
  revision: string
  adapter: TestAdapter
  discoveredAt: number
  nodes: TestNode[]
  history: TestRun[]
  stale: boolean
}
export interface TestOperationResult {
  status: 'completed' | 'cancelled' | 'failed'
  stage: 'review' | 'discovery' | 'run' | 'cleanup'
  snapshot: TestSnapshot | null
  message: string
}
export interface TestExplorerBridge {
  list(root: string): Promise<TestSnapshot | null>
  discover(root: string, adapter?: TestAdapter): Promise<TestOperationResult>
  run(root: string, revision: string, ids: string[]): Promise<TestOperationResult>
  cancel(): Promise<boolean>
}
