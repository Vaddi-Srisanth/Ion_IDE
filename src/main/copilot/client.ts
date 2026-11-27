import { randomUUID } from 'node:crypto'

export interface CopilotPosition { line: number; character: number }

export interface CopilotTransport {
  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): { dispose(): void }
  stop(): Promise<void>
}

export interface CopilotDocument {
  uri: string
  languageId: string
  version: number
  text: string
}

export interface CopilotInlineCompletion {
  id: string
  text: string
  range: { start: CopilotPosition; end: CopilotPosition }
  version: number
}

export interface CopilotStatus {
  kind: 'Normal' | 'Error' | 'Warning' | 'Inactive'
  message: string
  busy: boolean
}

const byteLimit = 256 * 1024
const itemLimit = 5
const itemTextLimit = 16 * 1024
const identityCommand = 'github.copilot.didAcceptCompletionItem'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function position(value: unknown): CopilotPosition | undefined {
  const row = object(value)
  if (!row || !Number.isSafeInteger(row.line) || (row.line as number) < 0
    || !Number.isSafeInteger(row.character) || (row.character as number) < 0) return
  return { line: row.line as number, character: row.character as number }
}

function checkedDocument(value: CopilotDocument): CopilotDocument {
  let uri: URL | undefined
  try { uri = new URL(value?.uri) } catch { /* rejected below */ }
  if (!value || typeof value !== 'object' || typeof value.uri !== 'string' || value.uri.length > 4096
    || uri?.protocol !== 'file:' || !value.uri.startsWith('file:///') || uri.host || !uri.pathname.startsWith('/')
    || uri.username || uri.password || uri.search || uri.hash
    || value.uri.includes('\0') || typeof value.languageId !== 'string'
    || !/^[A-Za-z0-9_+.-]{1,64}$/.test(value.languageId) || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.text !== 'string' || Buffer.byteLength(value.text) > byteLimit || value.text.includes('\0')) {
    throw new Error('Copilot requires a current, bounded local source document.')
  }
  return value
}

function validRange(value: unknown): { start: CopilotPosition; end: CopilotPosition } | undefined {
  const row = object(value), start = position(row?.start), end = position(row?.end)
  if (!start || !end || start.line !== end.line || start.character > end.character) return
  return { start, end }
}

function validAcceptanceCommand(value: unknown): { command: string; arguments: unknown[] } | undefined {
  const row = object(value)
  if (row?.command !== identityCommand || !Array.isArray(row.arguments) || row.arguments.length !== 1
    || typeof row.arguments[0] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.arguments[0])) return
  return { command: identityCommand, arguments: [...row.arguments] }
}

/**
 * A narrow client for GitHub's documented Copilot Language Server protocol.
 * It synchronizes only the active document and never accepts server workspace edits.
 * Callers must create the client only after an explicit Copilot sharing review.
 */
export class CopilotLanguageClient {
  private readonly statusListener: { dispose(): void }
  private statusValue: CopilotStatus = { kind: 'Error', message: 'Not signed in to GitHub Copilot.', busy: false }
  private document?: CopilotDocument
  private active?: AbortController
  private signInCommand?: { command: string; arguments: unknown[] }
  private readonly completions = new Map<string, { item: Record<string, unknown>; command?: { command: string; arguments: unknown[] }; version: number }>()
  private closed = false

  constructor(private readonly transport: CopilotTransport, private readonly onStatus?: (status: CopilotStatus) => void) {
    this.statusListener = transport.onNotification('didChangeStatus', value => {
      const row = object(value)
      if (!row || !['Normal', 'Error', 'Warning', 'Inactive'].includes(row.kind as string)
        || typeof row.message !== 'string' || row.message.length > 512 || /[\x00-\x1f\x7f]/.test(row.message)) return
      this.statusValue = { kind: row.kind as CopilotStatus['kind'], message: row.message, busy: row.busy === true }
      this.onStatus?.({ ...this.statusValue })
    })
  }

  status(): CopilotStatus { return { ...this.statusValue } }

  /** Uses GitHub's local-only status check; no token or credential reaches the caller. */
  async checkStatus(signal?: AbortSignal): Promise<{ status: string; user?: string }> {
    const value = object(await this.transport.request('checkStatus', { options: { localChecksOnly: true } }, 5000, signal))
    if (typeof value?.status !== 'string' || value.status.length > 80) throw new Error('GitHub Copilot returned an invalid account status.')
    const user = typeof value.user === 'string' && value.user.length <= 100 && !/[\x00-\x1f\x7f]/.test(value.user)
      ? value.user : undefined
    return { status: value.status, ...(user ? { user } : {}) }
  }

  /** Begins the official device flow and retains the server command in main only. */
  async beginSignIn(signal?: AbortSignal): Promise<{ userCode: string }> {
    this.signInCommand = undefined
    const value = object(await this.transport.request('signIn', {}, 10_000, signal))
    const command = object(value?.command)
    if (typeof value?.userCode !== 'string' || !/^[A-Z0-9-]{4,16}$/.test(value.userCode)
      || command?.command !== 'github.copilot.finishDeviceFlow'
      || !Array.isArray(command.arguments) || command.arguments.length !== 0) {
      throw new Error('GitHub Copilot returned an invalid sign-in request.')
    }
    this.signInCommand = { command: 'github.copilot.finishDeviceFlow', arguments: [] }
    return { userCode: value.userCode }
  }

