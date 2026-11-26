import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolReply, ToolSnapshot } from '../../shared/language-tools'
import { execute } from '../runner'
import { commandPaths, envFor, executable, onPath } from '../run-console/plans'
import { LspProcess, type LspLifecycleStage } from './lsp-process'
import { locationRows, markup, offsetAt, symbolRows, workspaceEditRows } from './lsp-adapter'

type ClangdLifecycleStage = LspLifecycleStage | 'executable-discovery' | 'executable-discovered'
  | 'document-open-request' | 'document-open-synchronized' | 'first-diagnostic'
type ClangdTimingHook = (stage: ClangdLifecycleStage) => void

function timingHook(): ClangdTimingHook | undefined {
  const hook = (globalThis as typeof globalThis & { __ionClangdTimingProbe?: unknown }).__ionClangdTimingProbe
  if (typeof hook !== 'function') return
  return stage => { try { (hook as ClangdTimingHook)(stage) } catch { /* Verification observation only. */ } }
}

async function findClangd(root: string, paths: string[], scratch: string, signal: AbortSignal): Promise<string> {
  const configured = process.env.ION_CLANGD_PATH
  if (configured && await executable(configured, root)) return configured
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
  private documentText = ''
  private documentSourceVersion = 0
  private documentVersion = 0
  private stopped = false
  private diagnosticObserved = false
  private diagnosticReport?: { uri: string; version?: number; diagnostics: unknown[] }
  private diagnosticWaiters = new Set<() => void>()

  private constructor(private readonly process: LspProcess, private readonly directory: string,
    private readonly trace?: ClangdTimingHook) {
    process.onNotification('textDocument/publishDiagnostics', params => {
      if (!this.diagnosticObserved) {
        this.diagnosticObserved = true
        this.trace?.('first-diagnostic')
      }
      if (!params || typeof params !== 'object') return
      const value = params as { uri?: unknown; version?: unknown; diagnostics?: unknown }
      if (typeof value.uri !== 'string' || !Array.isArray(value.diagnostics) || value.uri !== this.document) return
      this.diagnosticReport = { uri: value.uri,
        version: Number.isSafeInteger(value.version) ? value.version as number : undefined,
        diagnostics: value.diagnostics.slice(0, 200) }
      for (const release of this.diagnosticWaiters) release()
      this.diagnosticWaiters.clear()
    })
  }

  static async start(root: string | null, source: string, signal: AbortSignal): Promise<ClangdService> {
    const directory = await mkdtemp(join(tmpdir(), 'ion-clangd-'))
    const trace = timingHook()
    let service: ClangdService | undefined
    try {
      const boundary = root ?? dirname(source)
      const paths = await commandPaths(boundary)
      trace?.('executable-discovery')
      const binary = await findClangd(boundary, paths, directory, signal)
      trace?.('executable-discovered')
      signal.throwIfAborted()
      const process = await LspProcess.start({
        executable: binary,
        args: ['--background-index=0', '--enable-config=0', '--pch-storage=disk', '-j=1', '--log=error'],
        cwd: directory,
        env: envFor(paths, directory),
        root,
        trace,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: { synchronization: { didSave: false }, completion: {}, hover: {}, definition: {}, declaration: {}, references: {},
            signatureHelp: {}, documentSymbol: {}, rename: { prepareSupport: false }, codeAction: {},
            publishDiagnostics: { relatedInformation: true, versionSupport: true } },
          workspace: { workspaceFolders: true, symbol: {} },
        },
      }, signal)
      service = new ClangdService(process, directory, trace)
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
    for (const release of this.diagnosticWaiters) release()
    this.diagnosticWaiters.clear()
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
    if (this.document !== uri) {
      if (this.document) await this.process.notify('textDocument/didClose', { textDocument: { uri: this.document } })
      this.document = uri
      this.documentText = snapshot.text
      this.documentSourceVersion = snapshot.version
      this.documentVersion = 1
      this.diagnosticReport = undefined
      this.trace?.('document-open-request')
      await this.process.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: snapshot.language, version: this.documentVersion, text: snapshot.text },
      })
      this.trace?.('document-open-synchronized')
    } else if (snapshot.version === this.documentSourceVersion && snapshot.text !== this.documentText) {
      throw new Error('Conflicting clangd document snapshot.')
    } else if (snapshot.text !== this.documentText) {
      this.documentText = snapshot.text
      this.documentSourceVersion = snapshot.version
      this.documentVersion++
      this.diagnosticReport = undefined
      await this.process.notify('textDocument/didChange', {
        textDocument: { uri, version: this.documentVersion }, contentChanges: [{ text: snapshot.text }],
      })
    } else if (snapshot.version > this.documentSourceVersion) {
      this.documentSourceVersion = snapshot.version
    }
    const location = { textDocument: { uri }, position: positionAt(snapshot.text, snapshot.offset) }
    let rows: string[][] = []
    if (snapshot.operation === 'definition' || snapshot.operation === 'declaration' || snapshot.operation === 'references') {
      const result = await this.request(`textDocument/${snapshot.operation}`, snapshot.operation === 'references'
        ? { ...location, context: { includeDeclaration: true } } : location, signal)
      rows = locationRows(result, snapshot.path)
    } else if (snapshot.operation === 'hover') {
      const result = await this.request('textDocument/hover', location, signal) as { contents?: unknown } | null
      const text = markup(result?.contents)
      if (text) rows = [['hover', text]]
    } else if (snapshot.operation === 'complete') {
      const result = await this.request('textDocument/completion', location, signal) as { items?: unknown } | unknown[] | null
      const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
      rows = items.slice(0, 200).flatMap(item => {
        const value = item as { label?: unknown; kind?: unknown; detail?: unknown; insertText?: unknown } | null
        return value && typeof value.label === 'string' ? [[value.label.slice(0, 300), String(value.kind ?? ''),
          typeof value.detail === 'string' ? value.detail.slice(0, 500) : '',
          typeof value.insertText === 'string' ? value.insertText.slice(0, 4_096) : value.label.slice(0, 300)]] : []
      })
    } else if (snapshot.operation === 'signature') {
      const result = await this.request('textDocument/signatureHelp', location, signal) as { activeParameter?: unknown; signatures?: unknown } | null
      const signatures = Array.isArray(result?.signatures) ? result.signatures : []
      rows = signatures.slice(0, 20).flatMap(item => {
        const value = item as { label?: unknown; parameters?: unknown } | null
        if (!value || typeof value.label !== 'string') return []
        const parameters = Array.isArray(value.parameters) ? value.parameters.slice(0, 50).map(parameter =>
          typeof (parameter as { label?: unknown })?.label === 'string' ? String((parameter as { label: unknown }).label) : '') : []
        return [[String(result?.activeParameter ?? 0), value.label.slice(0, 1_000), ...parameters]]
      })
    } else if (snapshot.operation === 'documentSymbols') {
      rows = symbolRows(await this.request('textDocument/documentSymbol', { textDocument: { uri } }, signal), snapshot.path)
    } else if (snapshot.operation === 'workspaceSymbols') {
      rows = symbolRows(await this.request('workspace/symbol', { query: snapshot.search ?? '' }, signal), snapshot.path)
    } else if (snapshot.operation === 'rename') {
      if (typeof snapshot.replacement !== 'string') throw new Error('Enter a new symbol name.')
      rows = workspaceEditRows(await this.request('textDocument/rename', { ...location, newName: snapshot.replacement }, signal), snapshot.path)
    } else if (snapshot.operation === 'codeActions') {
      const result = await this.request('textDocument/codeAction', {
        textDocument: { uri }, range: { start: location.position, end: location.position }, context: { diagnostics: [] },
      }, signal)
      rows = Array.isArray(result) ? result.slice(0, 200).flatMap(item => {
        const value = item as { title?: unknown; kind?: unknown; disabled?: unknown } | null
        return value && typeof value.title === 'string'
          ? [[value.title.slice(0, 500), typeof value.kind === 'string' ? value.kind.slice(0, 100) : '', value.disabled ? 'disabled' : 'available']]
          : []
      }) : []
    } else if (snapshot.operation === 'diagnostics') {
      const current = () => this.diagnosticReport?.uri === uri
        && (this.diagnosticReport.version === undefined || this.diagnosticReport.version === this.documentVersion)
      const deadline = Date.now() + 4_000
      while (!current() && !this.stopped && Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          const release = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve() }
          const abort = () => { this.diagnosticWaiters.delete(release); clearTimeout(timer); reject(signal?.reason ?? new Error('Cancelled.')) }
          const timer = setTimeout(() => { this.diagnosticWaiters.delete(release); resolve() }, Math.max(1, deadline - Date.now()))
          timer.unref()
          this.diagnosticWaiters.add(release)
          signal?.addEventListener('abort', abort, { once: true })
        })
      }
      if (current()) rows = this.diagnosticReport!.diagnostics.flatMap(item => {
        const value = item as { severity?: unknown; message?: unknown; range?: { start?: unknown; end?: unknown }; source?: unknown } | null
        const start = offsetAt(snapshot.text, value?.range?.start), end = offsetAt(snapshot.text, value?.range?.end)
        if (start === undefined || typeof value?.message !== 'string') return []
        const severity = value.severity === 1 ? 'error' : value.severity === 2 ? 'warning' : 'note'
        return [[severity, String(start), String(end ?? start + 1), value.message.slice(0, 2_000),
          typeof value.source === 'string' ? value.source.slice(0, 100) : 'clangd']]
      })
    }
    return { version: snapshot.version, rows }
  }
}
