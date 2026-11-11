import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node'
import type { ToolReply, ToolSnapshot } from '../../shared/language-tools'
import { sourceDriveSpelling } from '../../shared/source-path'
import { execute } from '../runner'
import { commandPaths, envFor, executable, onPath } from '../run-console/plans'

async function findClangd(root: string, paths: string[], scratch: string, signal: AbortSignal): Promise<string> {
  const path = await onPath('clangd', root, paths, process.platform === 'darwin' ? ['/usr/bin/clangd'] : [])
  if (path) return path
  if (process.platform === 'darwin') {
    const options = { cwd: scratch, environment: envFor(paths, scratch), timeoutMs: 2_000,
      signal, input: '', budget: { remaining: 8192 } }
    const selected = await execute('/usr/bin/xcode-select', ['-p'], options)
    if (selected.exitCode === 0 && isAbsolute(selected.output.trim())) {
      const located = await execute('/usr/bin/xcrun', ['--find', 'clangd'], options)
      if (located.exitCode === 0 && await executable(located.output.trim(), root)) return located.output.trim()
    }
  }
  throw new Error('Install clangd or add it to PATH to use Smart C/C++ navigation.')
}

function positionAt(text: string, offset: number) {
  const prefix = text.slice(0, offset)
  let line = 0
  let start = 0
  for (let index = prefix.indexOf('\n'); index !== -1; index = prefix.indexOf('\n', index + 1)) {
    line++
    start = index + 1
  }
  return { line, character: offset - start }
}

function locationRows(result: unknown, source: string): string[][] {
  const entries = Array.isArray(result) ? result.slice(0, 200) : [result]
  const rows: string[][] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const uri = entry.uri ?? entry.targetUri
    const start = (entry.targetSelectionRange ?? entry.range)?.start
    if (typeof uri !== 'string' || !uri.startsWith('file:') || !Number.isSafeInteger(start?.line)
      || !Number.isSafeInteger(start?.character) || start.line < 0 || start.character < 0) continue
    try { rows.push([sourceDriveSpelling(fileURLToPath(uri), source, process.platform), String(start.line + 1), String(start.character + 1)]) }
    catch { /* URI cannot identify a local source file. */ }
  }
  return rows
}

interface Query {
  snapshot: ToolSnapshot
  resolve(reply: ToolReply | null): void
  reject(reason: unknown): void
}

/** Owns one local clangd process and one open translation unit. */
export class ClangdService {
  private readonly connection: MessageConnection
  private readonly done: Promise<void>
  private current?: Query
  private queued?: Query
  private document?: string
  private version = 0
  private stopped = false

  private constructor(private readonly child: ChildProcessWithoutNullStreams, directory: string) {
    this.connection = createMessageConnection(child.stdout, child.stdin)
    this.done = new Promise((resolve) => {
      child.once('close', () => {
        this.terminate()
        void rm(directory, { recursive: true, force: true }).finally(resolve).catch(() => {})
      })
    })
    child.on('error', () => this.terminate(new Error('The local clangd process could not start.')))
    child.stdin.on('error', () => this.terminate())
    child.stderr.resume()
    this.connection.onClose(() => this.terminate())
    this.connection.listen()
  }

  static async start(root: string | null, source: string, signal: AbortSignal): Promise<ClangdService> {
    const directory = await mkdtemp(join(tmpdir(), 'ion-clangd-'))
    let service: ClangdService | undefined
    try {
      const boundary = root ?? dirname(source)
      const paths = await commandPaths(boundary)
      const binary = await findClangd(boundary, paths, directory, signal)
      signal.throwIfAborted()
      const child = spawn(binary, ['--background-index=0', '--enable-config=0', '--pch-storage=disk', '-j=1', '--log=error'], {
        cwd: directory, env: envFor(paths, directory), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      service = new ClangdService(child, directory)
      const abort = () => { void service?.stop() }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        await service.request('initialize', { processId: process.pid, rootUri: root ? pathToFileURL(root).href : null,
          capabilities: { general: { positionEncodings: ['utf-16'] } } })
        await service.connection.sendNotification('initialized', {})
      } finally {
        signal.removeEventListener('abort', abort)
      }
      return service
    } catch (error) {
      if (service) await service.stop()
      else await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  get closed() { return this.stopped }

  query(snapshot: ToolSnapshot): Promise<ToolReply | null> {
    if (this.stopped) return Promise.reject(new Error('The local clangd process stopped.'))
    return new Promise((resolve, reject) => {
      this.queued?.resolve(null)
      this.queued = { snapshot, resolve, reject }
      this.advance()
    })
  }

  stop() {
    this.terminate()
    return this.done
  }

  private terminate(reason = new Error('The local clangd process stopped.')) {
    if (this.stopped) return
    this.stopped = true
    this.current?.reject(reason)
    this.queued?.resolve(null)
    this.current = undefined
    this.queued = undefined
    this.connection.dispose()
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill()
      const force = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
      }, 750)
      force.unref()
      this.child.once('close', () => clearTimeout(force))
    }
  }

  private async request(method: string, params: object): Promise<unknown> {
    const timer = setTimeout(() => this.terminate(new Error('Local clangd navigation timed out.')), 8000)
    timer.unref()
    try { return await this.connection.sendRequest(method, params) }
    finally { clearTimeout(timer) }
  }

  private advance() {
    if (this.stopped || this.current || !this.queued) return
    const query = this.queued
    this.current = query
    this.queued = undefined
    void this.lookup(query.snapshot).then(query.resolve, query.reject).finally(() => {
      if (this.current === query) this.current = undefined
      this.advance()
    })
  }

  private async lookup(snapshot: ToolSnapshot): Promise<ToolReply> {
    const uri = pathToFileURL(snapshot.path).href
    const version = ++this.version
    if (this.document !== uri) {
      if (this.document) await this.connection.sendNotification('textDocument/didClose', { textDocument: { uri: this.document } })
      this.document = uri
      await this.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: snapshot.language, version, text: snapshot.text },
      })
    } else {
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version }, contentChanges: [{ text: snapshot.text }],
      })
    }
    const location = { textDocument: { uri }, position: positionAt(snapshot.text, snapshot.offset) }
    const result = snapshot.operation === 'references'
      ? await this.request('textDocument/references', { ...location, context: { includeDeclaration: true } })
      : await this.request('textDocument/definition', location)
    return { version: snapshot.version, rows: locationRows(result, snapshot.path) }
  }
}
