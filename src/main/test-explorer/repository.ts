import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from '../projects/storage'
import { maxTestRecordBytes, testId, validateStoredTests, type StoredTests } from './model'
export { maxTestRecordBytes, validateStoredTests, validateStoredTestSnapshot, restoreStoredTests } from './model'

export class TestRepository {
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}
  private file(root: string) { return join(this.directory, testId(root) + '.json') }
  async read(root: string): Promise<StoredTests | null> {
    const value = await readJson(this.file(root), maxTestRecordBytes)
    if (value === null) return null
    const record = validateStoredTests(value)
    if (record.snapshot.root !== root) throw new Error('Stored tests belong to another workspace.')
    return record
  }
  save(record: StoredTests, expected: string | null): Promise<StoredTests> {
    const operation = this.queue.then(async () => {
      const previous = await this.read(record.snapshot.root)
      if ((previous?.snapshot.revision ?? null) !== expected) throw new Error('Stored tests changed. Refresh and try again.')
      const next = validateStoredTests({ ...record, snapshot: { ...record.snapshot, revision: randomUUID() } })
      await writeJson(this.file(next.snapshot.root), next, maxTestRecordBytes)
      return next
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
  drain() { return this.queue }
}
