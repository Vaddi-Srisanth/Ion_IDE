import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

const maxFrameBytes = 16 * 1024
const maxPendingBytes = 64 * 1024

type PtyState = 'exited' | 'cancelled' | 'timeout' | 'output-limit' | 'error'

interface PtyResult {
  state: PtyState
  exitCode: number | null
  signal?: string
  outputComplete: boolean
  detail?: string
  unavailable?: boolean
}

interface PtyLaunchOptions {
  helper: string
  executable: string
  args: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  columns: number
  rows: number
  signal: AbortSignal
  ready(): void
  onOutput(text: string): void
}

export interface PtyOptions extends PtyLaunchOptions {
  timeoutMs: number
  budget: { remaining: number }
}

interface ShellPtyOptions extends PtyLaunchOptions {
  shell: true
}

export interface PtySession {
  input(data: string): void
  resize(columns: number, rows: number): void
  result: Promise<PtyResult>
}

interface ShellPtySession extends PtySession {
  pauseOutput(): void
  resumeOutput(): void
  writeInput(data: string): Promise<void>
}

export function startPty(options: PtyOptions): PtySession
export function startPty(options: ShellPtyOptions): ShellPtySession
export function startPty(options: PtyOptions | ShellPtyOptions): ShellPtySession {
  if (options.signal.aborted) {
    return {
      input: () => {},
      resize: () => {},
      pauseOutput: () => {},
      resumeOutput: () => {},
      writeInput: () => Promise.reject(new Error('The terminal session has closed.')),
      result: Promise.resolve({ state: 'cancelled', exitCode: null, outputComplete: true }),
    }
  }

  const shell = 'shell' in options
  const windows = process.platform === 'win32'
  const mode = shell ? ['--shell'] : []
  const child = spawn(options.helper, [String(options.columns), String(options.rows), ...mode, options.executable, ...options.args], {
    cwd: options.cwd,
    env: { ...options.environment, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const decoder = new StringDecoder()
  let state: PtyState = 'exited'
  let programPid: number | undefined
  let guard: NodeJS.Timeout | undefined
  let helperLine = ''
  let earlyOutput = ''
  let outputComplete = true
  let detail: string | undefined
  let unavailable = false
  let started = false
  let finished = false
  let lastSize = [options.columns, options.rows]

  function collect(text: string) {
    if (!text) return
    // The status and terminal pipes are independently scheduled.
    if (started) options.onOutput(text)
    else {
      earlyOutput += text
      if (shell) child.stdout.pause()
    }
  }

  function stop(reason: PtyState) {
    if (state !== 'exited' || finished) return
    state = reason
    if (reason === 'output-limit') outputComplete = false
    if (windows) child.stdin.end(Buffer.from([0x53, 0, 0]))
    else child.kill('SIGTERM')
    // The consumer can still be waiting on a paint acknowledgement when a shell is closed.
    // Drain its pipe so Node can observe the helper exit.
    if (shell) child.stdout.resume()
    // Normally the helper owns group termination and reaping. The guard is
    // only for a lost or unresponsive helper, after its normal grace period.
    guard = setTimeout(() => {
      if (windows && child.exitCode === null && child.signalCode === null) outputComplete = false
      if (!windows && programPid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-programPid, 'SIGKILL') } catch { /* The program already exited. */ }
      }
      child.kill('SIGKILL')
    }, windows ? 3_500 : 1_000)
  }
  const abort = () => stop('cancelled')
  const timer = !shell ? setTimeout(() => stop('timeout'), options.timeoutMs) : undefined
  options.signal.addEventListener('abort', abort, { once: true })

  function send(opcode: number, bytes: Buffer, written?: (error?: Error | null) => void): boolean {
    if (!started || finished || state !== 'exited' || !child.stdin.writable) return false
    if (child.stdin.writableLength + bytes.length + 3 > maxPendingBytes) return false
    const frame = Buffer.allocUnsafe(bytes.length + 3)
    frame[0] = opcode
    frame.writeUInt16BE(bytes.length, 1)
    bytes.copy(frame, 3)
    child.stdin.write(frame, written)
    return true
  }

  child.stdin.on('error', () => {})
  child.stdout.on('data', (bytes: Buffer) => {
    if (finished) return
    if (shell) {
      if (state === 'exited') collect(decoder.write(bytes))
      return
    }
    const count = Math.min(bytes.length, options.budget.remaining)
    if (count > 0) collect(decoder.write(bytes.subarray(0, count)))
    options.budget.remaining -= count
    if (count < bytes.length) {
      outputComplete = false
      stop('output-limit')
    }
  })
  if (shell) child.stdout.pause()
  child.stderr.on('data', (bytes: Buffer) => {
    helperLine += bytes.toString('utf8')
    for (;;) {
      const newline = helperLine.indexOf('\n')
      if (newline < 0) break
      const line = helperLine.slice(0, newline).replace(/\r$/, '')
      helperLine = helperLine.slice(newline + 1)
      if (line === 'INCOMPLETE') outputComplete = false
      if (windows && line === 'UNAVAILABLE' && !started) unavailable = true
      if (windows && /^ERROR \d+$/.test(line)) {
        detail = 'Windows could not start the pseudoconsole (code ' + line.slice(6) + ').'
      }
      const ready = /^READY ([1-9]\d*)$/.exec(line)
      if (ready && !started) {
        programPid = Number(ready[1])
        started = true
        if (state === 'exited') {
          options.ready()
          if (lastSize[0] !== options.columns || lastSize[1] !== options.rows) resize(lastSize[0], lastSize[1])
        }
        if (earlyOutput) {
          options.onOutput(earlyOutput)
          earlyOutput = ''
        }
      }
    }
    helperLine = helperLine.slice(-1024)
  })

  const result = new Promise<PtyResult>((resolve) => {
    child.on('error', (error) => {
      if (state === 'exited') state = 'error'
      if (windows && !started && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        unavailable = true
        detail = 'The Windows terminal helper is missing. Reinstall Ion from the Windows installer.'
      } else detail = error.message
    })
    child.once('close', (exitCode, signal) => {
      finished = true
      clearTimeout(timer)
      clearTimeout(guard)
      options.signal.removeEventListener('abort', abort)
      collect(decoder.end())
      if (earlyOutput) options.onOutput(earlyOutput)
      if (state === 'exited' && !started) {
        state = 'error'
        detail ??= unavailable ? 'Windows pseudoconsole support is unavailable. Install a current Windows build of Ion on Windows 10 (1809 or later) or Windows 11.'
          : shell ? 'The terminal could not open a pseudoterminal.' : 'The Run Console could not open a pseudoterminal.'
      }
      // A forced helper signal is not evidence of a signal from the program.
      resolve({ state, exitCode, signal: state === 'exited' ? signal ?? undefined : undefined,
        outputComplete, detail, unavailable: unavailable && !started && state === 'error' })
    })
  })

  function resize(columns: number, rows: number) {
    lastSize = [columns, rows]
    const size = Buffer.alloc(4)
    size.writeUInt16BE(columns, 0)
    size.writeUInt16BE(rows, 2)
    send(0x52, size)
  }

  return {
    input(data) {
      if (!started || finished || state !== 'exited' || data.length > maxFrameBytes) return
      const bytes = Buffer.from(data)
      if (bytes.length && bytes.length <= maxFrameBytes) send(0x44, bytes)
    },
    writeInput(data) {
      const bytes = Buffer.from(data)
      if (!bytes.length || bytes.length > maxFrameBytes) return Promise.reject(new Error('Send at most 16 KiB per terminal input chunk.'))
      return new Promise((resolve, reject) => {
        if (!send(0x44, bytes, (error) => error ? reject(error) : resolve())) {
          reject(new Error('The terminal session is closed or its input buffer is busy.'))
        }
      })
    },
    pauseOutput() { child.stdout.pause() },
    resumeOutput() { child.stdout.resume() },
    resize,
    result,
  }
}
