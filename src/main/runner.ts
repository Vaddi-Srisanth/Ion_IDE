import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { RunResult, RunStatus } from '../shared/contracts'
import { processTempEnvironment, windowsEnvironment, windowsPipeCommand, monitorWindowsPipeProcess, workspaceSafeWindowsToolPaths } from './windows-process'

const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin'
const maxInputBytes = 64 * 1024
export const defaultRunLimits = { compileMs: 15_000, programMs: 5_000, outputBytes: 256 * 1024 }
const cArguments = (source: string, binary: string) => [
  '-x', 'c', '-std=c17', '-Wall', '-Wextra', '-fdiagnostics-color=never', source, '-o', binary,
]
const cBinaryName = process.platform === 'win32' ? 'program.exe' : 'program'

type ProcessState = 'exited' | 'timeout' | 'output-limit' | 'cancelled' | 'error'
interface ProcessResult {
  state: ProcessState
  exitCode: number | null
  output: string
  detail?: string
  stdout?: string
  stderr?: string
  signal?: string
  outputComplete?: boolean
}

interface ProcessOptions {
  cwd: string
  input: string
  signal: AbortSignal
  timeoutMs: number
  budget: { remaining: number }
  environment: NodeJS.ProcessEnv
  splitOutput?: boolean
  collectOutput?: boolean
  onOutput?: (text: string) => void
  interactive?: (write: (text: string | null) => boolean) => void
}

export function execute(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal.aborted) return Promise.resolve({ state: 'cancelled', exitCode: null, output: '' })
  return new Promise((resolve) => {
    const grouped = process.platform !== 'win32'
    let command: ReturnType<typeof windowsPipeCommand> | undefined
    try { if (!grouped) command = windowsPipeCommand(executable, args) } catch (error) {
      resolve({ state: 'error', exitCode: null, output: '', detail: error instanceof Error ? error.message : 'Windows process helper unavailable.' })
      return
    }
    const child = spawn(command?.executable ?? executable, command?.args ?? args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: command ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      detached: grouped,
      shell: false,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
    const stdout = new StringDecoder()
    const stderr = new StringDecoder()
    const chunks: string[] = []
    const stdoutChunks = options.splitOutput ? [] as string[] : undefined
    const stderrChunks = options.splitOutput ? [] as string[] : undefined
    let state: ProcessState = 'exited'
    let guard: NodeJS.Timeout | undefined
    let finished = false
    let detail: string | undefined
    let exitSignal: NodeJS.Signals | null = null
    let termination: Promise<boolean> | undefined

    function killGroup() {
      if (!child.pid) return
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL')
        else if (child.exitCode === null && child.signalCode === null) {
          termination ??= ownership?.requestStop() ?? Promise.resolve(false)
        }
      } catch {
        // The child may already have exited.
      }
    }

    function finish(exitCode: number | null, signal?: NodeJS.Signals | null, outputComplete = true) {
      if (finished) return
      finished = true
      if (ownership && !ownership.verified) {
        if (state === 'exited') state = 'error'
        detail ??= ownership.detail ?? 'The Windows process exited without verified descendant cleanup.'
        outputComplete = false
      }
      ownership?.dispose()
      clearTimeout(timer)
      clearTimeout(guard)
      options.signal.removeEventListener('abort', cancel)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      append(stdout.end(), stdoutChunks)
      append(stderr.end(), stderrChunks)
      const result = {
        state, exitCode, output: chunks.join(''), detail: detail ?? signal ?? exitSignal ?? undefined,
        stdout: stdoutChunks?.join(''), stderr: stderrChunks?.join(''),
        outputComplete: outputComplete && state !== 'output-limit', signal: signal ?? exitSignal ?? undefined,
      }
      resolve(result)
    }

    function stop(reason: ProcessState) {
      if (state !== 'exited') return
      state = reason
      killGroup()
      if (ownership) {
        // Wait for native Stop/Job-drain/reader cleanup acknowledgement. A
        // timeout falls back only to the retained helper and remains unverified.
        void termination?.then(() => { if (!finished) finish(child.exitCode, child.signalCode, ownership.verified) })
      } else {
        // POSIX descendants can detach and retain a pipe indefinitely.
        guard = setTimeout(() => finish(null, undefined, false), 250)
      }
    }

    function cancel() {
      stop('cancelled')
    }

    function append(text: string, stream?: string[]) {
      if (!text) return
      if (!options.interactive && options.collectOutput !== false) chunks.push(text)
      stream?.push(text)
      options.onOutput?.(text)
    }

    function collect(data: Buffer, decoder: StringDecoder, stream?: string[]) {
      if (state !== 'exited') return
      const count = Math.min(data.length, options.budget.remaining)
      if (count > 0) append(decoder.write(data.subarray(0, count)), stream)
      options.budget.remaining -= count
      if (count < data.length) stop('output-limit')
    }

    const ownership = command ? monitorWindowsPipeProcess(child, (message) => {
      detail = message
      stop('error')
    }) : undefined
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs)
    options.signal.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, stdout, stdoutChunks))
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, stderr, stderrChunks))
    child.stdin.on('error', () => undefined)
    child.once('error', (error) => {
      if (state === 'exited') state = 'error'
      detail = error.message
      finish(null)
    })
    child.once('exit', (code, signal) => {
      exitSignal = signal
      killGroup()
      if (guard) return
      clearTimeout(timer)
      // A detached descendant can hold the pipes open after the leader exits.
      // Drain what is available, then release Electron's pipe handles promptly.
      guard = setTimeout(() => finish(code, signal, false), 250)
    })
    child.once('close', finish)
    if (options.interactive) {
      child.once('spawn', () => {
        if (state !== 'exited' || finished) return
        options.interactive!((text) => {
          if (state !== 'exited' || finished || !child.stdin.writable) return false
          if (text === null) child.stdin.end()
          else {
            if (child.stdin.writableLength + Buffer.byteLength(text) > maxInputBytes) return false
            child.stdin.write(text)
          }
          return true
        })
      })
    } else child.stdin.end(options.input)
  })
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function findWindowsCompiler(paths: string[], cwd: string, cpp = false): Promise<string | null> {
  for (const directory of paths.slice(0, 80)) {
    for (const name of cpp ? ['clang++.exe', 'g++.exe'] : ['clang.exe', 'gcc.exe']) {
      const candidate = join(directory, name)
      const canonical = await realpath(candidate).catch(() => null)
      if (!canonical) continue
      const relation = relative(cwd, canonical)
      if ((relation === '..' || relation.startsWith('..' + sep) || isAbsolute(relation))
        && await stat(canonical).then((entry) => entry.isFile(), () => false)) return canonical
    }
  }
  return null
}

