import type { RunResult } from '../../shared/contracts'
import type { ProjectTest } from '../../shared/projects'
import type { SavedEvidence } from './repository'

const preview = (value: string) => {
  const text = value.replaceAll('\0', '\u2400')
  return text.length > 2400 ? text.slice(0, 2400) + '\n… output preview truncated' : text
}

export function unavailableTest(test: ProjectTest, message: string): SavedEvidence {
  return {
    testId: test.id, outcome: 'unable-to-verify', kind: 'configuration', message: message.slice(0, 1200),
    captured: '', compilerOutput: '', exitCode: null, durationMs: 0, checkedAt: Date.now(), sourceRevision: null,
  }
}

export function judgeTest(test: ProjectTest, result: RunResult, sourceRevision: string): SavedEvidence {
  const output = result.programStdout ?? result.programOutput
  const evidence: SavedEvidence = {
    testId: test.id, outcome: 'unable-to-verify', kind: 'configuration', message: result.message.slice(0, 1200),
    captured: preview(output), compilerOutput: preview(result.compileOutput), exitCode: result.exitCode,
    durationMs: result.durationMs, checkedAt: Date.now(), sourceRevision,
  }
  if (result.status === 'missing-toolchain') return { ...evidence, kind: 'environment' }
  if (result.status === 'cancelled' || result.status === 'rejected') return { ...evidence, kind: 'interrupted' }
  if (result.status === 'compile-error') return evidence
  if (result.outputComplete === false || result.status === 'timeout' || result.status === 'output-limit' || result.exitCode === null) {
    return { ...evidence, kind: 'interrupted' }
  }

  const normalizedOutput = output.replaceAll('\r\n', '\n')
  const expected = test.expectedOutput.replaceAll('\r\n', '\n')
  const outputMatches = test.match === 'exact' ? normalizedOutput === expected : normalizedOutput.includes(expected)
  const passed = result.exitCode === test.exitCode && outputMatches
  const message = passed ? 'Observed output and exit code match the approved checks.'
    : result.exitCode !== test.exitCode ? `Expected exit code ${test.exitCode} but observed ${result.exitCode}.`
      : 'The observed output did not match the approved expectation.'
  return { ...evidence, outcome: passed ? 'test-verified' : 'test-failed', kind: 'behavior', message }
}