  /** Completes only the command returned by the official sign-in request. */
  async finishSignIn(signal?: AbortSignal): Promise<{ status: string; user?: string }> {
    const command = this.signInCommand
    this.signInCommand = undefined
    if (!command) throw new Error('Start Copilot sign-in before completing it.')
    await this.transport.request('workspace/executeCommand', command, 10_000, signal)
    return this.checkStatus(signal)
  }

  async signOut(signal?: AbortSignal): Promise<{ status: string; user?: string }> {
    this.signInCommand = undefined
    this.cancelCompletion()
    await this.closeDocument()
    await this.transport.request('signOut', {}, 10_000, signal)
    return this.checkStatus(signal)
  }

  async complete(documentValue: CopilotDocument, at: CopilotPosition, triggerKind: 1 | 2,
    signal?: AbortSignal): Promise<CopilotInlineCompletion[]> {
    if (this.closed) throw new Error('GitHub Copilot is not active.')
    const document = checkedDocument(documentValue)
    if (!position(at) || at.line >= document.text.split(/\r\n|\r|\n/).length
      || at.character > lineLength(document.text, at.line)) throw new Error('Copilot completion position is outside the current document.')
    const previous = this.document
    if (previous && previous.uri !== document.uri) await this.closeDocument()
    if (!this.document) {
      await this.transport.notify('textDocument/didOpen', { textDocument: {
        uri: document.uri, languageId: document.languageId, version: document.version, text: document.text,
      } })
    } else if (document.version < this.document.version) {
      throw new Error('Copilot document version moved backwards.')
    } else if (document.version === this.document.version && document.text !== this.document.text) {
      throw new Error('Copilot source changed without a new editor version.')
    } else if (document.languageId !== this.document.languageId) {
      throw new Error('Copilot document language changed without reopening the document.')
    } else if (document.version > this.document.version) {
      await this.transport.notify('textDocument/didChange', {
        textDocument: { uri: document.uri, version: document.version }, contentChanges: [{ text: document.text }],
      })
    }
    this.document = { ...document }
    await this.transport.notify('textDocument/didFocus', { textDocument: { uri: document.uri } })
    this.cancelCompletion()
    const controller = new AbortController()
    this.active = controller
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort(signal.reason)
    try {
      let response: Record<string, unknown> | undefined
      try {
        response = object(await this.transport.request('textDocument/inlineCompletion', {
          textDocument: { uri: document.uri, version: document.version }, position: at,
          context: { triggerKind }, formattingOptions: { tabSize: 4, insertSpaces: true },
        }, 3000, controller.signal))
      } catch (error) {
        if (controller.signal.aborted) return []
        throw error
      }
      if (controller.signal.aborted || this.document?.uri !== document.uri || this.document.version !== document.version) return []
      if (!Array.isArray(response?.items)) return []
      const result: CopilotInlineCompletion[] = []
      for (const raw of response.items.slice(0, itemLimit)) {
        const item = object(raw), range = validRange(item?.range)
        const insertText = typeof item?.insertText === 'string' && Buffer.byteLength(item.insertText) <= itemTextLimit
          && !item.insertText.includes('\0') ? item.insertText : undefined
        if (!item || !range || insertText === undefined || !insertText || range.start.line !== at.line || range.end.line !== at.line
          || range.start.character > at.character || range.end.character < at.character
          || range.end.line >= document.text.split(/\r\n|\r|\n/).length
          || range.end.character > lineLength(document.text, range.end.line)) continue
        const id = randomUUID(), command = validAcceptanceCommand(item.command)
        this.completions.set(id, { item, ...(command && { command }), version: document.version })
        while (this.completions.size > 32) this.completions.delete(this.completions.keys().next().value!)
        result.push({ id, text: insertText, range, version: document.version })
      }
      return result
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.active === controller) this.active = undefined
    }
  }

  async shown(id: string): Promise<void> {
    const selected = this.completions.get(id)
    if (selected && this.document?.version === selected.version) await this.transport.notify('textDocument/didShowCompletion', { item: selected.item })
  }

  async partiallyAccepted(id: string, acceptedLength: number): Promise<void> {
    const selected = this.completions.get(id)
    if (!selected || this.document?.version !== selected.version || !Number.isSafeInteger(acceptedLength)
      || acceptedLength < 1 || acceptedLength > Buffer.byteLength(String(selected.item.insertText), 'utf16le') / 2) return
    await this.transport.notify('textDocument/didPartiallyAcceptCompletion', { item: selected.item, acceptedLength })
  }

  async accepted(id: string): Promise<void> {
    const selected = this.completions.get(id)
    this.completions.delete(id)
    if (!selected || this.document?.version !== selected.version || !selected.command) return
    await this.transport.request('workspace/executeCommand', selected.command, 3000)
  }

  cancelCompletion(): void { this.active?.abort(new Error('Copilot completion superseded.')) }

  async closeDocument(): Promise<void> {
    this.cancelCompletion()
    const document = this.document
    this.document = undefined
    this.completions.clear()
    if (document) await this.transport.notify('textDocument/didClose', { textDocument: { uri: document.uri } })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancelCompletion()
    this.statusListener.dispose()
    try { await this.closeDocument() } finally { await this.transport.stop() }
  }
}

function lineLength(text: string, line: number): number {
  const lines = text.split(/\r\n|\r|\n/)
  return lines[line]?.length ?? -1
}
