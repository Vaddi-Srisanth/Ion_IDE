import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node'
import { stopWindowsProcessTree } from '../windows-process'

const requestDeadlineMs = 8_000
const stopDeadlineMs = 1_500
const stderrLimit = 64 * 1024

export interface LspProcessOptions {
  executable: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  root: string | null
  initializationOptions?: unknown
  capabilities?: object
}

/** A bounded owner for one trusted, absolute local language-server process. */
export class LspProcess {
  private readonly connection: MessageConnection
  private readonly closed: Promise<void>
  private readonly exited: Promise<void>
  private stopped = false
  private stopping?: Promise<void>
  private stderrBytes = 0

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.connection = createMessageConnection(child.stdout, child.stdin)
    this.closed = new Promise(resolve => child.once('close', () => resolve()))
    this.exited = new Promise(resolve => child.once('exit', () => resolve()))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength
      if (this.stderrBytes > stderrLimit) this.child.stderr.pause()
    })
    child.once('error', () => this.abort())
    child.stdin.once('error', () => this.abort())
    this.connection.onClose(() => this.abort())
    // A server cannot write files through LSP. Ion applies reviewed edits only
    // through its own authorized filesystem and Monaco edit paths.
    this.connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'Ion requires user-reviewed workspace edits.' }))
    this.connection.listen()
  }

  static async start(options: LspProcessOptions, signal: AbortSignal): Promise<LspProcess> {
    if (!isAbsolute(options.executable) || options.executable.includes('\0')) {
      throw new Error('Language server executable must be an absolute trusted path.')
    }
    signal.throwIfAborted()
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const processHost = new LspProcess(child)
    const abort = () => processHost.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await processHost.request('initialize', {
        processId: process.pid,
        rootUri: options.root ? pathToFileURL(options.root).href : null,
        workspaceFolders: options.root ? [{ uri: pathToFileURL(options.root).href, name: options.root.split(/[/\\]/).at(-1) ?? 'workspace' }] : null,
        capabilities: options.capabilities ?? { general: { positionEncodings: ['utf-16'] } },
        initializationOptions: options.initializationOptions,
      })
      await processHost.notify('initialized', {})
      return processHost
    } catch (error) {
      await processHost.stop()
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  get isClosed() { return this.stopped }
  get pid() { return this.child.pid }

  onNotification(method: string, handler: (params: unknown) => void) {
    return this.connection.onNotification(method, handler)
  }

  notify(method: string, params: unknown): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('The language server has stopped.'))
    return this.connection.sendNotification(method, params)
  }

  async request(method: string, params: unknown, timeoutMs = requestDeadlineMs): Promise<unknown> {
    if (this.stopped) throw new Error('The language server has stopped.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.connection.sendRequest(method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Language server request timed out.')), timeoutMs)
          timer.unref()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  stop(): Promise<void> {
    return this.stopping ??= this.gracefulStop()
  }

  private async gracefulStop() {
    if (this.stopped) return this.closed
    try { await this.request('shutdown', null, 750) } catch { /* Server may already be unavailable. */ }
    try { await this.connection.sendNotification('exit') } catch { /* Server may already be unavailable. */ }
    // Flush the final notification and close Ion's input ownership. Servers
    // that miss `exit` must still observe EOF rather than remain orphaned.
    this.child.stdin.end()
    await Promise.race([
      this.exited,
      new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.abort(); resolve() }, stopDeadlineMs)
        timer.unref()
      }),
    ])
    this.disposeConnection()
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
  }

  private abort() {
    if (this.stopped) return
    this.stopped = true
    this.disposeConnection()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    if (process.platform === 'win32') void stopWindowsProcessTree(this.child)
    else {
      try { if (this.child.pid) process.kill(-this.child.pid, 'SIGKILL') }
      catch { try { this.child.kill('SIGKILL') } catch { /* Process already exited. */ } }
    }
  }

  private disposeConnection() {
    if (!this.stopped) this.stopped = true
    try { this.connection.dispose() } catch { /* Idempotent cleanup. */ }
    this.child.stderr.removeAllListeners()
    this.child.stderr.resume()
  }
}
