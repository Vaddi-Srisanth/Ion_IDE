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
}

export interface PtyOptions {
  helper: string
  executable: string
  args: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  columns: number
  rows: number
  signal: AbortSignal
  timeoutMs: number
  budget: { remaining: number }
  ready(): void
  onOutput(text: string): void
}

export interface PtySession {
  input(data: string): void
  resize(columns: number, rows: number): void
  result: Promise<PtyResult>
}

export function startPty(options: PtyOptions): PtySession {
  if (options.signal.aborted) {
    return {
      input: () => {},
      resize: () => {},
      result: Promise.resolve({ state: 'cancelled', exitCode: null, outputComplete: true }),
    }
  }

  const child = spawn(options.helper, [String(options.columns), String(options.rows), options.executable, ...options.args], {
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
  let started = false
  let finished = false
  let lastSize = [options.columns, options.rows]

  function collect(text: string) {
    if (!text) return
    // The status and terminal pipes are independently scheduled.
    if (started) options.onOutput(text)
    else earlyOutput += text
  }

  function stop(reason: PtyState) {
    if (state !== 'exited' || finished) return
    state = reason
    if (reason === 'output-limit') outputComplete = false
    child.kill('SIGTERM')
    // Normally the helper owns group termination and reaping. The guard is
    // only for a lost or unresponsive helper, after its normal grace period.
    guard = setTimeout(() => {
      if (programPid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-programPid, 'SIGKILL') } catch { /* The program already exited. */ }
      }
      child.kill('SIGKILL')
    }, 1_000)
  }
  const abort = () => stop('cancelled')
  const timer = setTimeout(() => stop('timeout'), options.timeoutMs)
  options.signal.addEventListener('abort', abort, { once: true })

  function send(opcode: number, bytes: Buffer) {
    if (!started || finished || state !== 'exited' || !child.stdin.writable) return
    if (child.stdin.writableLength + bytes.length + 3 > maxPendingBytes) return
    const frame = Buffer.allocUnsafe(bytes.length + 3)
    frame[0] = opcode
    frame.writeUInt16BE(bytes.length, 1)
    bytes.copy(frame, 3)
    child.stdin.write(frame)
  }

  child.stdin.on('error', () => {})
  child.stdout.on('data', (bytes: Buffer) => {
    if (finished) return
    const count = Math.min(bytes.length, options.budget.remaining)
    if (count > 0) collect(decoder.write(bytes.subarray(0, count)))
    options.budget.remaining -= count
    if (count < bytes.length) {
      outputComplete = false
      stop('output-limit')
    }
  })
  child.stderr.on('data', (bytes: Buffer) => {
    helperLine += bytes.toString('utf8')
    for (;;) {
      const newline = helperLine.indexOf('\n')
      if (newline < 0) break
      const line = helperLine.slice(0, newline)
      helperLine = helperLine.slice(newline + 1)
      if (line === 'INCOMPLETE') outputComplete = false
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

  let detail: string | undefined
  const result = new Promise<PtyResult>((resolve) => {
    child.on('error', (error) => {
      if (state === 'exited') state = 'error'
      detail = error.message
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
        detail ??= 'The Run Console could not open a pseudoterminal.'
      }
      // A forced helper signal is not evidence of a signal from the program.
      resolve({ state, exitCode, signal: state === 'exited' ? signal ?? undefined : undefined,
        outputComplete, detail })
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
    resize,
    result,
  }
}
