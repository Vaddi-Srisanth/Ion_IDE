import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ProjectMilestone, ProjectRecord, ProjectTest, TestEvidence } from '../../shared/projects'
import { boundedText, exactObject, validateProject } from './spec'
import { readJson, writeJson } from './storage'

const storageLimit = 512 * 1024
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export type SavedEvidence = Omit<TestEvidence, 'stale' | 'location'> & {
  sourceRevision: string | null
  location?: { line: number; column: number }
}
export type SavedProject = Omit<ProjectRecord, 'evidence' | 'automatic'> & { evidence: SavedEvidence[] }

function readEvidence(value: unknown): SavedEvidence {
  const extras = ['stderr', 'programMs', 'location'].filter((key) => value && typeof value === 'object' && Object.hasOwn(value, key))
  const data = exactObject(value, ['testId', 'outcome', 'kind', 'message', 'captured', 'compilerOutput', 'exitCode',
    'durationMs', 'checkedAt', 'sourceRevision', ...extras], 'Stored evidence')
  if (data.outcome !== 'test-verified' && data.outcome !== 'test-failed' && data.outcome !== 'unable-to-verify') throw new Error('Invalid test outcome.')
  if (data.kind !== 'behavior' && data.kind !== 'environment' && data.kind !== 'configuration' && data.kind !== 'interrupted') {
    throw new Error('Invalid test evidence kind.')
  }
  const { exitCode, checkedAt, durationMs, sourceRevision } = data
  if ((exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255))
    || typeof checkedAt !== 'number' || !Number.isSafeInteger(checkedAt) || checkedAt < 0
    || typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0
    || (sourceRevision !== null && (typeof sourceRevision !== 'string' || sourceRevision.length > 240))) {
    throw new Error('Invalid test evidence metadata.')
  }
  const evidence: SavedEvidence = {
    testId: boundedText(data.testId, 40, 'Evidence test ID'),
    outcome: data.outcome, kind: data.kind, exitCode, durationMs, checkedAt, sourceRevision,
    message: boundedText(data.message, 1200, 'Evidence message'),
    captured: boundedText(data.captured, 2500, 'Captured output', true),
    compilerOutput: boundedText(data.compilerOutput, 2500, 'Compiler output', true),
  }
  if (extras.includes('stderr')) evidence.stderr = boundedText(data.stderr, 1250, 'Standard error', true)
  if (extras.includes('programMs')) {
    if (typeof data.programMs !== 'number' || !Number.isSafeInteger(data.programMs) || data.programMs < 0) {
      throw new Error('Invalid test runtime.')
    }
    evidence.programMs = data.programMs
  }
  if (extras.includes('location')) {
    const { line, column } = exactObject(data.location, ['line', 'column'], 'Test source location')
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1
      || typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1) {
      throw new Error('Invalid test source location.')
    }
    evidence.location = { line, column }
  }
  return evidence
}

export class ProjectRepository {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string) {}

  private file(root: string): string {
    const name = createHash('sha256').update(root).digest('hex')
    return join(this.directory, name + '.json')
  }

  async read(root: string): Promise<SavedProject | null> {
    const value = await readJson(this.file(root), storageLimit)
    if (value === null) return null
    const data = exactObject(value, ['schema', 'spec', 'revision', 'approved', 'evidence'], 'Stored project')
    if (data.schema !== 1 || typeof data.revision !== 'string' || !uuid.test(data.revision)) throw new Error('Invalid stored project version.')
    const spec = validateProject(data.spec)
    const ids = new Set(spec.tests.map(test => test.id))
    const approved = data.approved
    if (!Array.isArray(approved) || approved.length > 16
      || approved.some(testId => typeof testId !== 'string' || !ids.has(testId))
      || !Array.isArray(data.evidence) || data.evidence.length > 16) throw new Error('Invalid stored test records.')
    const evidence = data.evidence.map(readEvidence)
    if (evidence.some(item => !approved.includes(item.testId))) throw new Error('Invalid stored test approvals.')
    return { spec, revision: data.revision, approved, evidence }
  }

  async save(root: string, value: unknown, expected: unknown): Promise<SavedProject> {
    const spec = validateProject(value)
    return this.update(root, expected, previous => {
      const changed = new Map(spec.tests.map(test => [test.id, JSON.stringify(test)]))
      const same = new Set(previous?.spec.tests.filter(test => changed.get(test.id) === JSON.stringify(test)).map(test => test.id))
      const milestoneMeaning = ({ title, description, dependsOn, acceptance }: ProjectMilestone) =>
        JSON.stringify([title, description, dependsOn, acceptance])
      const milestone = new Map(spec.milestones.map(item => [item.id, milestoneMeaning(item)]))
      const unchangedMilestones = new Set(previous?.spec.milestones
        .filter(item => milestone.get(item.id) === milestoneMeaning(item)).map(item => item.id))
      const currentEvidence = new Set(spec.tests.filter(test => same.has(test.id) && unchangedMilestones.has(test.milestoneId))
        .map(test => test.id))
      return {
        spec, approved: previous?.approved.filter(id => same.has(id)) ?? [],
        evidence: previous?.spec.goal === spec.goal
          ? previous.evidence.filter(item => currentEvidence.has(item.testId)) : [],
      }
    })
  }

  async approve(root: string, test: ProjectTest, expected: unknown): Promise<SavedProject> {
    return this.update(root, expected, previous => {
      if (!previous || !previous.spec.tests.some(candidate => candidate.id === test.id)) throw new Error('Test no longer exists.')
      return { ...previous, approved: [...new Set([...previous.approved, test.id])] }
    })
  }

  async evidence(root: string, item: SavedEvidence, expected: unknown): Promise<SavedProject> {
    return this.evidenceBatch(root, [item], expected)
  }

  async evidenceBatch(root: string, items: readonly SavedEvidence[], expected: unknown): Promise<SavedProject> {
    return this.update(root, expected, previous => {
      if (!previous || items.some(item => !previous.approved.includes(item.testId))) {
        throw new Error('Review and approve the test before running it.')
      }
      const replacing = new Set(items.map(item => item.testId))
      return { ...previous, evidence: [...previous.evidence.filter(item => !replacing.has(item.testId)), ...items] }
    })
  }

  private update(
    root: string, expected: unknown, change: (previous: SavedProject | null) => Omit<SavedProject, 'revision'>,
  ): Promise<SavedProject> {
    const operation = this.queue.then(async () => {
      const previous = await this.read(root)
      if ((previous?.revision ?? null) !== expected) throw new Error('The saved project changed. Reload it and try again.')
      const record = { ...change(previous), revision: randomUUID() }
      await writeJson(this.file(root), { schema: 1, ...record }, storageLimit)
      return record
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
