import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { monitorWindowsPipeProcess, stopWindowsProcessTree, windowsPipeCommand } from '../windows-process'

const headerLimit = 8 * 1024
const bodyLimit = 8 * 1024 * 1024
const pendingLimit = 64
const requestDeadlineMs = 8_000

export interface DapRequest { seq: number; type: 'request'; command: string; arguments?: unknown }
export interface DapResponse { seq: number; type: 'response'; request_seq: number; success: boolean; command: string; message?: string; body?: unknown }
export interface DapEvent { seq: number; type: 'event'; event: string; body?: unknown }
export type DapMessage = DapRequest | DapResponse | DapEvent

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function validMessage(value: unknown): value is DapMessage {
  if (!record(value) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return false
  if (value.type === 'request') return typeof value.command === 'string' && value.command.length > 0 && value.command.length <= 128
  if (value.type === 'response') return Number.isSafeInteger(value.request_seq) && (value.request_seq as number) > 0
    && typeof value.success === 'boolean' && typeof value.command === 'string' && value.command.length <= 128
  return value.type === 'event' && typeof value.event === 'string' && value.event.length > 0 && value.event.length <= 128
}

/** Incremental, bounded DAP Content-Length decoder. */
export class DapFrameDecoder {
  private bytes = Buffer.alloc(0)
  private bodyLength: number | null = null
  private failed = false
  constructor(private readonly receive: (message: DapMessage) => void, private readonly invalid: (reason: Error) => void) {}

  push(chunk: Buffer) {
    if (this.failed || !chunk.length) return
    this.bytes = this.bytes.length ? Buffer.concat([this.bytes, chunk]) : Buffer.from(chunk)
    for (;;) {
      if (this.bodyLength === null) {
        const boundary = this.bytes.indexOf('\r\n\r\n')
        if (boundary < 0) {
          if (this.bytes.length > headerLimit) this.fail('The debug adapter sent an oversized protocol header.')
          return
        }
        if (boundary + 4 > headerLimit) return this.fail('The debug adapter sent an oversized protocol header.')
        const header = this.bytes.subarray(0, boundary).toString('ascii')
        const lines = header.split('\r\n')
        const matches = lines.filter(line => /^Content-Length:/i.test(line))
        if (matches.length !== 1 || lines.some(line => line && !/^Content-Length:\s*\d+\s*$/i.test(line))) {
          return this.fail('The debug adapter sent an invalid protocol header.')
        }
        const match = /^Content-Length:\s*(\d+)\s*$/i.exec(matches[0])
        const length = match ? Number(match[1]) : NaN
        if (!Number.isSafeInteger(length) || length <= 0 || length > bodyLimit) {
          return this.fail('The debug adapter sent an invalid protocol payload length.')
        }
        this.bodyLength = length
        this.bytes = this.bytes.subarray(boundary + 4)
      }
      if (this.bytes.length < this.bodyLength) return
      const body = this.bytes.subarray(0, this.bodyLength)
      this.bytes = this.bytes.subarray(this.bodyLength)
      this.bodyLength = null
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
        if (!validMessage(value)) return this.fail('The debug adapter sent an invalid protocol message.')
        this.receive(value)
      } catch { return this.fail('The debug adapter sent an invalid protocol payload.') }
    }
  }

  end() { if (!this.failed && (this.bytes.length || this.bodyLength !== null)) this.fail('The debug adapter protocol ended mid-message.') }
  private fail(message: string) {
    if (this.failed) return
    this.failed = true; this.bytes = Buffer.alloc(0); this.invalid(new Error(message))
  }
}

