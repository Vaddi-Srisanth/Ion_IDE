import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ToolReply, ToolSnapshot } from '../../shared/language-tools'
import { sourceDriveSpelling } from '../../shared/source-path'
import { commandPaths, envFor, onPath } from '../run-console/plans'
import { LspProcess } from './lsp-process'
import { removeServiceScratch } from './service-scratch'
import { discoverWindowsNodeCli } from './windows-node-cli'

interface ServerCandidate {
  executable: string
  args: string[]
  kind: 'pyright' | 'pylsp' | 'typescript'
  verify?: () => Promise<void>
}
export interface PublishedDiagnostics { version?: number; diagnostics: unknown[] }
interface SynchronizedDocument { sourceVersion: number; protocolVersion: number; digest: string; protocolUri: string; identity: string }
interface DiagnosticWaiter { resolve(): void; reject(reason?: unknown): void; dispose(): void }
interface DiagnosticDecision {
  decision: 'accepted' | 'rejected' | 'ignored'
  reason?: 'unversioned-after-edit' | 'older-version' | 'future-version' | 'generation-mismatch' | 'other'
  waiterGeneration?: number
  waiterReleased: boolean
}

type DocumentNotification = (method: string, params: unknown) => Promise<void>

const maxRows = 200
const maxText = 16_384
const maxWorkspaceEdits = 1_000
const maxWorkspaceEditText = 1024 * 1024

