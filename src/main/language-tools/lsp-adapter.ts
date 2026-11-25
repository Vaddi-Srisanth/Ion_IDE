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
interface PublishedDiagnostics { version?: number; diagnostics: unknown[] }
interface SynchronizedDocument { sourceVersion: number; protocolVersion: number; digest: string }
interface DiagnosticWaiter { version: number; afterSequence: number; resolve(): void }

type DocumentNotification = (method: string, params: unknown) => Promise<void>

const maxRows = 200
const maxText = 16_384

function textDigest(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

/** Unversioned reports are reusable only while the synchronized document is
 * unchanged; after an edit they may belong to the previous snapshot. */
export function isCurrentDiagnosticReport(report: PublishedDiagnostics | undefined, version: number, documentChanged: boolean) {
  if (!report) return false
  return report.version === undefined ? !documentChanged : report.version === version
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
        await notify('textDocument/didOpen', {
          textDocument: { uri, languageId: language, version: next.protocolVersion, text },
        })
        this.documents.set(uri, next)
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
      await notify('textDocument/didChange', {
        textDocument: { uri, version: next.protocolVersion }, contentChanges: [{ text }],
      })
      this.documents.set(uri, next)
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
  private readonly diagnostics = new Map<string, PublishedDiagnostics>()
  private readonly diagnosticSequences = new Map<string, number>()
  private readonly diagnosticWaiters = new Map<string, Set<DiagnosticWaiter>>()
  private stopped = false

  private constructor(private readonly host: LspProcess, private readonly directory: string) {
    host.onNotification('textDocument/publishDiagnostics', params => {
      if (!params || typeof params !== 'object') return
      const report = params as { uri?: unknown; version?: unknown; diagnostics?: unknown }
      if (typeof report.uri !== 'string' || !Array.isArray(report.diagnostics)) return
      const version = Number.isSafeInteger(report.version) ? report.version as number : undefined
      const sequence = (this.diagnosticSequences.get(report.uri) ?? 0) + 1
      this.diagnosticSequences.set(report.uri, sequence)
      this.diagnostics.set(report.uri, {
        version,
        diagnostics: report.diagnostics.slice(0, maxRows),
      })
      const waiters = this.diagnosticWaiters.get(report.uri)
      for (const waiter of waiters ?? []) {
        if (sequence > waiter.afterSequence && (version === undefined || version >= waiter.version)) {
          waiter.resolve()
          waiters?.delete(waiter)
        }
      }
      if (!waiters?.size) this.diagnosticWaiters.delete(report.uri)
    })
  }

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
    this.diagnosticSequences.clear()
    for (const waiters of this.diagnosticWaiters.values()) for (const waiter of waiters) waiter.resolve()
    this.diagnosticWaiters.clear()
    await this.host.stop()
    await rm(this.directory, { recursive: true, force: true })
  }

  async close(path: string) {
    const uri = pathToFileURL(path).href
    await this.documents.close(uri, (method, params) => this.host.notify(method, params))
    this.diagnostics.delete(uri)
    this.diagnosticSequences.delete(uri)
    for (const waiter of this.diagnosticWaiters.get(uri) ?? []) waiter.resolve()
    this.diagnosticWaiters.delete(uri)
  }

  async saved(path: string) {
    const uri = pathToFileURL(path).href
    if (this.documents.has(uri)) await this.host.notify('textDocument/didSave', { textDocument: { uri } })
  }

  async query(snapshot: ToolSnapshot, signal?: AbortSignal): Promise<ToolReply> {
    const uri = pathToFileURL(snapshot.path).href
    const previousVersion = this.documents.version(uri)
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
      const documentChanged = previousVersion !== version
      let current = this.diagnostics.get(uri)
      if (current && !isCurrentDiagnosticReport(current, version, documentChanged)) {
        // Unversioned diagnostics already in flight for the previous snapshot
        // must not satisfy a request made after a new didOpen/didChange.
        this.diagnostics.delete(uri)
        current = undefined
      }
      if (!current || (current.version !== undefined && current.version < version)) {
        await this.waitForDiagnostics(uri, version, this.diagnosticSequences.get(uri) ?? 0)
      }
      const report = this.diagnostics.get(uri)
      if (!report || (report.version !== undefined && report.version !== version)) return { version: snapshot.version, rows }
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

  private waitForDiagnostics(uri: string, version: number, afterSequence: number) {
    return new Promise<void>(resolve => {
      const waiters = this.diagnosticWaiters.get(uri) ?? new Set<DiagnosticWaiter>()
      this.diagnosticWaiters.set(uri, waiters)
      let timer: ReturnType<typeof setTimeout>
      let waiter: DiagnosticWaiter
      const done = () => {
        clearTimeout(timer)
        waiters.delete(waiter)
        if (!waiters.size) this.diagnosticWaiters.delete(uri)
        resolve()
      }
      waiter = { version, afterSequence, resolve: done }
      waiters.add(waiter)
      timer = setTimeout(done, 600)
    })
  }
}