export function encodeDapMessage(message: DapMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (!body.length || body.length > bodyLimit) throw new Error('The debug adapter request exceeds Ion’s protocol limit.')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

interface Pending {
  command: string; resolve(value: unknown): void; reject(reason: Error): void
  timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void
}
interface EventWaiter {
  event: string; predicate?: (body: unknown) => boolean; resolve(body: unknown): void; reject(reason: Error): void
  timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void
}
export interface DapProcessOptions {
  executable: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv
  onEvent?: (event: DapEvent) => void; onExit?: (error?: Error) => void
}

/** Owns one trusted adapter and its protocol/process tree. */
export class DapProcess {
  private sequence = 0
  private stopped = false
  private stopping?: Promise<void>
  private readonly pending = new Map<number, Pending>()
  private readonly retired = new Set<number>()
  private readonly waiters = new Set<EventWaiter>()
  private readonly exited: Promise<void>
  private failure?: Error
  private readonly ownership?: ReturnType<typeof monitorWindowsPipeProcess>

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly options: DapProcessOptions) {
    const decoder = new DapFrameDecoder(message => this.receive(message), error => this.abort(error))
    child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
    child.stdout.once('end', () => decoder.end())
    let stderrBytes = 0
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes = Math.min(64 * 1024, stderrBytes + chunk.length) })
    child.stdin.on('error', () => this.abort(new Error('The debug adapter input closed.')))
    child.once('error', error => this.abort(error))
    this.exited = new Promise(resolve => child.once('close', () => {
      const reason = this.failure ?? (this.stopped ? undefined : new Error('The debug adapter stopped unexpectedly.'))
      this.rejectAll(reason ?? new Error('The debug session ended.')); this.options.onExit?.(reason); resolve()
    }))
    if (process.platform === 'win32') this.ownership = monitorWindowsPipeProcess(child, detail => this.abort(new Error(detail)))
  }

  static async start(options: DapProcessOptions, signal?: AbortSignal): Promise<DapProcess> {
    if (!isAbsolute(options.executable) || options.executable.includes('\0')) throw new Error('Debug adapter executable must be an absolute trusted path.')
    signal?.throwIfAborted()
    const grouped = process.platform !== 'win32'
    const command = grouped ? undefined : windowsPipeCommand(options.executable, [...options.args])
    const child = spawn(command?.executable ?? options.executable, command?.args ?? [...options.args], {
      cwd: options.cwd, env: options.env, windowsHide: true, shell: false, detached: grouped,
      stdio: command ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    const host = new DapProcess(child, options)
    const abort = () => host.abort(signal?.reason instanceof Error ? signal.reason : new Error('Debug adapter start was cancelled.'))
    signal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Debug adapter process startup timed out.')), 5_000) }),
      ])
      return host
    } catch (error) {
      host.abort(error instanceof Error ? error : new Error('Debug adapter process startup failed.')); await host.stop(); throw error
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }

  get pid() { return this.child.pid }
  get closed() { return this.stopped || this.child.exitCode !== null || this.child.signalCode !== null }

  request(command: string, args?: unknown, timeoutMs = requestDeadlineMs, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(this.failure ?? new Error('The debug adapter has stopped.'))
    if (!command || command.length > 128 || this.pending.size >= pendingLimit) return Promise.reject(new Error('The debug adapter request limit was reached.'))
    const seq = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.removePending(seq, true); reject(new Error(`Debug adapter ${command} request timed out.`)) }, timeoutMs)
      const abort = () => { if (this.removePending(seq, true)) reject(signal?.reason instanceof Error ? signal.reason : new Error('Debug adapter request was cancelled.')) }
      if (signal?.aborted) { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('Debug adapter request was cancelled.')); return }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(seq, { command, resolve, reject, timer, signal, abort })
      try { this.child.stdin.write(encodeDapMessage({ seq, type: 'request', command, arguments: args })) }
      catch (error) { this.removePending(seq); reject(error instanceof Error ? error : new Error('Could not write to the debug adapter.')) }
    })
  }

  waitForEvent(event: string, predicate?: (body: unknown) => boolean, timeoutMs = requestDeadlineMs, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(this.failure ?? new Error('The debug adapter has stopped.'))
    return new Promise((resolve, reject) => {
      const waiter = {} as EventWaiter
      Object.assign(waiter, { event, predicate, resolve, reject, signal, timer: setTimeout(() => {
        this.removeWaiter(waiter); reject(new Error(`Debug adapter ${event} event timed out.`))
      }, timeoutMs) })
      const abort = () => { if (this.removeWaiter(waiter)) reject(signal?.reason instanceof Error ? signal.reason : new Error('Debug adapter wait was cancelled.')) }
      waiter.abort = abort
      if (signal?.aborted) { clearTimeout(waiter.timer); reject(signal.reason instanceof Error ? signal.reason : new Error('Debug adapter wait was cancelled.')); return }
      signal?.addEventListener('abort', abort, { once: true }); this.waiters.add(waiter)
    })
  }

  stop(): Promise<void> { return this.stopping ??= this.shutdown() }

  private async shutdown() {
    if (!this.closed) await this.request('disconnect', { restart: false, terminateDebuggee: true, suspendDebuggee: false }, 1_000).catch(() => undefined)
    this.stopped = true; this.child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(() => { void this.forceStop(); resolve() }, 2_000) })]) }
    finally { clearTimeout(timer) }
    await Promise.race([this.exited, new Promise<void>(resolve => setTimeout(resolve, 500))])
    this.ownership?.dispose(); this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy()
  }

  private receive(message: DapMessage) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq)
      if (!pending && this.retired.delete(message.request_seq)) return
      if (!pending || pending.command !== message.command) return this.abort(new Error('The debug adapter returned an unknown or mismatched response.'))
      this.removePending(message.request_seq)
      if (message.success) pending.resolve(message.body)
      else pending.reject(new Error((message.message || `Debug adapter ${message.command} request failed.`).slice(0, 500)))
      return
    }
    if (message.type === 'request') {
      const response: DapResponse = { seq: ++this.sequence, type: 'response', request_seq: message.seq, success: false,
        command: message.command, message: 'Ion does not allow reverse debug-adapter requests.' }
      try { this.child.stdin.write(encodeDapMessage(response)) } catch { this.abort(new Error('Could not reject a reverse debug-adapter request.')) }
      return
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.event !== message.event || waiter.predicate && !waiter.predicate(message.body)) continue
      this.removeWaiter(waiter); waiter.resolve(message.body)
    }
    this.options.onEvent?.(message)
  }

  private removePending(seq: number, retire = false) {
    const pending = this.pending.get(seq); if (!pending) return false
    this.pending.delete(seq); clearTimeout(pending.timer)
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort)
    if (retire) {
      this.retired.add(seq)
      if (this.retired.size > pendingLimit * 2) this.retired.delete(this.retired.values().next().value!)
    }
    return true
  }
  private removeWaiter(waiter: EventWaiter) {
    if (!this.waiters.delete(waiter)) return false
    clearTimeout(waiter.timer)
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
    return true
  }
  private rejectAll(reason: Error) {
    for (const [seq, pending] of [...this.pending]) { this.removePending(seq); pending.reject(reason) }
    for (const waiter of [...this.waiters]) { this.removeWaiter(waiter); waiter.reject(reason) }
    this.retired.clear()
  }
  private abort(reason: Error) { if (!this.failure) { this.failure = reason; this.stopped = true; this.rejectAll(reason); void this.forceStop() } }
  private async forceStop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    if (process.platform === 'win32') {
      const clean = await this.ownership?.requestStop().catch(() => false)
      if (!clean) await stopWindowsProcessTree(this.child)
    } else try { if (this.child.pid) process.kill(-this.child.pid, 'SIGKILL') }
    catch { try { this.child.kill('SIGKILL') } catch { /* Already exited. */ } }
  }
}
