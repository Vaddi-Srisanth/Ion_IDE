import type { RunResult } from '../../shared/contracts'
import type { PracticeSubmission } from '../../shared/practice'
import { additionalJudgeCases } from './catalog-judge-cases'
import { maxPracticeSamples } from '../../shared/practice'
import { defaultRunLimits } from '../runner'

// These original cases live in a main-process module loaded only when Local Submit is requested.
const minutes = [59, 61, 3_600, 120_001, 456_789_012, 999_999_999]
const clockCases = minutes.map(value => ({ input: String(value) + '\n', answer: Math.floor(value / 60) + ' ' + value % 60 }))
const incomplete = 'The local judge could not verify a complete run. Previous submissions were preserved.'

export async function judgeChallenge(catalogId: string, execute: (inputs: readonly string[]) => Promise<readonly RunResult[]>) {
  const cases = catalogId === 'minutes-to-clock' ? clockCases : Object.hasOwn(additionalJudgeCases, catalogId) ? additionalJudgeCases[catalogId] : undefined
  if (!cases?.length || cases.length > maxPracticeSamples) throw new Error('Local Submit is unavailable for this problem.')
  let runs: readonly RunResult[]
  try {
    runs = await execute(cases.map(item => item.input))
  } catch {
    // Toolchain diagnostics and exceptions may contain the program's input or output.
    throw new Error(incomplete)
  }
  if (!Array.isArray(runs) || runs.length < 1 || runs.length > cases.length) throw new Error(incomplete)
  let passed = 0, runtimeMs = 0, stdoutUnits = 0
  let errorVerdict: PracticeSubmission['verdict'] | undefined
  for (const [index, run] of runs.entries()) {
    if (!run || run.sourceChanged || run.status === 'rejected') throw new Error('The saved source was not approved or changed. Review it and submit again.')
    if (run.status === 'cancelled') throw new Error('Local submission stopped.')
    if (run.status === 'missing-toolchain') throw new Error('Install the local language toolchain before submitting.')
    if (run.outputComplete === false && run.status !== 'output-limit') throw new Error(incomplete)
    if (run.compileMs !== undefined && (!Number.isSafeInteger(run.compileMs) || run.compileMs < 0)) throw new Error(incomplete)
    if (run.programMs !== undefined) {
      if (!Number.isSafeInteger(run.programMs) || run.programMs < 0) throw new Error(incomplete)
      runtimeMs += run.programMs
      if (!Number.isSafeInteger(runtimeMs)) throw new Error(incomplete)
    }
    switch (run.status) {
      case 'success':
        if (run.exitCode !== 0 || run.programSignal || run.outputComplete !== true || run.programMs === undefined
          || typeof run.programStdout !== 'string') throw new Error(incomplete)
        // The decoded string cannot have more UTF-16 units than original captured bytes.
        stdoutUnits += run.programStdout.length
        if (stdoutUnits > defaultRunLimits.outputBytes) throw new Error(incomplete)
        if (run.programStdout.replaceAll('\r\n', '\n').replace(/\n$/, '') === cases[index].answer) passed++
        break
      case 'compile-error':
        if (runs.length !== 1 || run.outputComplete !== true || run.compileMs === undefined || run.programMs !== undefined
          || !Number.isInteger(run.exitCode) || run.exitCode === 0) throw new Error(incomplete)
        errorVerdict = run.status
        break
      case 'runtime-error':
        if (run.outputComplete !== true || run.programMs === undefined
          || (!(Number.isInteger(run.exitCode) && run.exitCode !== 0) && !run.programSignal)) throw new Error(incomplete)
        errorVerdict ??= run.status
        break
      case 'timeout':
      case 'output-limit':
        if (run.compileMs === undefined && run.programMs === undefined || run.status === 'output-limit' && run.outputComplete !== false) throw new Error(incomplete)
        errorVerdict ??= run.status
        break
      default: throw new Error(incomplete)
    }
  }
  const last = runs[runs.length - 1]
  const stoppedDuringCompile = runs.length === 1 && (last.status === 'compile-error' || last.status === 'timeout' && last.programMs === undefined)
  if (runs.length !== cases.length && !stoppedDuringCompile && last.status !== 'output-limit') throw new Error(incomplete)
  const verdict = errorVerdict ?? (passed === cases.length ? 'accepted' : 'wrong-answer')
  return { judgedAt: Date.now(), verdict, passed, total: cases.length, runtimeMs }
}