function textDigest(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

type ResolveFilePath = (path: string) => Promise<string>

function windowsPathIdentity(path: string) {
  const normalized = win32.normalize(path).normalize('NFC')
  return /^[a-z]:\\/i.test(normalized) ? normalized[0].toUpperCase() + normalized.slice(1) : normalized
}

/** Resolves only file identity. The original URI remains the protocol URI and
 * all filesystem authorization continues to use the already granted path. */
export async function canonicalFileUriIdentity(uri: string, platform = process.platform,
  resolveFile: ResolveFilePath = realpath) {
  if (platform !== 'win32') return new URL(uri).href
  const path = fileURLToPath(uri, { windows: true })
  const canonical = await resolveFile(path).catch(() => path)
  return `file:${windowsPathIdentity(canonical)}`
}

class DiagnosticMetadataTrace {
  private readonly destination = process.env.ION_LSP_DIAGNOSTIC_TRACE
  private readonly salt = this.destination ? randomBytes(32) : undefined
  private events = 0

  hash(value: string | undefined) {
    if (!this.salt || value === undefined) return undefined
    return createHash('sha256').update(this.salt).update(value).digest('hex').slice(0, 24)
  }

  record(value: Record<string, unknown>) {
    if (!this.destination || this.events++ >= 512) return
    try {
      appendFileSync(this.destination, JSON.stringify({ tNs: String(process.hrtime.bigint()), ...value }) + '\n', {
        encoding: 'utf8', mode: 0o600,
      })
    } catch { /* Diagnostic evidence cannot affect language intelligence. */ }
  }
}

/** Correlates pushed diagnostics with the exact synchronized document
 * generation. Versionless reports after an edit stay provisional behind a
 * protocol-ordered semantic barrier and never release a waiter on arrival. */
export class DiagnosticGenerationFence {
  private readonly reports = new Map<string, Map<number, PublishedDiagnostics>>()
  private readonly provisional = new Map<string, Map<number, PublishedDiagnostics>>()
  private readonly unversionedWindows = new Map<string, Set<number>>()
  private readonly waiters = new Map<string, Map<number, Set<DiagnosticWaiter>>>()

  beginUnversionedWindow(uri: string, generation: number) {
    const windows = this.unversionedWindows.get(uri) ?? new Set<number>()
    windows.add(generation)
    this.unversionedWindows.set(uri, windows)
    this.provisional.get(uri)?.delete(generation)
  }

  endUnversionedWindow(uri: string, generation: number) {
    this.provisional.get(uri)?.delete(generation)
    this.unversionedWindows.get(uri)?.delete(generation)
    if (!this.provisional.get(uri)?.size) this.provisional.delete(uri)
    if (!this.unversionedWindows.get(uri)?.size) this.unversionedWindows.delete(uri)
  }

  publish(uri: string, synchronizedVersion: number | undefined, report: PublishedDiagnostics): DiagnosticDecision {
    if (synchronizedVersion === undefined) {
      return { decision: 'rejected', reason: 'generation-mismatch', waiterReleased: false }
    }
    if (report.version === undefined && synchronizedVersion > 1) {
      const generations = this.provisional.get(uri) ?? new Map<number, PublishedDiagnostics>()
      if (!this.unversionedWindows.get(uri)?.has(synchronizedVersion)) {
        return { decision: 'ignored', reason: 'unversioned-after-edit',
          waiterGeneration: this.waiters.get(uri)?.has(synchronizedVersion) ? synchronizedVersion : undefined,
          waiterReleased: false }
      }
      generations.set(synchronizedVersion, report)
      this.provisional.set(uri, generations)
      // Versionless push diagnostics cannot be attributed perfectly. Keep the
      // last report after a protocol-ordered semantic barrier provisional for
      // the existing bounded collection window; never release on arrival.
      return { decision: 'ignored', reason: 'unversioned-after-edit',
        waiterGeneration: this.waiters.get(uri)?.has(synchronizedVersion) ? synchronizedVersion : undefined,
        waiterReleased: false }
    }
    const generation = report.version ?? synchronizedVersion
    if (generation < 1) return { decision: 'rejected', reason: 'other', waiterReleased: false }
    if (generation > synchronizedVersion) {
      return { decision: 'rejected', reason: 'future-version',
        waiterGeneration: this.waiters.get(uri)?.has(synchronizedVersion) ? synchronizedVersion : undefined,
        waiterReleased: false }
    }
    if (report.version !== undefined && generation === synchronizedVersion) {
      this.endUnversionedWindow(uri, generation)
    }
    const versions = this.reports.get(uri) ?? new Map<number, PublishedDiagnostics>()
    versions.set(generation, report)
    while (versions.size > 8) versions.delete(versions.keys().next().value as number)
    this.reports.set(uri, versions)
    const generations = this.waiters.get(uri)
    const waiting = generations?.get(generation)
    const waiterReleased = Boolean(waiting?.size)
    for (const waiter of waiting ?? []) waiter.resolve()
    waiting?.clear()
    generations?.delete(generation)
    if (!generations?.size) this.waiters.delete(uri)
    return { decision: generation === synchronizedVersion ? 'accepted' : 'ignored',
      ...(generation < synchronizedVersion ? { reason: 'older-version' as const } : {}),
      waiterGeneration: waiterReleased ? generation : undefined, waiterReleased }
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
        timer = setTimeout(() => {
          const candidate = this.provisional.get(uri)?.get(generation)
          if (candidate && this.unversionedWindows.get(uri)?.has(generation)) {
            const versions = this.reports.get(uri) ?? new Map<number, PublishedDiagnostics>()
            versions.set(generation, candidate)
            while (versions.size > 8) versions.delete(versions.keys().next().value as number)
            this.reports.set(uri, versions)
          }
          this.provisional.get(uri)?.delete(generation)
          this.unversionedWindows.get(uri)?.delete(generation)
          done()
        }, 600)
      }
    })
  }

  clear(uri?: string) {
    if (uri !== undefined) {
      this.reports.delete(uri)
      this.provisional.delete(uri)
      this.unversionedWindows.delete(uri)
      for (const waiting of this.waiters.get(uri)?.values() ?? []) for (const waiter of waiting) waiter.dispose()
      this.waiters.delete(uri)
      return
    }
    this.reports.clear()
    this.provisional.clear()
    this.unversionedWindows.clear()
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

export interface DocumentUriMatch {
  protocolUri: string
  identity: string
  protocolVersion: number
  rawUriMatched: boolean
}

/** Serializes document lifecycle updates per physical file identity and
 * suppresses duplicate full-document notifications without retaining a
 * second source buffer. Protocol URI spelling remains unchanged. */
export class LspDocumentSynchronizer {
  private readonly documents = new Map<string, SynchronizedDocument>()
  private readonly aliases = new Map<string, string>()
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly platform = process.platform, private readonly resolveFile: ResolveFilePath = realpath) {}

  has(uri: string) { return this.aliases.has(uri) }
  version(uri: string) {
    const identity = this.aliases.get(uri)
    return identity ? this.documents.get(identity)?.protocolVersion : undefined
  }
  get size() { return this.documents.size }

  async synchronize(uri: string, language: string, sourceVersion: number, text: string, notify: DocumentNotification) {
    const identity = await canonicalFileUriIdentity(uri, this.platform, this.resolveFile)
    return this.enqueue(identity, async () => {
      const digest = textDigest(text)
      const current = this.documents.get(identity)
      this.aliases.set(uri, identity)
      if (!current) {
        const next = { sourceVersion, protocolVersion: 1, digest, protocolUri: uri, identity }
        this.documents.set(identity, next)
        try {
          await notify('textDocument/didOpen', {
            textDocument: { uri, languageId: language, version: next.protocolVersion, text },
          })
        } catch (error) {
          if (this.documents.get(identity) === next) this.documents.delete(identity)
          this.aliases.delete(uri)
          throw error
        }
        return next.protocolVersion
      }
      if (sourceVersion < current.sourceVersion) return current.protocolVersion
      if (sourceVersion === current.sourceVersion && digest !== current.digest) {
        throw new Error('Conflicting language document snapshot.')
      }
      if (digest === current.digest) {
        if (sourceVersion > current.sourceVersion) this.documents.set(identity, { ...current, sourceVersion })
        return current.protocolVersion
      }
      const next = { sourceVersion, protocolVersion: current.protocolVersion + 1, digest }
      const updated = { ...current, ...next }
      this.documents.set(identity, updated)
      try {
        await notify('textDocument/didChange', {
          textDocument: { uri: current.protocolUri, version: next.protocolVersion }, contentChanges: [{ text }],
        })
      } catch (error) {
        if (this.documents.get(identity) === updated) this.documents.set(identity, current)
        throw error
      }
      return next.protocolVersion
    })
  }

  async match(uri: string): Promise<DocumentUriMatch | undefined> {
    const identity = await this.identity(uri)
    if (!identity) return
    const document = this.documents.get(identity)
    if (!document) return
    return { protocolUri: document.protocolUri, identity, protocolVersion: document.protocolVersion,
      rawUriMatched: document.protocolUri === uri }
  }

  identity(uri: string) { return canonicalFileUriIdentity(uri, this.platform, this.resolveFile).catch(() => undefined) }

  async close(uri: string, notify: DocumentNotification) {
    const identity = this.aliases.get(uri) ?? await canonicalFileUriIdentity(uri, this.platform, this.resolveFile)
    return this.enqueue(identity, async () => {
      const document = this.documents.get(identity)
      if (!document) return
      await notify('textDocument/didClose', { textDocument: { uri: document.protocolUri } })
      this.documents.delete(identity)
      for (const [alias, target] of this.aliases) if (target === identity) this.aliases.delete(alias)
    })
  }

  async closeAll(notify: DocumentNotification) {
    const documents = [...this.documents.values()]
    await Promise.all(documents.map(document => this.close(document.protocolUri, notify)))
    this.documents.clear()
    this.aliases.clear()
  }

  private enqueue<T>(identity: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(identity) ?? Promise.resolve()
    const task = previous.then(work, work)
    const settled = task.then(() => undefined, () => undefined)
    this.queues.set(identity, settled)
    void settled.finally(() => { if (this.queues.get(identity) === settled) this.queues.delete(identity) })
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

export function offsetAt(text: string, value: unknown): number | undefined {
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

export function locationRows(result: unknown, source: string): string[][] {
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

function validPosition(value: unknown): value is { line: number; character: number } {
  const position = value as { line?: unknown; character?: unknown } | null
  return Boolean(position && Number.isSafeInteger(position.line) && Number.isSafeInteger(position.character)
    && (position.line as number) >= 0 && (position.character as number) >= 0)
}

/** Converts a server-provided WorkspaceEdit into inert, bounded review rows.
 * It never touches disk and rejects resource operations. Main validates every
 * canonical path and revision before issuing an apply token. */
export function workspaceEditRows(result: unknown, source: string, platform = process.platform): string[][] {
  if (!result || typeof result !== 'object') return []
  const edit = result as { changes?: unknown; documentChanges?: unknown }
  const groups: { uri: string; edits: unknown[] }[] = []
  if (edit.changes !== undefined) {
    if (!edit.changes || typeof edit.changes !== 'object' || Array.isArray(edit.changes)) {
      throw new Error('Language server returned an invalid workspace edit.')
    }
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (!Array.isArray(edits)) throw new Error('Language server returned an invalid workspace edit.')
      groups.push({ uri, edits })
    }
  }
  if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges)) throw new Error('Language server returned an invalid workspace edit.')
    for (const change of edit.documentChanges) {
      if (!change || typeof change !== 'object' || 'kind' in change) {
        throw new Error('Language server resource operations are not supported.')
      }
      const value = change as { textDocument?: { uri?: unknown }; edits?: unknown }
      if (typeof value.textDocument?.uri !== 'string' || !Array.isArray(value.edits)) {
        throw new Error('Language server returned an invalid workspace edit.')
      }
      groups.push({ uri: value.textDocument.uri, edits: value.edits })
    }
  }
  const rows: string[][] = []
  let bytes = 0
  for (const group of groups) {
    if (!group.uri.startsWith('file:')) throw new Error('Language server edits must target local files.')
    let path: string
    try { path = sourceDriveSpelling(fileURLToPath(group.uri), source, platform) }
    catch { throw new Error('Language server returned an invalid file URI.') }
    for (const item of group.edits) {
      if (rows.length >= maxWorkspaceEdits) throw new Error('Language server returned too many edits to review safely.')
      const value = item as { range?: { start?: unknown; end?: unknown }; newText?: unknown } | null
      if (!value || !validPosition(value.range?.start) || !validPosition(value.range?.end)
        || typeof value.newText !== 'string' || value.newText.includes('\0')) {
        throw new Error('Language server returned an invalid text edit.')
      }
      bytes += Buffer.byteLength(value.newText)
      if (bytes > maxWorkspaceEditText) throw new Error('Language server edit text exceeds Ion’s 1 MiB review limit.')
      rows.push([path, String(value.range!.start!.line), String(value.range!.start!.character),
        String(value.range!.end!.line), String(value.range!.end!.character), value.newText])
    }
  }
  return rows
}

