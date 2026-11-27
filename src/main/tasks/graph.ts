import type { RunResult, RunStatus } from '../../shared/contracts'
import type { TaskDefinition, TaskGraphResult, TaskRunSummary } from '../../shared/tasks'
import { taskOrder } from './model'

export interface TaskExecutor {
  (task: TaskDefinition, signal: AbortSignal): Promise<RunResult>
}

export async function runTaskGraph(root: string, tasks: readonly TaskDefinition[], requested: string,
  execute: TaskExecutor, signal: AbortSignal): Promise<TaskGraphResult> {
  const completed: TaskRunSummary[] = []
  for (const task of taskOrder(tasks, requested)) {
    if (signal.aborted) return { root, requested, cancelled: true, completed }
    const result = await execute(task, signal)
    completed.push({ id: task.id, label: task.label, result })
    if (result.status !== 'success') return { root, requested, cancelled: result.status === 'cancelled', completed }
  }
  return { root, requested, cancelled: false, completed }
}

export function taskResult(status: RunStatus, message: string, detail: Partial<RunResult> = {}): RunResult {
  return { status, message, compiler: null, compileOutput: '', programOutput: '', exitCode: null, durationMs: 0, ...detail }
}
