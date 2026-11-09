import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { NotebookOutput } from '../../shared/notebook-format'
import type {
  NotebookKernelEnvironment, NotebookKernelEvent, NotebookKernelRequest, NotebookKernelResult, NotebookKernelStatus,
} from '../../shared/notebook-kernel'
import source from './kernel-broker.py'
import { NotebookPythonEnvironments, notebookPythonEnvironment } from './python-environments'
import { stopWindowsProcessTree } from '../windows-process'

const maxSessions = 2
const maxCommandBytes = 2 * 1024 * 1024
const maxFrameBytes = 9 * 1024 * 1024
const maxRetainedBytes = 10 * 1024 * 1024
const maxFrames = 200
const startTimeoutMs = 18_000
const runTimeoutMs = 126_000
const grouped = process.platform !== 'win32'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protocolId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._-]/.test(value)
}

function requestFrom(value: unknown): NotebookKernelRequest {
  if (!record(value) || !protocolId(value.id) || typeof value.code !== 'string'
    || value.code.length > maxCommandBytes || (value.environmentId !== undefined && !protocolId(value.environmentId))) {
    throw new Error('Invalid notebook execution request.')
  }
  const { id, code, environmentId, preferredName } = value
  return { id, code, environmentId, preferredName: protocolId(preferredName) ? preferredName : undefined }
}

interface PendingRun {
  id: string
  outputs: NotebookOutput[]
  bytes: number
  frames: number
  interrupted: boolean
  timer: NodeJS.Timeout
  resolve: (result: NotebookKernelResult) => void
  reject: (error: Error) => void
}

class KernelSession {
  readonly ready: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly exited: Promise<void>
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly startTimer: NodeJS.Timeout
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private hasExited = false
  private started = false
  private closing?: Promise<void>
  private pending?: PendingRun
  private parts: Buffer[] = []
  private buffered = 0

  constructor(
    readonly environment: NotebookKernelEnvironment,
    private readonly path: string,
    private readonly scratch: string,
    private readonly emit: (event: NotebookKernelEvent) => void,
    private readonly retire: (session: KernelSession, closed: Promise<void>) => void,
  ) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.child = spawn(environment.path, ['-E', '-c', source, dirname(path)], {
      cwd: scratch,
      env: notebookPythonEnvironment(scratch, environment.path),
      detached: grouped,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exited = new Promise((resolve) => {
      const exited = () => { this.hasExited = true; resolve() }
      this.child.once('exit', exited)
      this.child.once('error', exited)
    })
    this.startTimer = setTimeout(() => this.fail(new Error('The local Python kernel took too long to start.')), startTimeoutMs)
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.fail(new Error('Could not send a command to the Python kernel.')))
    this.child.once('error', () => this.fail(new Error('Could not start the selected Python interpreter.')))
    this.child.once('close', () => this.fail(new Error('The local Python kernel exited.')))
  }

  status(): NotebookKernelStatus {
    if (this.closing) return { state: 'stopped' }
    return { state: !this.started ? 'starting' : this.pending ? 'busy' : 'idle', environment: this.environment }
  }

  run(request: NotebookKernelRequest): Promise<NotebookKernelResult> {
    if (!this.started || this.closing || this.pending) throw new Error('The notebook kernel is unavailable or already running a cell.')
    const line = JSON.stringify({ op: 'run', id: request.id, code: request.code }) + '\n'
    if (Buffer.byteLength(line) > maxCommandBytes) throw new Error('This notebook cell exceeds the execution size limit.')
    return new Promise((resolve, reject) => {
      this.pending = { id: request.id, outputs: [], bytes: 0, frames: 0, interrupted: false, resolve, reject,
        timer: setTimeout(() => this.fail(new Error('The notebook cell exceeded its execution time limit.')), runTimeoutMs) }
      this.child.stdin.write(line)
    })
  }

  interrupt(): void {
    if (!this.pending || this.pending.interrupted || this.closing) return
    this.pending.interrupted = true
    this.child.stdin.write('{"op":"interrupt"}\n')
  }

  stop(): Promise<void> {
    return this.close(true)
  }

  private fail(error: Error): void {
    void this.close(false, error)
  }