export function symbolRows(result: unknown, source: string): string[][] {
  const rows: string[][] = []
  const visit = (items: unknown, inheritedUri?: string) => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (rows.length >= maxRows || !item || typeof item !== 'object') break
      const value = item as { name?: unknown; kind?: unknown; detail?: unknown; uri?: unknown;
        location?: { uri?: unknown; range?: { start?: unknown } }; range?: { start?: unknown }; selectionRange?: { start?: unknown };
        children?: unknown }
      if (typeof value.name !== 'string') continue
      const uri = typeof value.location?.uri === 'string' ? value.location.uri
        : typeof value.uri === 'string' ? value.uri : inheritedUri
      const start = value.selectionRange?.start ?? value.range?.start ?? value.location?.range?.start
      if (!uri?.startsWith('file:') || !validPosition(start)) continue
      try {
        rows.push([value.name.slice(0, 300), String(value.kind ?? ''),
          typeof value.detail === 'string' ? value.detail.slice(0, 500) : '',
          sourceDriveSpelling(fileURLToPath(uri), source, process.platform),
          String(start.line + 1), String(start.character + 1)])
      } catch { continue }
      visit(value.children, uri)
    }
  }
  visit(result, pathToFileURL(source).href)
  return rows
}

export function markup(value: unknown): string {
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
    const nodeCli = await discoverWindowsNodeCli(name, root, paths)
    if (nodeCli) return { executable: nodeCli.executable, args: [...nodeCli.args, ...args], verify: nodeCli.verify,
      kind: name === 'pyright-langserver' ? 'pyright' : 'typescript' }
  }
  throw new Error(adapter === 'python-lsp'
    ? 'Install pyright-langserver or python-lsp-server outside the workspace to enable Smart Python.'
    : 'Install typescript-language-server outside the workspace to enable Smart JavaScript/TypeScript.')
}

