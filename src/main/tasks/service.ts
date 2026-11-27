import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunResult } from '../../shared/contracts'
import type { TaskDefinition, TaskGraphResult, TaskRecord } from '../../shared/tasks'
import type { WorkspaceFiles } from '../files'
import { discoverTasks, taskSourcesCurrent } from './discovery'
import { runTaskGraph, taskResult } from './graph'
import { taskOrder } from './model'
import { planTask, type PlannedTask } from './planner'
import { TaskRepository } from './repository'

export interface TaskReviewItem { task: TaskDefinition; plan: PlannedTask }
export interface TaskServiceOptions {
  profile(): string
  files(): WorkspaceFiles
  approve(root: string, items: readonly TaskReviewItem[], signal: AbortSignal): Promise<boolean>
  execute(task: TaskDefinition, plan: PlannedTask, signal: AbortSignal): Promise<RunResult>
  plan?(task: TaskDefinition, root: string, scratch: string): Promise<PlannedTask>
}

/** Lazy one-window task owner. Construction performs no discovery or process work. */
export class TaskService {
  private repository?: TaskRepository
  private active?: { controller: AbortController; done: Promise<TaskGraphResult> }
  constructor(private readonly options: TaskServiceOptions) {}
  get busy() { return Boolean(this.active) }
  private store() { return this.repository ??= new TaskRepository(join(this.options.profile(), 'tasks-v1')) }

  async list(root: unknown): Promise<TaskRecord | null> {
    const { path } = await this.options.files().inspect(root, 'folder')
    if (!this.options.files().rootPaths.includes(path)) throw new Error('Choose an open workspace root.')
    return this.store().read(path)
  }

  async discover(root: unknown): Promise<TaskRecord> {
    const scope = this.options.files()
    const { path } = await scope.inspect(root, 'folder')
    const current = await this.store().read(path)
    const tasks = await discoverTasks(scope, path)
    if (scope !== this.options.files() || !scope.rootPaths.includes(path)) throw new Error('The workspace changed during task discovery.')
    return this.store().save(path, tasks, current?.revision ?? null)
  }

  run(root: unknown, taskId: unknown, expected: unknown): Promise<TaskGraphResult> {
    if (this.active) throw new Error('A task is already running.')
    if (typeof taskId !== 'string' || typeof expected !== 'string') throw new Error('Invalid task request.')
    const controller = new AbortController()
    const job = this.runOwned(root, taskId, expected, controller.signal)
    this.active = { controller, done: job }
    void job.finally(() => { if (this.active?.done === job) this.active = undefined }).catch(() => undefined)
    return job
  }

  cancel(): boolean {
    if (!this.active) return false
    this.active.controller.abort()
    return true
  }

  async close(): Promise<void> {
    this.cancel()
    await this.active?.done.catch(() => undefined)
    await this.repository?.drain()
  }

  private async runOwned(root: unknown, taskId: string, expected: string, signal: AbortSignal): Promise<TaskGraphResult> {
    const scope = this.options.files()
    const { path } = await scope.inspect(root, 'folder')
    const record = await this.store().read(path)
    if (!record || record.revision !== expected) throw new Error('The saved tasks changed. Refresh and try again.')
    const ordered = taskOrder(record.tasks, taskId)
    if (!await taskSourcesCurrent(scope, path, ordered)) throw new Error('A task manifest changed. Refresh tasks and review again.')
    const scratch = await mkdtemp(join(await realpath(tmpdir()), 'ion-task-'))
    try {
      const reviewed: TaskReviewItem[] = []
      const planner = this.options.plan ?? planTask
      for (const task of ordered) reviewed.push({ task, plan: await planner(task, path, scratch) })
      if (!await this.options.approve(path, reviewed, signal) || signal.aborted) {
        return { root: path, requested: taskId, cancelled: true, completed: [] }
      }
      if (scope !== this.options.files() || !await taskSourcesCurrent(scope, path, ordered)
        || (await this.store().read(path))?.revision !== expected) {
        throw new Error('The workspace or task definitions changed while awaiting approval.')
      }
      const plans = new Map(reviewed.map(item => [item.task.id, item.plan]))
      return runTaskGraph(path, record.tasks, taskId, async (task, taskSignal) => {
        if (scope !== this.options.files() || !await taskSourcesCurrent(scope, path, [task])) {
          return taskResult('rejected', 'The task manifest changed before execution.')
        }
        return this.options.execute(task, plans.get(task.id)!, taskSignal)
      }, signal)
    } finally { await rm(scratch, { recursive: true, force: true }).catch(() => undefined) }
  }
}
