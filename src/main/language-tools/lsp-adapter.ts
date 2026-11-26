import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ToolReply, ToolSnapshot } from '../../shared/language-tools'
import { sourceDriveSpelling } from '../../shared/source-path'
import { commandPaths, envFor, onPath } from '../run-console/plans'
import { LspProcess } from './lsp-process'

interface ServerCandidate { executable: string; args: string[]; kind: 'pyright' | 'pylsp' | 'typescript' }
export interface PublishedDiagnostics { version?: number; diagnostics: unknown[] }
interface SynchronizedDocument { sourceVersion: number; protocolVersion: number; digest: string }
interface DiagnosticWaiter { resolve(): void; reject(reason?: unknown): void; dispose(): void }

type DocumentNotification = (method: string, params: unknown) => Promise<void>

const maxRows = 200
const maxText = 16_384

function textDigest(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

/** Correlates pushed diagnostics with the exact synchronized document
 * generation. LSP does not carry enough information to correlate an
 * unversioned report after the first edit, so those reports fail closed. */
export class DiagnosticGenerationFence {
  private readonly reports = new Map<string, Map<number, PublishedDiagnostics>>()
  private readonly waiters = new Map<string, Map<number, Set<DiagnosticWaiter>>>()

  publish(uri: string, synchronizedVersion: number | undefined, report: PublishedDiagnostics) {
    if (synchronizedVersion === undefined) return false
    const generation = report.version ?? (synchronizedVersion === 1 ? 1 : undefined)
    if (generation === undefined || generation < 1 || generation > synchronizedVersion) return false
    const versions = this.reports.get(uri) ?? new Map<number, PublishedDiagnostics>()
    versions.set(generation, report)
    while (versions.size > 8) versions.delete(versions.keys().next().value as number)
    this.reports.set(uri, versions)
    const generations = this.waiters.get(uri)
    const waiting = generations?.get(generation)
    for (const waiter of waiting ?? []) waiter.resolve()
    waiting?.clear()
    generations?.delete(generation)
    if (!generations?.size) this.waiters.delete(uri)
    return true
  }

  take(uri: string, generation: number) { return this.reports.get(uri)?.get(generation) }

  wait(uri: string, generation: number, signal?: AbortSignal) {
    if (this.take(uri, generation)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const generations = this.waiters.get(uri) ?? new Map<number, Set<DiagnosticWaiter>>()
      const waiting = generations.get(generation) ?? new Set<DiagnosticWaiter>()
      this.waiters.set(uri, generations)
      generations.set(generation, waiting)
      let timer: ReturnType<typeof setTimeout> | undefined
      let waiter: DiagnosticWaiter
      const remove = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        waiting.delete(waiter)
        if (!waiting.size) generations.delete(generation)
        if (!generations.size) this.waiters.delete(uri)
      }
      const done = () => { remove(); resolve() }
      const failed = (reason?: unknown) => { remove(); reject(reason) }
      const abort = () => failed(signal?.reason ?? new Error('The operation was aborted.'))
      waiter = { resolve: done, reject: failed, dispose: done }
      waiting.add(waiter)
      if (signal?.aborted) abort()
      else {
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(done, 600)
      }
    })
  }

  clear(uri?: string) {
    if (uri !== undefined) {
      this.reports.delete(uri)
      for (const waiting of this.waiters.get(uri)?.values() ?? []) for (const waiter of waiting) waiter.dispose()
      this.waiters.delete(uri)
      return
    }
    this.reports.clear()
    for (const generations of this.waiters.values()) for (const waiting of generations.values()) {
      for (const waiter of waiting) waiter.dispose()
    }
    this.waiters.clear()
  }

  get pendingWaiterCount() {
    let count = 0
    for (const generations of this.waiters.values()) for (const waiting of generations.values()) count += waiting.size
    return count
  }
}

/** Serializes document lifecycle updates per URI and suppresses duplicate
 * full-document notifications without retaining a second source buffer. */
export class LspDocumentSynchronizer {
  private readonly documents = new Map<string, SynchronizedDocument>()
  private readonly queues = new Map<string, Promise<void>>()

  has(uri: string) { return this.documents.has(uri) }
  version(uri: string) { return this.documents.get(uri)?.protocolVersion }
  get size() { return this.documents.size }

  synchronize(uri: string, language: string, sourceVersion: number, text: string, notify: DocumentNotification) {
    return this.enqueue(uri, async () => {
      const digest = textDigest(text)
      const current = this.documents.get(uri)
      if (!current) {
        const next = { sourceVersion, protocolVersion: 1, digest }
        this.documents.set(uri, next)
        try {
          await notify('textDocument/didOpen', {
            textDocument: { uri, languageId: language, version: next.protocolVersion, text },
          })
        } catch (error) {
          if (this.documents.get(uri) === next) this.documents.delete(uri)
          throw error
        }
        return next.protocolVersion
      }
      if (sourceVersion < current.sourceVersion) return current.protocolVersion
      if (sourceVersion === current.sourceVersion && digest !== current.digest) {
        throw new Error('Conflicting language document snapshot.')
      }
      if (digest === current.digest) {
        if (sourceVersion > current.sourceVersion) this.documents.set(uri, { ...current, sourceVersion })
        return current.protocolVersion
      }
      const next = { sourceVersion, protocolVersion: current.protocolVersion + 1, digest }
      this.documents.set(uri, next)
      try {
        await notify('textDocument/didChange', {
          textDocument: { uri, version: next.protocolVersion }, contentChanges: [{ text }],
        })
      } catch (error) {
        if (this.documents.get(uri) === next) this.documents.set(uri, current)
        throw error
      }
      return next.protocolVersion
    })
  }

