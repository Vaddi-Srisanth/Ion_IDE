import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ToolReply, ToolSnapshot } from '../../shared/language-tools'
import { sourceDriveSpelling } from '../../shared/source-path'
import { execute } from '../runner'
import { commandPaths, envFor, executable, onPath } from '../run-console/plans'
import { LspProcess } from './lsp-process'

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
  signal?: AbortSignal
  resolve(reply: ToolReply | null): void
  reject(reason: unknown): void
}

/** Owns one local clangd process and one open translation unit. */
export class ClangdService {
  private current?: Query
  private queued?: Query
  private document?: string
  private documentVersion = 0
  private stopped = false

  private constructor(private readonly process: LspProcess, private readonly directory: string) {}

  static async start(root: string | null, source: string, signal: AbortSignal): Promise<ClangdService> {
    const directory = await mkdtemp(join(tmpdir(), 'ion-clangd-'))
    let service: ClangdService | undefined
    try {
      const boundary = root ?? dirname(source)
      const paths = await commandPaths(boundary)
      const binary = await findClangd(boundary, paths, directory, signal)
      signal.throwIfAborted()
      const process = await LspProcess.start({
        executable: binary,
        args: ['--background-index=0', '--enable-config=0', '--pch-storage=disk', '-j=1', '--log=error'],
        cwd: directory,
        env: envFor(paths, directory),
        root,
      }, signal)
      service = new ClangdService(process, directory)
      const abort = () => { void service?.stop() }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
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

  get closed() { return this.stopped || this.process.isClosed }
  get executable() { return this.process.executable }
  get version() { return this.process.version }
  get capabilities() { return this.process.supportedCapabilities() }

  query(snapshot: ToolSnapshot, signal?: AbortSignal): Promise<ToolReply | null> {
    if (this.stopped) return Promise.reject(new Error('The local clangd process stopped.'))
    return new Promise((resolve, reject) => {
      this.queued?.resolve(null)
      this.queued = { snapshot, signal, resolve, reject }
      this.advance()
    })
  }

  async stop() {
    this.terminate()
    await this.process.stop()
    await rm(this.directory, { recursive: true, force: true })
  }

  async saved(path: string) {
    const uri = pathToFileURL(path).href
    if (this.document === uri) await this.process.notify('textDocument/didSave', { textDocument: { uri } })
  }

  private terminate(reason = new Error('The local clangd process stopped.')) {
    if (this.stopped) return
    this.stopped = true
    this.current?.reject(reason)
    this.queued?.resolve(null)
    this.current = undefined
    this.queued = undefined
    void this.process.stop()
  }

  private async request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    return this.process.request(method, params, undefined, signal)
  }

  private advance() {
    if (this.stopped || this.current || !this.queued) return
    const query = this.queued
    this.current = query
    this.queued = undefined
    void this.lookup(query).then(query.resolve, query.reject).finally(() => {
      if (this.current === query) this.current = undefined
      this.advance()
    })
  }

  private async lookup(query: Query): Promise<ToolReply> {
    const { snapshot, signal } = query
    const uri = pathToFileURL(snapshot.path).href
    const version = ++this.documentVersion
    if (this.document !== uri) {
      if (this.document) await this.process.notify('textDocument/didClose', { textDocument: { uri: this.document } })
      this.document = uri
      await this.process.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: snapshot.language, version, text: snapshot.text },
      })
    } else {
      await this.process.notify('textDocument/didChange', {
        textDocument: { uri, version }, contentChanges: [{ text: snapshot.text }],
      })
    }
    const location = { textDocument: { uri }, position: positionAt(snapshot.text, snapshot.offset) }
    const result = snapshot.operation === 'references'
      ? await this.request('textDocument/references', { ...location, context: { includeDeclaration: true } }, signal)
      : await this.request('textDocument/definition', location, signal)
    return { version: snapshot.version, rows: locationRows(result, snapshot.path) }
  }
}
