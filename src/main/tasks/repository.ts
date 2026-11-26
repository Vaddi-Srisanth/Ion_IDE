import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { TaskRecord } from '../../shared/tasks'
import { readJson, writeJson } from '../projects/storage'
import { maxTaskRecordBytes, validateTaskGraph } from './model'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export function validateStoredTasks(value: unknown, root: string): TaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored tasks.')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 4 || row.schema !== 1 || row.root !== root || !isAbsolute(root)
    || typeof row.revision !== 'string' || !uuid.test(row.revision)) throw new Error('Invalid stored tasks.')
  return { root, revision: row.revision, tasks: validateTaskGraph(row.tasks, root) }
}

export class TaskRepository {
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}
  private file(root: string) { return join(this.directory, createHash('sha256').update(root).digest('hex') + '.json') }

  async read(root: string): Promise<TaskRecord | null> {
    const value = await readJson(this.file(root), maxTaskRecordBytes)
    return value === null ? null : validateStoredTasks(value, root)
  }

  save(root: string, tasks: unknown, expected: string | null): Promise<TaskRecord> {
    const operation = this.queue.then(async () => {
      const previous = await this.read(root)
      if ((previous?.revision ?? null) !== expected) throw new Error('The saved tasks changed. Refresh and try again.')
      const record = { root, revision: randomUUID(), tasks: validateTaskGraph(tasks, root) }
      await writeJson(this.file(root), { schema: 1, ...record }, maxTaskRecordBytes)
      return record
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
  drain() { return this.queue }
}