  close(uri: string, notify: DocumentNotification) {
    return this.enqueue(uri, async () => {
      if (!this.documents.has(uri)) return
      await notify('textDocument/didClose', { textDocument: { uri } })
      this.documents.delete(uri)
    })
  }

  async closeAll(notify: DocumentNotification) {
    const uris = new Set([...this.documents.keys(), ...this.queues.keys()])
    await Promise.all([...uris].map(uri => this.close(uri, notify)))
    this.documents.clear()
  }

  private enqueue<T>(uri: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(uri) ?? Promise.resolve()
    const task = previous.then(work, work)
    const settled = task.then(() => undefined, () => undefined)
    this.queues.set(uri, settled)
    void settled.finally(() => { if (this.queues.get(uri) === settled) this.queues.delete(uri) })
    return task
  }
}

function positionAt(text: string, offset: number) {
  const prefix = text.slice(0, offset)
  let line = 0, start = 0
  for (let index = prefix.indexOf('\n'); index !== -1; index = prefix.indexOf('\n', index + 1)) {
    line++
    start = index + 1
  }
  return { line, character: offset - start }
}

function offsetAt(text: string, value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return
  const position = value as { line?: unknown; character?: unknown }
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)
    || (position.line as number) < 0 || (position.character as number) < 0) return
  const targetLine = position.line as number
  const targetCharacter = position.character as number
  let offset = 0
  for (let line = 0; line < targetLine; line++) {
    const newline = text.indexOf('\n', offset)
    if (newline < 0) return
    offset = newline + 1
  }
  return Math.min(offset + targetCharacter, text.length)
}

function locationRows(result: unknown, source: string): string[][] {
  const entries = Array.isArray(result) ? result.slice(0, maxRows) : [result]
  return entries.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as { uri?: unknown; targetUri?: unknown; range?: { start?: unknown }; targetSelectionRange?: { start?: unknown } }
    const uri = value.uri ?? value.targetUri
    const start = (value.targetSelectionRange ?? value.range)?.start as { line?: unknown; character?: unknown } | undefined
    if (typeof uri !== 'string' || !uri.startsWith('file:') || !Number.isSafeInteger(start?.line)
      || !Number.isSafeInteger(start?.character) || (start?.line as number) < 0 || (start?.character as number) < 0) return []
    const line = start!.line as number, character = start!.character as number
    try { return [[sourceDriveSpelling(fileURLToPath(uri), source, process.platform), String(line + 1), String(character + 1)]] }
    catch { return [] }
  })
}

function markup(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, maxText)
  if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
    return ((value as { value: string }).value).slice(0, maxText)
  }
  if (Array.isArray(value)) return value.map(markup).filter(Boolean).join('\n\n').slice(0, maxText)
  return ''
}

async function discover(adapter: string, root: string, paths: string[]): Promise<ServerCandidate> {
  const names = adapter === 'python-lsp'
    ? [['pyright-langserver', '--stdio'], ['pylsp']]
    : adapter === 'typescript-lsp' ? [['typescript-language-server', '--stdio']] : []
  for (const [name, ...args] of names) {
    const executable = await onPath(name, root, paths)
    if (executable) return { executable, args, kind: name === 'pyright-langserver' ? 'pyright'
      : name === 'pylsp' ? 'pylsp' : 'typescript' }
  }
  throw new Error(adapter === 'python-lsp'
    ? 'Install pyright-langserver or python-lsp-server outside the workspace to enable Smart Python.'
    : 'Install typescript-language-server outside the workspace to enable Smart JavaScript/TypeScript.')
}

/** Shared document adapter for installed standards-compliant LSP servers. */
export class ExternalLspService {
  private readonly documents = new LspDocumentSynchronizer()
  private readonly diagnostics = new DiagnosticGenerationFence()
  private stopped = false

  private constructor(private readonly host: LspProcess, private readonly directory: string) {
    host.onNotification('textDocument/publishDiagnostics', params => {
      if (!params || typeof params !== 'object') return
      const report = params as { uri?: unknown; version?: unknown; diagnostics?: unknown }
      if (typeof report.uri !== 'string' || !Array.isArray(report.diagnostics)) return
      const version = Number.isSafeInteger(report.version) ? report.version as number : undefined
      this.diagnostics.publish(report.uri, this.documents.version(report.uri), {
        version,
        diagnostics: report.diagnostics.slice(0, maxRows),
      })
    })
  }

  /** Internal test seam: production callers still use trusted discovery. */
  static attach(host: LspProcess, directory: string) { return new ExternalLspService(host, directory) }