/** Shared document adapter for installed standards-compliant LSP servers. */
export class ExternalLspService {
  private readonly documents = new LspDocumentSynchronizer()
  private readonly diagnostics = new DiagnosticGenerationFence()
  private readonly trace = new DiagnosticMetadataTrace()
  private diagnosticNotifications = Promise.resolve()
  private stopped = false

  private constructor(private readonly host: LspProcess, private readonly directory: string) {
    host.onNotification('textDocument/publishDiagnostics', params => {
      // Preserve the server's notification order while canonical filesystem
      // identities are resolved asynchronously.
      this.diagnosticNotifications = this.diagnosticNotifications
        .then(() => this.receiveDiagnostics(params), () => this.receiveDiagnostics(params))
        .catch(() => undefined)
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
      await server.verify?.()
      const host = await LspProcess.start({
        executable: server.executable, args: server.args, cwd: directory, env: envFor(paths, directory), root,
        deadlines: { initializationMs: server.kind === 'pyright' ? 20_000 : 8_000 },
        configuration: server.kind === 'pyright' ? { python: { analysis: {
          diagnosticMode: 'openFilesOnly', indexing: false, useLibraryCodeForTypes: true,
        } } } : undefined,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: { synchronization: { didSave: false }, completion: {}, hover: {}, definition: {}, declaration: {}, references: {},
            signatureHelp: {}, documentSymbol: {}, rename: { prepareSupport: false }, codeAction: {},
            publishDiagnostics: { relatedInformation: true, versionSupport: true } },
          workspace: { workspaceFolders: true, symbol: {} },
        },
      }, signal)
      return new ExternalLspService(host, directory)
    } catch (error) {
      await removeServiceScratch(directory)
      throw error
    }
  }

