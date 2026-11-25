import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { Transform } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { CancellationTokenSource, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node'
import { stopWindowsProcessTree } from '../windows-process'

const requestDeadlineMs = 8_000
const startupDeadlineMs = 5_000
const initializationDeadlineMs = 8_000
const stopDeadlineMs = 1_500
const stderrLimit = 64 * 1024
const responseLimit = 8 * 1024 * 1024
const headerLimit = 8 * 1024

function frameGuard(onInvalid: () => void) {
  let header = Buffer.alloc(0), body = 0, invalid = false
  return (chunk: Buffer) => {
    if (invalid) return false
    let offset = 0
    while (offset < chunk.length) {
      if (body) {
        const consumed = Math.min(body, chunk.length - offset)
        body -= consumed
        offset += consumed
        continue
      }
      const previous = header.length
      const combined = Buffer.concat([header, chunk.subarray(offset)])
      const separator = combined.indexOf('\r\n\r\n')
      if (separator < 0) {
        header = combined
        if (header.length > headerLimit) { invalid = true; onInvalid(); return false }
        return true
      }
      header = combined.subarray(0, separator + 4)
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)\r\n/i.exec(header.toString('ascii'))
      const length = match ? Number(match[1]) : NaN
      header = Buffer.alloc(0)
      if (!Number.isSafeInteger(length) || length < 0 || length > responseLimit) {
        invalid = true
        onInvalid()
        return false
      }
      body = length
      offset += Math.max(0, separator + 4 - previous)
    }
    return true
  }
}

export interface LspProcessOptions {
  executable: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  root: string | null
  initializationOptions?: unknown
  capabilities?: object
  deadlines?: { startupMs?: number; initializationMs?: number }
  configuration?: unknown
}

/** A bounded owner for one trusted, absolute local language-server process. */
export class LspProcess {
  private readonly connection: MessageConnection
  private readonly exited: Promise<void>
  private stopped = false
  private stopping?: Promise<void>
  private stderrBytes = 0
  private readonly guardedOutput: Transform
  private readonly lifecycle = new AbortController()
  private initialization: { capabilities?: Record<string, unknown>; serverInfo?: { name?: string; version?: string } } = {}