export function compilerSetupMessage(language: 'C' | 'C++'): string {
  const guidance = process.platform === 'win32' ? 'Add LLVM Clang or MinGW-w64 GCC to PATH, then reopen Ion.'
    : process.platform === 'darwin' ? 'Install Xcode Command Line Tools or Homebrew GCC.'
      : 'Install GCC or Clang.'
  return 'A local ' + language + ' compiler is required. ' + guidance
}

export async function detectCompiler(signal: AbortSignal, cwd?: string, paths?: string[]): Promise<string | null> {
  if (process.platform === 'win32' && cwd) return findWindowsCompiler(paths ?? await workspaceSafeWindowsToolPaths(cwd), cwd)
  if (process.platform === 'darwin') {
    const selection = await execute('/usr/bin/xcode-select', ['-p'], {
      cwd: '/', input: '', signal, timeoutMs: 2000, budget: { remaining: 8192 },
      environment: { PATH: systemPath, LANG: 'C' },
    })
    if (selection.exitCode === 0 && selection.output.trim().startsWith('/')
      && await executable('/usr/bin/clang')) return '/usr/bin/clang'
    for (const prefix of ['/opt/homebrew/bin', '/usr/local/bin']) {
      const names = await readdir(prefix).catch(() => [])
      const candidates = names.filter((name) => /^gcc-\d+$/.test(name))
        .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)))
      for (const candidate of [...candidates, 'gcc']) {
        const path = join(prefix, candidate)
        if (await executable(path)) return path
      }
    }
  }
  if (process.platform === 'linux') {
    for (const candidate of ['/usr/bin/clang', '/usr/bin/gcc']) {
      if (await executable(candidate)) return candidate
    }
  }
  return null
}

export function validStdin(value: unknown): string {
  if (typeof value !== 'string' || value.length > maxInputBytes || Buffer.byteLength(value) > maxInputBytes) {
    throw new Error('Standard input must be text up to 64 KiB.')
  }
  return value
}

