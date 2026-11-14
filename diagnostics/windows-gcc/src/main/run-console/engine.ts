import type { RunResult, RunStatus } from '../../shared/contracts'
import type { RunUpdate } from '../../shared/run-console'
import { defaultRunLimits, execute, rejectedRun } from '../runner'
import { windowsEnvironment, windowsToolPaths } from '../windows-process'
import { startLineConsole } from './line-console'
import type { CommandPlan, RunPlan } from './plans'
import { startPty, type PtySession } from './pty'
import type { RunTrace } from './trace'

const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin'
const interactiveLimits = { ...defaultRunLimits, programMs: 5 * 60_000 }
const maxCompileTimeMs = 2 * 60_000
const batchBytes = 8192
const batchDelayMs = 16

type RunStage = Extract<RunUpdate, { kind: 'phase' }>['phase']
type RunStream = Extract<RunUpdate, { kind: 'data' }>['stream']

function commandEnvironment(command: CommandPlan, locale: string): NodeJS.ProcessEnv {
  const defaults = process.platform === 'win32' ? windowsEnvironment(windowsToolPaths()) : { PATH: systemPath, LANG: locale }
  return { ...defaults, ...command.environment }
}

function publisher(emit: (update: RunUpdate) => void, trace?: RunTrace) {
  let batch = ''
  let stream: RunStream = 'compiler'
  let timer: NodeJS.Timeout | undefined

  function send(update: RunUpdate) {
    trace?.('publish-run-console', 'dispatch-start', update.kind)
    try { emit(update) } catch { /* The window can close while a child writes output. */ }
    finally { trace?.('publish-run-console', 'dispatch-end', update.kind) }
  }

  function flush() {
    clearTimeout(timer)
    timer = undefined
    if (!batch) return
    const text = batch
    batch = ''
    send({ kind: 'data', text, stream })
  }

  return {
    phase(phase: RunStage, label?: string) {
      flush()
      send({ kind: 'phase', phase, label })
    },
    output(kind: RunStream, text: string) {
      if (kind !== stream) flush()
      stream = kind
      batch += text
      if (batch.length >= batchBytes) flush()
      else timer ??= setTimeout(flush, batchDelayMs)
    },
    flush,
  }
}

interface ActiveRun {
  terminal?: PtySession
}

export class InteractiveRunner {
  private active: ActiveRun | undefined
  private columns = 80
  private rows = 24

  constructor(private readonly helperPath: string, private readonly limits = interactiveLimits) {}

  run(
    plan: RunPlan, emit: (event: RunUpdate) => void, signal: AbortSignal,
    sourceStillCurrent?: () => Promise<boolean>,
    trace?: RunTrace,
  ): Promise<RunResult> {
    if (this.active) return Promise.resolve(rejectedRun('A program is already compiling or running.'))
    const active: ActiveRun = {}
    this.active = active
    trace?.('engine', 'start')
    return this.executePlan(plan, active, signal, emit, sourceStillCurrent, trace).finally(() => {
      this.active = undefined
      trace?.('engine', 'cleanup')
    })
  }

  input(data: string): void {
    this.active?.terminal?.input(data)
  }