  private constructor(private readonly child: ChildProcessWithoutNullStreams, readonly executable: string) {
    const inspectFrames = frameGuard(() => this.abort())
    this.guardedOutput = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      if (inspectFrames(chunk)) callback(null, chunk)
      else callback()
    } })
    child.stdout.pipe(this.guardedOutput)
    this.connection = createMessageConnection(this.guardedOutput, child.stdin)
    this.exited = new Promise(resolve => child.once('exit', () => resolve()))
    child.stderr.on('data', (chunk: Buffer) => { this.stderrBytes = Math.min(stderrLimit, this.stderrBytes + chunk.byteLength) })
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
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    const processHost = new LspProcess(child, options.executable)
    const abort = () => processHost.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await processHost.waitForStage(spawned, options.deadlines?.startupMs ?? startupDeadlineMs,
        'Language server process startup timed out.', signal)
      const initialized = await processHost.request('initialize', {
        processId: process.pid,
        rootUri: options.root ? pathToFileURL(options.root).href : null,
        workspaceFolders: options.root ? [{ uri: pathToFileURL(options.root).href, name: options.root.split(/[/\\]/).at(-1) ?? 'workspace' }] : null,
        capabilities: options.capabilities ?? { general: { positionEncodings: ['utf-16'] } },
        initializationOptions: options.initializationOptions,
      }, options.deadlines?.initializationMs ?? initializationDeadlineMs, signal,
      'Language server initialization timed out.')
      if (initialized && typeof initialized === 'object') {
        const value = initialized as { capabilities?: unknown; serverInfo?: unknown }
        processHost.initialization = {
          capabilities: value.capabilities && typeof value.capabilities === 'object' ? value.capabilities as Record<string, unknown> : undefined,
          serverInfo: value.serverInfo && typeof value.serverInfo === 'object' ? value.serverInfo as { name?: string; version?: string } : undefined,
        }
      }
      await processHost.notify('initialized', {})
      if (options.configuration !== undefined) {
        await processHost.notify('workspace/didChangeConfiguration', { settings: options.configuration })
      }
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
  get version() { return typeof this.initialization.serverInfo?.version === 'string' ? this.initialization.serverInfo.version.slice(0, 100) : undefined }
  get capabilities() { return this.initialization.capabilities ?? {} }
  supportedCapabilities() {
    const capabilities = this.capabilities
    const fields: Record<string, string> = {
      completionProvider: 'complete', hoverProvider: 'hover', signatureHelpProvider: 'signature',
      definitionProvider: 'definition', declarationProvider: 'declaration', implementationProvider: 'implementation',
      typeDefinitionProvider: 'typeDefinition', referencesProvider: 'references', documentSymbolProvider: 'documentSymbols',
      workspaceSymbolProvider: 'workspaceSymbols', renameProvider: 'rename', codeActionProvider: 'codeActions',
      documentFormattingProvider: 'formatting', documentRangeFormattingProvider: 'rangeFormatting',
      semanticTokensProvider: 'semanticTokens', inlayHintProvider: 'inlayHints', callHierarchyProvider: 'callHierarchy',
      typeHierarchyProvider: 'typeHierarchy', documentLinkProvider: 'documentLinks',
    }
    return Object.entries(fields).flatMap(([field, name]) => capabilities[field] ? [name] : [])
  }

  onNotification(method: string, handler: (params: unknown) => void) {
    return this.connection.onNotification(method, handler)
  }

  notify(method: string, params: unknown): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('The language server has stopped.'))
    return this.connection.sendNotification(method, params)
  }

  async request(
    method: string, params: unknown, timeoutMs = requestDeadlineMs, signal?: AbortSignal,
    timeoutMessage = 'Language server request timed out.',
  ): Promise<unknown> {
    if (this.stopped) throw new Error('The language server has stopped.')
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancellation = new CancellationTokenSource()
    const abort = () => cancellation.cancel()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) cancellation.cancel()
    try {
      return await Promise.race([
        this.connection.sendRequest(method, params, cancellation.token),
        new Promise<never>((_resolve, reject) => this.lifecycle.signal.addEventListener('abort',
          () => reject(new Error('The language server connection closed.')), { once: true })),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            cancellation.cancel()
            reject(new Error(timeoutMessage))
          }, timeoutMs)
          timer.unref()
        }),
      ])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      cancellation.dispose()
    }
  }

  private async waitForStage(task: Promise<void>, timeoutMs: number, timeoutMessage: string, signal?: AbortSignal) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectAbort: ((reason?: unknown) => void) | undefined
    const abort = () => rejectAbort?.(signal?.reason ?? new Error('The operation was aborted.'))
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
    try {
      await Promise.race([task, aborted, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
        timer.unref()
      })])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  stop(): Promise<void> {
    return this.stopping ??= this.stopped ? this.boundedExit() : this.gracefulStop()
  }

  private boundedExit() {
    return Promise.race([this.exited, new Promise<void>(resolve => setTimeout(resolve, 500))])
  }

  private async gracefulStop() {
    if (this.stopped) return this.exited
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
    this.lifecycle.abort()
    this.disposeConnection()
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    if (process.platform === 'win32') void stopWindowsProcessTree(this.child)
    else {
      try { if (this.child.pid) process.kill(-this.child.pid, 'SIGKILL') }
      catch { try { this.child.kill('SIGKILL') } catch { /* Process already exited. */ } }
    }
  }

  private disposeConnection() {
    if (!this.stopped) this.stopped = true
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort()
    try { this.connection.dispose() } catch { /* Idempotent cleanup. */ }
    this.child.stdout.unpipe(this.guardedOutput)
    this.guardedOutput.destroy()
    this.child.stderr.resume()
  }
}
