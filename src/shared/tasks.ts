import type { RunResult } from './contracts'

export type TaskAdapter = 'make' | 'cmake-configure' | 'cmake-build' | 'npm' | 'python'
  | 'maven' | 'gradle' | 'cargo' | 'go'

export interface TaskSource {
  path: string
  revision: string
}

/** A reviewed declarative task. It intentionally contains no executable path, shell string or environment. */
export interface TaskDefinition {
  id: string
  label: string
  adapter: TaskAdapter
  cwd: string
  selector: string
  dependsOn: string[]
  timeoutMs: number
  source: TaskSource
}

export interface TaskRecord {
  root: string
  revision: string
  tasks: TaskDefinition[]
}

export interface TaskRunSummary {
  id: string
  label: string
  result: RunResult
}

export interface TaskGraphResult {
  root: string
  requested: string
  cancelled: boolean
  completed: TaskRunSummary[]
}

export interface TasksBridge {
  discover(root: string): Promise<TaskRecord>
  list(root: string): Promise<TaskRecord | null>
  run(root: string, taskId: string, revision: string, runId: string): Promise<TaskGraphResult>
  cancel(): Promise<boolean>
}
