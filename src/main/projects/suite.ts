import { normalize } from 'node:path'
import type { RunResult } from '../../shared/contracts'
import type { ProjectTest } from '../../shared/projects'
import { compilerProblems } from '../learning/diagnostics'
import { rejectedRun, type CRunner } from '../runner'
import { judgeTest, unavailableTest } from './evidence'
import type { SavedEvidence, SavedProject } from './repository'

export interface TestSource {
  path: string
  revision: string
  size: number
}

/** A behavior adapter executes only approved inputs for an already scoped source. */
interface TestAdapter {
  maxCases: number
  run(source: TestSource, inputs: readonly string[], current: () => Promise<boolean>, signal: AbortSignal): Promise<RunResult[]>
  evidence(test: ProjectTest, result: RunResult, source: TestSource): SavedEvidence
}

export const missingTestSource = 'The source is missing, inaccessible, too large, or outside the project. Check the test configuration.'

export function selectedProjectTests(record: SavedProject, ids: unknown): ProjectTest[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 || ids.some(id => typeof id !== 'string' || id.length > 40)
    || new Set(ids).size !== ids.length) throw new Error('Choose between one and sixteen distinct saved tests.')
  return ids.map(id => {
    const test = record.spec.tests.find(candidate => candidate.id === id)
    if (!test || !record.approved.includes(id)) throw new Error('Review and approve each selected test before running it.')
    return test
  })
}

export function cTestEvidence(test: ProjectTest, result: RunResult, source: TestSource): SavedEvidence {
  const evidence = judgeTest(test, result, source.revision)
  if (result.status !== 'compile-error') return evidence
  const samePath = (file: string) => process.platform === 'win32'
    ? normalize(file).toLowerCase() === normalize(source.path).toLowerCase() : file === source.path
  const problem = compilerProblems(result, 'c').find(({ severity, location }) =>
    (severity === 'error' || severity === 'fatal error') && location && samePath(location.file))
  if (problem?.location) evidence.location = { line: problem.location.line, column: problem.location.column ?? 1 }
  return evidence
}

export function cTestAdapter(runner: CRunner): TestAdapter {
  return {
    maxCases: 8,
    async run(source, inputs, current, signal) {
      const allowed = await current()
      if (signal.aborted) return []
      if (!allowed) return [rejectedRun('The approved source or test changed before compilation.')]
      return runner.runSamples(source.path, inputs, current, signal)
    },
    evidence: cTestEvidence,
  }
}

export async function executeProjectTests(
  adapter: TestAdapter,
  tests: readonly ProjectTest[],
  inspect: (test: ProjectTest) => Promise<TestSource>,
  current: (test: ProjectTest, source: TestSource) => Promise<boolean>,
  signal: AbortSignal,
): Promise<SavedEvidence[]> {
  const evidence: SavedEvidence[] = []
  for (let cursor = 0; cursor < tests.length && !signal.aborted;) {
    const first = tests[cursor++]
    const batch = [first]
    while (batch.length < adapter.maxCases && tests[cursor]?.source === first.source) batch.push(tests[cursor++])
    const source = await inspect(first).catch(() => null)
    if (signal.aborted) break
    if (!source) {
      evidence.push(...batch.map(test => unavailableTest(test, missingTestSource)))
      continue
    }
    const outcomes = await adapter.run(source, batch.map(test => test.stdin), () => current(first, source), signal)
    for (const [index, test] of batch.entries()) {
      // A compilation or preflight failure has one outcome for the whole batch.
      const result = outcomes[index] ?? outcomes.at(-1)
      if (!result || result.status === 'cancelled' || index >= outcomes.length && signal.aborted) break
      evidence.push(adapter.evidence(test, result, source))
    }
  }
  return evidence
}