export function rejectedRun(message: string): RunResult {
  return {
    status: 'rejected', message, compiler: null, compileOutput: '', programOutput: '', exitCode: null, durationMs: 0,
  }
}

export class CRunner {
  private active: { controller: AbortController; job: Promise<RunResult[]> } | null = null
  private compiler: string | null = null

  constructor(
    private readonly limits = defaultRunLimits,
    private readonly locate = detectCompiler,
  ) {}

  get busy(): boolean {
    return this.active !== null
  }

  async preview(path: string, signal: AbortSignal, snapshot = false) {
    const cwd = dirname(path)
    const executable = this.compiler && process.platform !== 'win32'
      ? this.compiler : await this.locate(signal, process.platform === 'win32' ? cwd : undefined)
    const program = join('<Ion temporary directory>', cBinaryName)
    return {
      cwd, executable, args: cArguments(snapshot ? '-' : path, program), program,
      limits: this.limits,
    }
  }

  async run(path: string, stdin: string, sourceStillCurrent?: () => Promise<boolean>): Promise<RunResult> {
    return (await this.runInputs(path, [stdin], sourceStillCurrent))[0]
  }

  async runSavedSnapshot(
    path: string, text: string, stdin: string, sourceStillCurrent: () => Promise<boolean>, signal: AbortSignal,
  ): Promise<RunResult> {
    return (await this.runInputs(path, [validStdin(stdin)], sourceStillCurrent, signal, text))[0]
  }

  runSamples(
    path: string, inputs: readonly string[], sourceStillCurrent: () => Promise<boolean>, batchSignal?: AbortSignal, snapshot?: string,
  ): Promise<RunResult[]> {
    if (inputs.length < 1 || inputs.length > 8) throw new Error('Run between one and eight samples at a time.')
    return this.runInputs(path, inputs.map(validStdin), sourceStillCurrent, batchSignal, snapshot)
  }

  private runInputs(
    path: string, inputs: readonly string[], sourceStillCurrent?: () => Promise<boolean>, batchSignal?: AbortSignal,
    snapshot?: string,
  ): Promise<RunResult[]> {
    if (this.active) return Promise.resolve([rejectedRun('A program is already compiling or running.')])
    const controller = new AbortController()
    const signal = batchSignal ? AbortSignal.any([controller.signal, batchSignal]) : controller.signal
    const job = this.runJob(path, inputs, signal, sourceStillCurrent, snapshot).finally(() => { this.active = null })
    this.active = { controller, job }
    return job
  }

  stop(): void {
    this.active?.controller.abort()
  }

  async drain(): Promise<void> {
    const active = this.active
    active?.controller.abort()
    await active?.job
  }

