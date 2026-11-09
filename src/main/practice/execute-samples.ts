import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { RunResult, RunStatus } from '../../shared/contracts'
import { maxPracticeSamples } from '../../shared/practice'
import { defaultRunLimits, execute, validStdin } from '../runner'
import { MissingToolchainError, prepareRun } from '../run-console/plans'
import { processTempEnvironment } from '../windows-process'

type ProcessOutcome = Awaited<ReturnType<typeof execute>>

function outcomeMessage(outcome: ProcessOutcome, stage: 'Compilation' | 'Program'): [RunStatus, string] {
  if (outcome.state === 'cancelled') return ['cancelled', 'Run stopped.']
  if (outcome.state === 'timeout') return ['timeout', stage + ' exceeded its time limit.']
  if (outcome.state === 'output-limit') return ['output-limit', stage + ' exceeded the combined output limit.']
  const status = stage === 'Compilation' ? 'compile-error' : 'runtime-error'
  if (outcome.state !== 'exited' || outcome.exitCode !== 0) {
    return [status, stage + ' failed (' + (outcome.detail ?? 'exit code ' + String(outcome.exitCode)) + ').']
  }
  if (outcome.outputComplete === false) {
    return [status, stage + ' ended with incomplete output.']
  }
  return ['success', stage + ' exited successfully.']
}

export async function runPracticeBatch(
  path: string, text: string, inputs: readonly string[], sourceStillCurrent: () => Promise<boolean>, signal: AbortSignal,
): Promise<RunResult[]> {
  if (inputs.length < 1 || inputs.length > maxPracticeSamples) throw new Error('Run between one and eight samples at a time.')
  const samples = inputs.map(validStdin)
  const started = performance.now()
  const results: RunResult[] = []
  const limits = defaultRunLimits
  const budget = { remaining: limits.outputBytes }
  let scratch: string | undefined
  let compiler: string | null = null
  let compileOutput = ''
  let compileMs: number | undefined
  let stage: 'rejected' | 'compile-error' | 'runtime-error' = 'rejected'

  function result(status: RunStatus, message: string, detail: Partial<RunResult> = {}, since = started): RunResult {
    return {
      status, message, compiler, compileOutput, programOutput: '', exitCode: null,
      compileMs: results.length ? undefined : compileMs, durationMs: Math.round(performance.now() - since), ...detail,
    }
  }

  async function invalidSource(): Promise<RunResult | undefined> {
    const current = !signal.aborted && await sourceStillCurrent()
    if (signal.aborted) return result('cancelled', 'Run stopped.')
    if (!current) return result('rejected', 'The saved source changed. Review it and run samples again.')
  }

  try {
    const initial = await invalidSource()
    if (initial) return [initial]
    const temporary = await realpath(tmpdir())
    scratch = await mkdtemp(join(temporary, 'ion-practice-'))
    const build = join(scratch, 'build')
    const snapshot = join(build, basename(path))
    await mkdir(build, { mode: 0o700 })
    await writeFile(snapshot, text, { flag: 'wx', mode: 0o600 })
    // Plan from the approved bytes in a private folder, without workspace build files or dependencies.
    const plan = await prepareRun({ path: snapshot, root: null, scratch: build, signal })
    if (plan.build) throw new Error('Practice samples run a standalone source file.')
    compiler = plan.toolchain
    const beforeCompile = await invalidSource()
    if (beforeCompile) return [beforeCompile]
    if (plan.compile) {
      stage = 'compile-error'
      const beginCompile = performance.now()
      const command = plan.compile
      const outcome = await execute(command.executable, command.args, {
        cwd: command.cwd ?? plan.cwd, input: command.input ?? '', signal, timeoutMs: limits.compileMs,
        budget, environment: command.environment ?? {},
      })
      compileMs = Math.round(performance.now() - beginCompile)
      compileOutput = outcome.output
      const [status, message] = outcomeMessage(outcome, 'Compilation')
      if (status !== 'success') return [result(status, message, { exitCode: outcome.exitCode, outputComplete: outcome.outputComplete })]
    }
    const command = await plan.resolveRun?.() ?? plan.run
    stage = 'runtime-error'
    for (const [index, input] of samples.entries()) {
      const start = index === 0 ? started : performance.now()
      const invalid = await invalidSource()
      if (invalid) { results.push(invalid); break }
      const caseScratch = await mkdtemp(join(temporary, 'ion-practice-case-'))
      try {
        const sampleDirectory = join(caseScratch, 'run')
        // Each case starts with fresh source and artifacts, even when the previous case writes to its working directory.
        await cp(build, sampleDirectory, { recursive: true, force: false, errorOnExist: true })
        const relocate = (value: string) => value.replaceAll(build, sampleDirectory)
        const beginRun = performance.now()
        const outcome = await execute(relocate(command.executable), command.args.map(relocate), {
          cwd: command.cwd ? relocate(command.cwd) : sampleDirectory, input, signal, timeoutMs: limits.programMs,
          budget, environment: { ...command.environment, ...processTempEnvironment(sampleDirectory) }, splitOutput: true,
        })
        const [status, message] = outcomeMessage(outcome, 'Program')
        results.push(result(status, message, {
          exitCode: outcome.exitCode, programOutput: outcome.output, programStdout: outcome.stdout, programStderr: outcome.stderr,
          programSignal: outcome.signal, outputComplete: outcome.outputComplete, programMs: Math.round(performance.now() - beginRun),
        }, start))
        if (status === 'cancelled' || status === 'output-limit') break
      } finally {
        await rm(caseScratch, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return results
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start the sample run.'
    results.push(signal.aborted ? result('cancelled', 'Run stopped.')
      : result(error instanceof MissingToolchainError ? 'missing-toolchain' : stage, message))
    return results
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}