  static async start(adapter: string, root: string | null, source: string, signal: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), 'ion-lsp-'))
    try {
      const boundary = root ?? dirname(source)
      const paths = await commandPaths(boundary)
      const server = await discover(adapter, boundary, paths)
      const host = await LspProcess.start({
        executable: server.executable, args: server.args, cwd: directory, env: envFor(paths, directory), root,
        deadlines: { initializationMs: server.kind === 'pyright' ? 20_000 : 8_000 },
        configuration: server.kind === 'pyright' ? { python: { analysis: {
          diagnosticMode: 'openFilesOnly', indexing: false, useLibraryCodeForTypes: true,
        } } } : undefined,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: { synchronization: { didSave: false }, completion: {}, hover: {}, definition: {}, references: {},
            signatureHelp: {}, publishDiagnostics: { relatedInformation: true, versionSupport: true } },
          workspace: { workspaceFolders: true },
        },
      }, signal)
      return new ExternalLspService(host, directory)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  get closed() { return this.stopped || this.host.isClosed }
  get executable() { return this.host.executable }
  get version() { return this.host.version }
  get capabilities() { return this.host.supportedCapabilities() }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    await this.documents.closeAll((method, params) => this.host.notify(method, params)).catch(() => {})
    this.diagnostics.clear()
    await this.host.stop()
    await rm(this.directory, { recursive: true, force: true })
  }

  async close(path: string) {
    const uri = pathToFileURL(path).href
    await this.documents.close(uri, (method, params) => this.host.notify(method, params))
    this.diagnostics.clear(uri)
  }

  async saved(path: string) {
    const uri = pathToFileURL(path).href
    if (this.documents.has(uri)) await this.host.notify('textDocument/didSave', { textDocument: { uri } })
  }

  async query(snapshot: ToolSnapshot, signal?: AbortSignal): Promise<ToolReply> {
    const uri = pathToFileURL(snapshot.path).href
    const version = await this.documents.synchronize(uri, snapshot.language, snapshot.version, snapshot.text,
      (method, params) => this.host.notify(method, params))
    const location = { textDocument: { uri }, position: positionAt(snapshot.text, snapshot.offset) }
    let rows: string[][] = []
    if (snapshot.operation === 'definition' || snapshot.operation === 'references') {
      const result = await this.host.request(`textDocument/${snapshot.operation}`, snapshot.operation === 'references'
        ? { ...location, context: { includeDeclaration: true } } : location, undefined, signal)
      rows = locationRows(result, snapshot.path)
    } else if (snapshot.operation === 'hover') {
      const result = await this.host.request('textDocument/hover', location, undefined, signal) as { contents?: unknown } | null
      const text = markup(result?.contents)
      if (text) rows = [['hover', text]]
    } else if (snapshot.operation === 'complete') {
      const result = await this.host.request('textDocument/completion', location, undefined, signal) as { items?: unknown } | unknown[] | null
      const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
      rows = items.slice(0, maxRows).flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const value = item as { label?: unknown; kind?: unknown; detail?: unknown; insertText?: unknown }
        if (typeof value.label !== 'string') return []
        return [[value.label.slice(0, 300), String(value.kind ?? ''), typeof value.detail === 'string' ? value.detail.slice(0, 500) : '',
          typeof value.insertText === 'string' ? value.insertText.slice(0, 4_096) : value.label.slice(0, 300)]]
      })
    } else if (snapshot.operation === 'signature') {
      const result = await this.host.request('textDocument/signatureHelp', location, undefined, signal) as { activeParameter?: unknown; signatures?: unknown } | null
      const signatures = Array.isArray(result?.signatures) ? result.signatures : []
      rows = signatures.slice(0, 20).flatMap(item => {
        if (!item || typeof item !== 'object' || typeof (item as { label?: unknown }).label !== 'string') return []
        const value = item as { label: string; parameters?: unknown }
        const parameters = Array.isArray(value.parameters) ? value.parameters.slice(0, 50).map(parameter =>
          typeof (parameter as { label?: unknown })?.label === 'string' ? (parameter as { label: string }).label : '') : []
        return [[String(result?.activeParameter ?? 0), value.label.slice(0, 1_000), ...parameters]]
      })
    } else if (snapshot.operation === 'diagnostics') {
      if (!this.diagnostics.take(uri, version)) await this.diagnostics.wait(uri, version, signal)
      const report = this.diagnostics.take(uri, version)
      if (!report) return { version: snapshot.version, rows }
      rows = report.diagnostics.flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const value = item as { severity?: unknown; message?: unknown; range?: { start?: unknown; end?: unknown }; source?: unknown }
        const start = offsetAt(snapshot.text, value.range?.start)
        const end = offsetAt(snapshot.text, value.range?.end)
        if (start === undefined || typeof value.message !== 'string') return []
        const severity = value.severity === 1 ? 'error' : value.severity === 2 ? 'warning' : 'note'
        return [[severity, String(start), String(end ?? start + 1), value.message.slice(0, 2_000),
          typeof value.source === 'string' ? value.source.slice(0, 100) : 'language server']]
      })
    }
    return { version: snapshot.version, rows }
  }
}