  private async runJob(
    path: string, inputs: readonly string[], signal: AbortSignal, sourceStillCurrent?: () => Promise<boolean>,
    snapshot?: string,
  ): Promise<RunResult[]> {
    const start = performance.now()
    const budget = { remaining: this.limits.outputBytes }
    const results: RunResult[] = []
    const filename = cBinaryName
    const cwd = dirname(path)
    let temporary: string | undefined
    let compileOutput = ''
    let compileMs: number | undefined
    let stage: 'Compilation' | 'Program' = 'Compilation'

    const result = (
      status: RunStatus, message: string, detail: Partial<RunResult> = {}, since = start,
    ): RunResult => ({
      status, message, compiler: this.compiler, compileOutput,
      programOutput: '', exitCode: null, compileMs: results.length ? undefined : compileMs,
      durationMs: Math.round(performance.now() - since), ...detail,
    })

    const failedStage = (outcome: ProcessResult, detail: Partial<RunResult>, since = start): RunResult => {
      if (outcome.state === 'cancelled') return result('cancelled', 'Run stopped.', detail, since)
      if (outcome.state === 'timeout') return result('timeout', stage + ' exceeded its time limit.', detail, since)
      if (outcome.state === 'output-limit') return result('output-limit', stage + ' exceeded the combined output limit.', detail, since)
      const reason = outcome.detail ?? 'exit code ' + String(outcome.exitCode)
      return result(stage === 'Compilation' ? 'compile-error' : 'runtime-error', stage + ' failed (' + reason + ').', detail, since)
    }

    try {
      if (signal.aborted) return [result('cancelled', 'Run stopped.')]
      const paths = process.platform === 'win32' ? await workspaceSafeWindowsToolPaths(cwd) : undefined
      if (paths) this.compiler = await this.locate(signal, cwd, paths)
      else this.compiler ??= await this.locate(signal)
      if (signal.aborted) return [result('cancelled', 'Run stopped.')]
      if (!this.compiler) {
        return [result('missing-toolchain', compilerSetupMessage('C'))]
      }
      temporary = await mkdtemp(join(tmpdir(), 'ion-c-'))
      const binary = join(temporary, filename)
      const environment = paths ? windowsEnvironment(paths, temporary)
        : { PATH: systemPath, LANG: 'C', LC_ALL: 'C', TMPDIR: temporary }
      let compileInput = ''
      if (snapshot !== undefined) {
        if (!await sourceStillCurrent?.()) return [result('rejected', 'The approved source or test changed before compilation.')]
        // Use the checked bytes, even if another process replaces the source path at spawn time.
        const escapedPath = Array.from(Buffer.from(path), byte =>
          byte >= 32 && byte <= 126 && byte !== 34 && byte !== 63 && byte !== 92
            ? String.fromCharCode(byte) : '\\' + byte.toString(8).padStart(3, '0'),
        ).join('')
        compileInput = '#line 1 "' + escapedPath + '"\n' + snapshot.replace(/^\uFEFF/, '')
      }
      const compileStart = performance.now()
      const compiled = await execute(this.compiler, cArguments(snapshot === undefined ? path : '-', binary),
        { cwd, input: compileInput, signal, timeoutMs: this.limits.compileMs, budget, environment })
      compileMs = Math.round(performance.now() - compileStart)
      compileOutput = compiled.output
      if (compiled.state !== 'exited' || compiled.exitCode !== 0) {
        return [failedStage(compiled, { exitCode: compiled.exitCode })]
      }
      if (compiled.outputComplete === false) {
        return [result('compile-error', 'A compiler child kept output open. Compilation could not be verified.', {
          exitCode: compiled.exitCode, outputComplete: false,
        })]
      }

      for (const input of inputs) {
        const since = results.length ? performance.now() : start
        if (signal.aborted) {
          results.push(result('cancelled', 'Run stopped.', {}, since))
          break
        }
        if (sourceStillCurrent && !await sourceStillCurrent()) {
          const operation = results.length ? 'the run' : 'compilation'
          results.push(result('rejected', 'The source changed during ' + operation + '. Review it and run again.', {
            exitCode: compiled.exitCode,
          }, since))
          break
        }
        if (signal.aborted) {
          results.push(result('cancelled', 'Run stopped.', {}, since))
          break
        }

        stage = 'Program'
        // Each sample receives its own temporary files and executable. Keep the compiled
        // artifact out of the program's TMPDIR and discard it when the batch ends.
        const sampleDirectory = inputs.length > 1 ? await mkdtemp(join(tmpdir(), 'ion-c-sample-')) : undefined
        try {
          const program = sampleDirectory ? join(sampleDirectory, filename) : binary
          if (sampleDirectory) await copyFile(binary, program)
          const programStart = performance.now()
          const ran = await execute(program, [], {
            cwd, input, signal, timeoutMs: this.limits.programMs, budget: { remaining: budget.remaining },
            environment: sampleDirectory ? { ...environment, ...processTempEnvironment(sampleDirectory) } : environment, splitOutput: true,
          })
          const detail = {
            exitCode: ran.exitCode, programOutput: ran.output, programStdout: ran.stdout, programStderr: ran.stderr,
            programSignal: ran.signal, outputComplete: ran.outputComplete, programMs: Math.round(performance.now() - programStart),
          }
          results.push(ran.state !== 'exited' || ran.exitCode !== 0
            ? failedStage(ran, detail, since)
            : result('success', ran.outputComplete === false
              ? 'Program exited, but a descendant kept the output stream open. Output may be incomplete.'
              : 'Program exited successfully.', detail, since))
          if (ran.state === 'cancelled') break
        } finally {
          if (sampleDirectory) await rm(sampleDirectory, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    } catch (error) {
      results.push(result(stage === 'Compilation' ? 'compile-error' : 'runtime-error',
        error instanceof Error ? error.message : 'Unable to start the process.'))
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    }
    return results
  }
}