  private receive(chunk: Buffer): void {
    if (this.closing) return
    try {
      let start = 0
      while (start < chunk.length && !this.closing) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline
        const part = chunk.subarray(start, end)
        this.buffered += part.length
        if (this.buffered > maxFrameBytes) throw new Error('The Python kernel exceeded its output message limit.')
        if (part.length) this.parts.push(part)
        if (newline < 0) return
        const bytes = this.buffered
        const buffer = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, bytes)
        this.parts = []
        this.buffered = 0
        this.message(JSON.parse(this.decoder.decode(buffer)), bytes)
        start = newline + 1
      }
    } catch (error) {
      this.fail(error instanceof SyntaxError || !(error instanceof Error)
        ? new Error('The local Python kernel sent an invalid response.') : error)
    }
  }

  private message(message: unknown, bytes: number): void {
    if (!record(message)) throw new Error('The local Python kernel sent an invalid response.')
    if (message.type === 'ready' && !this.started) {
      this.started = true
      clearTimeout(this.startTimer)
      this.resolveReady()
      return
    }
    if (message.type === 'failure') {
      const detail = typeof message.message === 'string' ? message.message.slice(0, 400) : 'The local Python kernel failed.'
      this.fail(new Error(detail))
      return
    }
    const pending = this.pending
    if (!pending || message.id !== pending.id) return
    if (message.type === 'output') {
      const output = message.output
      if (!record(output) || typeof output.output_type !== 'string') throw new Error('The Python kernel sent invalid cell output.')
      pending.frames++
      pending.bytes += bytes
      if (pending.frames > maxFrames || pending.bytes > maxRetainedBytes) return
      if (output.output_type === 'ion-clear-output') pending.outputs = []
      else pending.outputs.push(output as NotebookOutput)
      this.emit({ path: this.path, id: pending.id, output: output as NotebookOutput })
      return
    }
    if (message.type === 'done') {
      const { count, status } = message
      if ((status !== 'ok' && status !== 'error' && status !== 'interrupted')
        || (count !== null && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0))) {
        throw new Error('The Python kernel sent an invalid execution result.')
      }
      this.pending = undefined
      clearTimeout(pending.timer)
      pending.resolve({ outputs: pending.outputs, count, status })
    }
  }

  private close(graceful: boolean, error?: Error): Promise<void> {
    if (this.closing) return this.closing
    clearTimeout(this.startTimer)
    this.parts = []
    this.buffered = 0
    if (!this.started) this.rejectReady(error ?? new Error('The notebook kernel was stopped before it started.'))
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      if (error) pending.reject(error)
      else pending.resolve({ outputs: pending.outputs, count: null, status: 'interrupted' })
    }
    this.closing = this.shutdown(graceful)
    this.retire(this, this.closing)
    return this.closing
  }

  private async shutdown(graceful: boolean): Promise<void> {
    if (graceful && !this.hasExited) {
      this.child.stdin.end('{"op":"stop"}\n')
      await this.waitForExit(1600)
    }
    // The broker and its local ipykernel child share the group. Release any
    // surviving process even if the broker exited first.
    if (this.child.pid && (grouped || !this.hasExited)) {
      try {
        if (grouped) process.kill(-this.child.pid, 'SIGKILL')
        else await stopWindowsProcessTree(this.child)
      } catch { /* The group may already have exited. */ }
    }
    await this.waitForExit(350)
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    await rm(this.scratch, { recursive: true, force: true }).catch(() => undefined)
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.hasExited) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      void this.exited.then(() => { clearTimeout(timer); resolve() })
    })
  }
}

export class NotebookKernels {
  private readonly python = new NotebookPythonEnvironments()
  private readonly sessions = new Map<string, KernelSession>()
  private readonly operations = new Map<string, symbol>()
  private readonly launching = new Set<symbol>()
  private readonly closing = new Map<string, Promise<void>>()
  private readonly confirmAgain = new Set<string>()
  private disposed = false

  constructor(private readonly emit: (event: NotebookKernelEvent) => void) {}

  discover(): Promise<NotebookKernelEnvironment[]> { return this.python.discover() }
  addInterpreter(path: string): Promise<NotebookKernelEnvironment> { return this.python.add(path) }

  status(path: string): NotebookKernelStatus {
    return this.sessions.get(path)?.status() ?? { state: this.operations.has(path) ? 'starting' : 'stopped' }
  }

