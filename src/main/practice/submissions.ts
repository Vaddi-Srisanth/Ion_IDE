import type { PracticeSubmission } from '../../shared/practice'
import { maxPracticeSamples } from '../../shared/practice'

export const submissionHistoryLimit = 10
export const submissionFileLimit = 64 * 1024

export interface StoredSubmission extends Omit<PracticeSubmission, 'current'> {
  sourceSha256: string
  suiteVersion: number
  restored?: true
}
export interface StoredSubmissions { version: 1; submissions: StoredSubmission[] }

const verdicts: PracticeSubmission['verdict'][] = ['accepted', 'wrong-answer', 'compile-error', 'runtime-error', 'timeout', 'output-limit']
const rowKeys = ['judgedAt', 'verdict', 'passed', 'total', 'runtimeMs', 'sourceSha256', 'suiteVersion', 'restored']
const invalid = 'Invalid local submission history.'

function onlyFields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(invalid)
  }
  return value as Record<string, unknown>
}

function number(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(invalid)
  return value
}

export function validatePracticeSubmissions(value: unknown): StoredSubmissions {
  const file = onlyFields(value, ['version', 'submissions'])
  if (file.version !== 1 || !Array.isArray(file.submissions) || file.submissions.length > submissionHistoryLimit) throw new Error(invalid)
  return { version: 1, submissions: file.submissions.map((value: unknown) => {
    const row = onlyFields(value, rowKeys)
    const verdict = verdicts.find(v => v === row.verdict)
    const total = number(row.total, 1, maxPracticeSamples), passed = number(row.passed, 0, total)
    if (!verdict || (verdict === 'accepted') !== (passed === total) || (verdict === 'compile-error' && passed !== 0)
      || typeof row.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceSha256)
      || 'restored' in row && row.restored !== true) throw new Error(invalid)
    return { judgedAt: number(row.judgedAt, 1), verdict, passed, total, runtimeMs: number(row.runtimeMs, 0),
      sourceSha256: row.sourceSha256, suiteVersion: number(row.suiteVersion, 1), ...(row.restored === true && { restored: true as const }) }
  }) }
}
