import { isAbsolute, relative, sep } from 'node:path'
import type { TaskAdapter, TaskDefinition } from '../../shared/tasks'

export const maxTaskRecordBytes = 256 * 1024
export const maxTasks = 128
export const maxDependencies = 16
export const maxTaskDepth = 16
export const maxTaskTimeoutMs = 30 * 60_000
const id = /^[a-z0-9][a-z0-9._:-]{0,79}$/
const adapters = new Set<TaskAdapter>(['make', 'cmake-configure', 'cmake-build', 'npm', 'python', 'maven', 'gradle', 'cargo', 'go'])

function text(value: unknown, bytes: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > bytes || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return value
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`Invalid ${label}.`)
  }
  return record
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

export function validateTaskDefinition(value: unknown, root: string): TaskDefinition {
  const row = exact(value, ['id', 'label', 'adapter', 'cwd', 'selector', 'dependsOn', 'timeoutMs', 'source'], 'task definition')
  const taskId = text(row.id, 80, 'task ID')
  if (!id.test(taskId)) throw new Error('Invalid task ID.')
  if (!adapters.has(row.adapter as TaskAdapter)) throw new Error('Invalid task adapter.')
  const cwd = text(row.cwd, 4096, 'task working directory')
  if (!isAbsolute(cwd) || !inside(root, cwd)) throw new Error('Task working directory must stay inside its workspace.')
  const selector = text(row.selector, 200, 'task selector')
  const dependsOn = row.dependsOn
  if (!Array.isArray(dependsOn) || dependsOn.length > maxDependencies || dependsOn.some(item => typeof item !== 'string' || !id.test(item))) {
    throw new Error('Invalid task dependencies.')
  }
  const timeoutMs = row.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > maxTaskTimeoutMs) {
    throw new Error('Invalid task timeout.')
  }
  const source = exact(row.source, ['path', 'revision'], 'task source')
  const sourcePath = text(source.path, 4096, 'task source path')
  const sourceRevision = text(source.revision, 256, 'task source revision')
  if (!isAbsolute(sourcePath) || !inside(root, sourcePath)) throw new Error('Task source must stay inside its workspace.')
  return { id: taskId, label: text(row.label, 160, 'task label'), adapter: row.adapter as TaskAdapter,
    cwd, selector, dependsOn: [...dependsOn] as string[], timeoutMs: timeoutMs as number,
    source: { path: sourcePath, revision: sourceRevision } }
}

export function validateTaskGraph(values: unknown, root: string): TaskDefinition[] {
  if (!Array.isArray(values) || values.length > maxTasks) throw new Error('Invalid task list.')
  const tasks = values.map(value => validateTaskDefinition(value, root))
  const byId = new Map(tasks.map(task => [task.id, task]))
  if (byId.size !== tasks.length) throw new Error('Task IDs must be unique.')
  for (const task of tasks) if (task.dependsOn.some(dependency => dependency === task.id || !byId.has(dependency))) {
    throw new Error('Task dependency is missing or self-referential.')
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const walk = (task: TaskDefinition, depth: number) => {
    if (depth > maxTaskDepth || visiting.has(task.id)) throw new Error('Task dependency graph is cyclic or too deep.')
    if (visited.has(task.id)) return
    visiting.add(task.id)
    for (const dependency of task.dependsOn) walk(byId.get(dependency)!, depth + 1)
    visiting.delete(task.id)
    visited.add(task.id)
  }
  for (const task of tasks) walk(task, 1)
  return tasks
}

export function taskOrder(tasks: readonly TaskDefinition[], selected: string): TaskDefinition[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const requested = byId.get(selected)
  if (!requested) throw new Error('The selected task no longer exists.')
  const result: TaskDefinition[] = []
  const seen = new Set<string>()
  const visit = (task: TaskDefinition) => {
    if (seen.has(task.id)) return
    for (const dependency of task.dependsOn) visit(byId.get(dependency)!)
    seen.add(task.id)
    result.push(task)
  }
  visit(requested)
  return result
}