  resize(columns: number, rows: number): void {
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || columns > 512 || rows < 2 || rows > 512) return
    this.columns = columns
    this.rows = rows
    this.active?.terminal?.resize(columns, rows)
  }

  private async executePlan(
    plan: RunPlan, active: ActiveRun, signal: AbortSignal, emit: (event: RunUpdate) => void,
    sourceStillCurrent?: () => Promise<boolean>,
    trace?: RunTrace,
  ): Promise<RunResult> {
    const start = performance.now()
    const budget = { remaining: this.limits.outputBytes }
    const publish = publisher(emit, trace)
    let compileOutput = ''
    let compileMs: number | undefined
    let compileVerified: true | undefined
    let stage = plan.compile ? 'Compilation' : 'Program'

    function result(status: RunStatus, message: string, detail: Partial<RunResult> = {}): RunResult {
      trace?.('result', status)
      return {
        status, message, compiler: plan.toolchain, compileOutput, compileMs, compileVerified, programOutput: '', exitCode: null,
        durationMs: Math.round(performance.now() - start), ...detail,
      }
    }

    function failed(state: string, reason: string, detail: Partial<RunResult> = {}): RunResult {
      if (state === 'cancelled') return result('cancelled', 'Run stopped.', detail)
      if (state === 'timeout') return result('timeout', stage + ' exceeded its time limit.', detail)
      if (state === 'output-limit') return result('output-limit', stage + ' exceeded the combined output limit.', detail)
      return result(stage === 'Compilation' ? 'compile-error' : 'runtime-error', stage + ' failed (' + reason + ').', detail)
    }

    try {
      if (signal.aborted) return result('cancelled', 'Run stopped.')
      trace?.('source-check-before-compile', 'start')
      const sourceBeforeCompile = !sourceStillCurrent || await sourceStillCurrent()
      trace?.('source-check-before-compile', 'end', sourceBeforeCompile)
      if (!sourceBeforeCompile) {
        return signal.aborted ? result('cancelled', 'Run stopped.')
          : result('rejected', 'The source or workspace changed. Review it and run again.')
      }
      if (signal.aborted) return result('cancelled', 'Run stopped.')
      if (plan.compile) {
        publish.phase('compiling', plan.label)
        const compileStart = performance.now()
        trace?.('compile', 'start')
        const compiled = await execute(plan.compile.executable, plan.compile.args, {
          cwd: plan.compile.cwd ?? plan.cwd,
          input: plan.compile.input ?? '',
          signal,
          timeoutMs: Math.min(maxCompileTimeMs, plan.compile.timeoutMs ?? this.limits.compileMs),
          budget,
          environment: commandEnvironment(plan.compile, 'C'),
          onOutput: (text) => publish.output('compiler', text),
          trace,
        })
        trace?.('compile', 'end', compiled.state)
        compileMs = Math.round(performance.now() - compileStart)
        compileOutput = compiled.output
        const detail = { exitCode: compiled.exitCode, outputComplete: compiled.outputComplete }
        if (compiled.state !== 'exited' || compiled.exitCode !== 0) {
          return failed(compiled.state, compiled.detail ?? 'exit code ' + String(compiled.exitCode), detail)
        }
        if (compiled.outputComplete === false) {
          return result('compile-error', 'A compiler child kept output open. Compilation could not be verified.', detail)
        }
        if (compiled.outputComplete === true) compileVerified = true
      }

      if (signal.aborted) return result('cancelled', 'Run stopped.')
      trace?.('resolve-program', 'start')
      const command = plan.resolveRun ? await plan.resolveRun() : plan.run
      trace?.('resolve-program', 'end')
      trace?.('source-check-before-program', 'start')
      const sourceBeforeProgram = !sourceStillCurrent || await sourceStillCurrent()
      trace?.('source-check-before-program', 'end', sourceBeforeProgram)
      if (!sourceBeforeProgram) {
        return signal.aborted ? result('cancelled', 'Run stopped.')
          : result('rejected', 'The source or workspace changed. Review it and run again.')
      }
      if (signal.aborted) return result('cancelled', 'Run stopped.')

      stage = 'Program'
      const programStart = performance.now()
      // Flush any compiler output before PTY data arrives on another pipe.
      publish.flush()
      const terminalOptions = {
        helper: this.helperPath,
        executable: command.executable,
        args: command.args,
        cwd: command.cwd ?? plan.cwd,
        environment: commandEnvironment(command, 'en_US.UTF-8'),
        columns: this.columns,
        rows: this.rows,
        signal,
        timeoutMs: Math.min(this.limits.programMs, command.timeoutMs ?? this.limits.programMs),
        budget,
        ready: () => { trace?.('program', 'ready'); publish.phase('running', plan.label) },
        onOutput: (text: string) => publish.output('terminal', text),
        trace,
      }
      trace?.('program', 'launch-requested')
      let terminal = startPty(terminalOptions)
      active.terminal = terminal
      let ran = await terminal.result
      trace?.('program', 'end', ran.state)
      if (ran.unavailable && !signal.aborted) {
        const remaining = Math.floor(terminalOptions.timeoutMs - (performance.now() - programStart))
        if (remaining <= 0) return failed('timeout', 'The program could not start within its time limit.')
        publish.output('terminal', 'Windows pseudoconsole unavailable. Using line input.\r\n')
        trace?.('program', 'line-launch-requested')
        terminal = startLineConsole({ ...terminalOptions, timeoutMs: remaining })
        active.terminal = terminal
        ran = await terminal.result
      }
      const detail = {
        exitCode: ran.exitCode, programSignal: ran.signal, outputComplete: ran.outputComplete,
        programMs: Math.round(performance.now() - programStart),
      }
      if (ran.state !== 'exited' || ran.exitCode !== 0) {
        return failed(ran.state, ran.detail ?? ran.signal ?? 'exit code ' + String(ran.exitCode), detail)
      }
      return result('success', ran.outputComplete
        ? 'Program exited successfully.'
        : 'Program exited successfully. A descendant kept the terminal open, so output may be incomplete.', detail)
    } catch (error) {
      return signal.aborted ? result('cancelled', 'Run stopped.') : failed('error',
        error instanceof Error ? error.message : 'Unable to start the process.')
    } finally {
      publish.flush()
      trace?.('output', 'flushed')
    }
  }
}