  async run(path: string, value: unknown, confirm: (environment: NotebookKernelEnvironment) => Promise<boolean>): Promise<NotebookKernelResult> {
    const request = requestFrom(value)
    const ticket = this.begin(path)
    try {
      let session = this.sessions.get(path)
      if (!session || (request.environmentId && request.environmentId !== session.environment.id)) {
        const environment = await this.selectEnvironment(request)
        this.check(path, ticket)
        if (!await confirm(environment)) return { outputs: [], count: null, status: 'interrupted' }
        this.check(path, ticket)
        if (session) await session.stop()
        session = await this.start(path, environment, ticket)
      } else if (this.confirmAgain.has(path)) {
        if (!await confirm(session.environment)) return { outputs: [], count: null, status: 'interrupted' }
      }
      this.check(path, ticket)
      this.confirmAgain.delete(path)
      return await session.run(request)
    } finally {
      if (this.operations.get(path) === ticket) this.operations.delete(path)
    }
  }

  async restart(path: string): Promise<NotebookKernelStatus> {
    const session = this.sessions.get(path)
    if (!session || session.status().state === 'starting') throw new Error('Start the notebook kernel before restarting it.')
    const renewTrust = this.confirmAgain.has(path)
    this.operations.delete(path)
    const ticket = this.begin(path)
    try {
      await session.stop()
      const restarted = await this.start(path, session.environment, ticket)
      if (renewTrust) this.confirmAgain.add(path)
      return restarted.status()
    } finally {
      if (this.operations.get(path) === ticket) this.operations.delete(path)
    }
  }

  interrupt(path: string): void { this.sessions.get(path)?.interrupt() }

  async stop(path: string): Promise<void> {
    this.operations.delete(path)
    this.confirmAgain.delete(path)
    await (this.sessions.get(path)?.stop() ?? this.closing.get(path))
  }

  async release(path: string, keep: boolean): Promise<void> {
    if (keep && !this.operations.has(path) && this.sessions.get(path)?.status().state === 'idle') {
      // A different file can be published at the same path before it is reopened.
      this.confirmAgain.add(path)
      return
    }
    await this.stop(path)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.python.dispose()
    this.operations.clear()
    this.confirmAgain.clear()
    await Promise.all([...this.sessions.values()].map((session) => session.stop()).concat([...this.closing.values()]))
  }

  private begin(path: string): symbol {
    if (this.disposed) throw new Error('The notebook window has closed.')
    if (this.operations.has(path)) throw new Error('This notebook already has a pending kernel operation.')
    const ticket = Symbol(path)
    this.operations.set(path, ticket)
    return ticket
  }

  private check(path: string, ticket: symbol): void {
    if (this.disposed || this.operations.get(path) !== ticket) throw new Error('The notebook kernel operation was stopped.')
  }

  private async selectEnvironment(request: NotebookKernelRequest): Promise<NotebookKernelEnvironment> {
    let options = this.python.list()
    if (!options.length || (request.environmentId && !options.some(({ id }) => id === request.environmentId))) {
      options = await this.python.discover()
    }
    const environment = request.environmentId ? options.find(({ id }) => id === request.environmentId)
      : options.find(({ names }) => request.preferredName && names?.includes(request.preferredName)) ?? options[0]
    if (!environment) throw new Error('Choose a local Python interpreter with ipykernel and jupyter_client installed.')
    return environment
  }

  private async start(path: string, environment: NotebookKernelEnvironment, ticket: symbol): Promise<KernelSession> {
    await this.closing.get(path)
    this.check(path, ticket)
    if (this.sessions.size + this.launching.size + this.closing.size >= maxSessions) {
      throw new Error(`Ion keeps at most ${maxSessions} notebook kernels. Stop another kernel to continue.`)
    }
    this.launching.add(ticket)
    let scratch: string | undefined
    let session: KernelSession | undefined
    try {
      scratch = await mkdtemp(join(tmpdir(), 'ion-notebook-kernel-'))
      this.check(path, ticket)
      session = new KernelSession(environment, path, scratch, this.emit, (closedSession, closed) => {
        if (this.sessions.get(path) === closedSession) {
          this.sessions.delete(path)
          this.confirmAgain.delete(path)
        }
        this.closing.set(path, closed)
        void closed.finally(() => { if (this.closing.get(path) === closed) this.closing.delete(path) })
      })
      this.sessions.set(path, session)
      this.launching.delete(ticket)
      await session.ready
      this.check(path, ticket)
      return session
    } finally {
      this.launching.delete(ticket)
      if (scratch && !session) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