  get closed() { return this.stopped || this.host.isClosed }
  get executable() { return this.host.executable }
  get version() { return this.host.version }
  get capabilities() { return this.host.supportedCapabilities() }
  get pendingDiagnosticWaiterCount() { return this.diagnostics.pendingWaiterCount }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    await this.documents.closeAll((method, params) => this.host.notify(method, params)).catch(() => {})
    this.diagnostics.clear()
    await this.host.stop()
    await removeServiceScratch(this.directory)
  }

  async close(path: string) {
    const uri = pathToFileURL(path).href
    const match = await this.documents.match(uri)
    await this.documents.close(uri, (method, params) => this.host.notify(method, params))
    this.diagnostics.clear(match?.protocolUri ?? uri)
  }

  async saved(path: string) {
    const uri = pathToFileURL(path).href
    const match = await this.documents.match(uri)
    if (match) await this.host.notify('textDocument/didSave', { textDocument: { uri: match.protocolUri } })
  }

  async query(snapshot: ToolSnapshot, signal?: AbortSignal): Promise<ToolReply> {
    const uri = pathToFileURL(snapshot.path).href
    const version = await this.documents.synchronize(uri, snapshot.language, snapshot.version, snapshot.text,
      (method, params) => this.host.notify(method, params))
    const match = await this.documents.match(uri)
    const protocolUri = match?.protocolUri ?? uri
    this.trace.record({ event: 'document-synchronized', rawUriHash: this.trace.hash(uri),
      canonicalIdentityHash: this.trace.hash(match?.identity), canonicalIdentityMatched: Boolean(match),
      synchronizedProtocolVersion: version, currentGeneration: version })
    const location = { textDocument: { uri: protocolUri }, position: positionAt(snapshot.text, snapshot.offset) }
    let rows: string[][] = []
    if (snapshot.operation === 'definition' || snapshot.operation === 'declaration' || snapshot.operation === 'references') {
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
    } else if (snapshot.operation === 'documentSymbols') {
      rows = symbolRows(await this.host.request('textDocument/documentSymbol', { textDocument: { uri: protocolUri } }, undefined, signal), snapshot.path)
    } else if (snapshot.operation === 'workspaceSymbols') {
      rows = symbolRows(await this.host.request('workspace/symbol', { query: snapshot.search ?? '' }, undefined, signal), snapshot.path)
    } else if (snapshot.operation === 'rename') {
      if (typeof snapshot.replacement !== 'string') throw new Error('Enter a new symbol name.')
      const result = await this.host.request('textDocument/rename', { ...location, newName: snapshot.replacement }, undefined, signal)
      rows = workspaceEditRows(result, snapshot.path)
    } else if (snapshot.operation === 'codeActions') {
      const result = await this.host.request('textDocument/codeAction', {
        textDocument: { uri: protocolUri }, range: { start: location.position, end: location.position },
        context: { diagnostics: [] },
      }, undefined, signal)
      rows = Array.isArray(result) ? result.slice(0, maxRows).flatMap(item => {
        const value = item as { title?: unknown; kind?: unknown; disabled?: unknown } | null
        return value && typeof value.title === 'string'
          ? [[value.title.slice(0, 500), typeof value.kind === 'string' ? value.kind.slice(0, 100) : '', value.disabled ? 'disabled' : 'available']]
          : []
      }) : []
    } else if (snapshot.operation === 'diagnostics') {
      let waiting = !this.diagnostics.take(protocolUri, version)
      this.trace.record({ event: 'diagnostic-query', rawUriHash: this.trace.hash(uri),
        canonicalIdentityHash: this.trace.hash(match?.identity), synchronizedProtocolVersion: version,
        currentGeneration: version, waiterGeneration: waiting ? version : null, waiterReleased: !waiting })
      let windowOpened = false
      if (waiting && version > 1 && this.host.capabilities.hoverProvider) {
        const barrierStart = process.hrtime.bigint()
        try {
          await this.host.request('textDocument/hover', location, undefined, signal)
          this.diagnostics.beginUnversionedWindow(protocolUri, version)
          windowOpened = true
          this.trace.record({ event: 'diagnostic-fence', rawUriHash: this.trace.hash(uri),
            canonicalIdentityHash: this.trace.hash(match?.identity), synchronizedProtocolVersion: version,
            currentGeneration: version, barrier: 'hover', outcome: 'passed',
            barrierDurationNs: String(process.hrtime.bigint() - barrierStart) })
        } catch (error) {
          if (signal?.aborted) throw error
          this.trace.record({ event: 'diagnostic-fence', rawUriHash: this.trace.hash(uri),
            canonicalIdentityHash: this.trace.hash(match?.identity), synchronizedProtocolVersion: version,
            currentGeneration: version, barrier: 'hover', outcome: 'failed',
            barrierDurationNs: String(process.hrtime.bigint() - barrierStart) })
        }
        waiting = !this.diagnostics.take(protocolUri, version)
      }
      try {
        if (waiting) await this.diagnostics.wait(protocolUri, version, signal)
      } finally {
        if (windowOpened) this.diagnostics.endUnversionedWindow(protocolUri, version)
      }
      const report = this.diagnostics.take(protocolUri, version)
      this.trace.record({ event: 'diagnostic-wait-complete', rawUriHash: this.trace.hash(uri),
        canonicalIdentityHash: this.trace.hash(match?.identity), synchronizedProtocolVersion: version,
        currentGeneration: version, diagnosticVersion: report?.version ?? (report ? 'ABSENT' : null),
        decision: report ? 'accepted' : 'rejected', reason: report ? null : 'generation-mismatch',
        waiterGeneration: waiting ? version : null, waiterReleased: Boolean(report) })
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

  private async receiveDiagnostics(params: unknown) {
    if (this.stopped) return
    if (!params || typeof params !== 'object') return
    const report = params as { uri?: unknown; version?: unknown; diagnostics?: unknown }
    if (typeof report.uri !== 'string' || !Array.isArray(report.diagnostics)) return
    const incomingIdentity = await this.documents.identity(report.uri)
    const match = await this.documents.match(report.uri)
    if (this.stopped) return
    const diagnosticVersion = Number.isSafeInteger(report.version) ? report.version as number : undefined
    if (!match) {
      this.trace.record({ event: 'diagnostic-notification', rawIncomingUriHash: this.trace.hash(report.uri),
        canonicalIncomingIdentityHash: this.trace.hash(incomingIdentity), canonicalIdentityMatched: false,
        diagnosticVersion: diagnosticVersion ?? 'ABSENT', decision: 'rejected', reason: 'unknown-document',
        waiterReleased: false })
      return
    }
    const decision = this.diagnostics.publish(match.protocolUri, match.protocolVersion, {
      version: diagnosticVersion, diagnostics: report.diagnostics.slice(0, maxRows),
    })
    this.trace.record({ event: 'diagnostic-notification', rawIncomingUriHash: this.trace.hash(report.uri),
      rawProtocolUriHash: this.trace.hash(match.protocolUri), canonicalIncomingIdentityHash: this.trace.hash(incomingIdentity),
      canonicalDocumentIdentityHash: this.trace.hash(match.identity), rawUriMatched: match.rawUriMatched,
      canonicalIdentityMatched: true, synchronizedProtocolVersion: match.protocolVersion,
      diagnosticVersion: diagnosticVersion ?? 'ABSENT', currentGeneration: match.protocolVersion,
      decision: decision.decision, reason: decision.reason ?? null,
      waiterGeneration: decision.waiterGeneration ?? null, waiterReleased: decision.waiterReleased })
  }
}
