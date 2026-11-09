import { basename, isAbsolute, resolve } from 'node:path'
import {
  editorSessionTabLimit, editorViewSelectionLimit,
  type EditorSelection, type EditorSessionSnapshot, type EditorSessionTab, type EditorViewState, type ResumedEditorSession,
} from '../shared/editor-session'
import type { WorkspaceFiles } from './files'
import { readJson, writeJson } from './projects/storage'
import type { RecoveryStore } from './recovery'

const maxSessionBytes = 1024 * 1024
const recoveryIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const selectionKeys = ['selectionStartLineNumber', 'selectionStartColumn', 'positionLineNumber', 'positionColumn'] as const

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid editor session.')
  return value as Record<string, unknown>
}

function pathOrNull(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || value.includes('\0')
    || !isAbsolute(value) || resolve(value) !== value) throw new Error('Invalid editor session path.')
  return value
}

function draftName(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024
    || value === '.' || value === '..' || /[/\0\uD800-\uDFFF]/u.test(value)) {
    throw new Error('Invalid editor session draft name.')
  }
  return value
}

function parseView(value: unknown): EditorViewState | undefined {
  if (value === undefined) return undefined
  const { selections, scrollTop, scrollLeft } = record(value)
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > editorViewSelectionLimit
    || typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0 || scrollTop > 1e9
    || typeof scrollLeft !== 'number' || !Number.isFinite(scrollLeft) || scrollLeft < 0 || scrollLeft > 1e9) {
    throw new Error('Invalid editor view state.')
  }
  return {
    selections: selections.map((value: unknown) => {
      const input = record(value)
      const selection = {} as EditorSelection
      for (const key of selectionKeys) {
        const coordinate = input[key]
        if (typeof coordinate !== 'number' || !Number.isSafeInteger(coordinate) || coordinate < 1 || coordinate > 50_000_000) {
          throw new Error('Invalid editor selection.')
        }
        selection[key] = coordinate
      }
      return selection
    }),
    scrollTop,
    scrollLeft,
  }
}

function parseSnapshot(value: unknown): EditorSessionSnapshot {
  const { rootPath, activeIndex, tabs } = record(value)
  if (!Array.isArray(tabs) || tabs.length > editorSessionTabLimit || typeof activeIndex !== 'number'
    || !Number.isInteger(activeIndex) || activeIndex < -1 || activeIndex >= tabs.length) {
    throw new Error('Invalid editor session tabs.')
  }
  const paths = new Set<string>()
  const drafts = new Set<string>()
  return {
    rootPath: pathOrNull(rootPath),
    activeIndex,
    tabs: tabs.map((value: unknown): EditorSessionTab => {
      const { path, name, draftId, view, notebookMode } = record(value)
      const parsed = pathOrNull(path)
      if (parsed !== null) {
        if (paths.has(parsed)) throw new Error('Duplicate file in editor session.')
        paths.add(parsed)
      }
      if (draftId !== undefined) {
        if (typeof draftId !== 'string' || !recoveryIdPattern.test(draftId) || drafts.has(draftId)) {
          throw new Error('Invalid recovery reference in editor session.')
        }
        drafts.add(draftId)
      }
      if (notebookMode !== undefined && notebookMode !== 'notebook' && notebookMode !== 'json') {
        throw new Error('Invalid notebook mode in editor session.')
      }
      return { path: parsed, name: parsed === null ? draftName(name) : basename(parsed), draftId, notebookMode, view: parseView(view) }
    }),
  }
}

export class EditorSessionStore {
  private snapshot?: Promise<EditorSessionSnapshot | null>
  private pending = Promise.resolve()
  private encoded?: string

  constructor(private readonly path: string) {}

  private read(): Promise<EditorSessionSnapshot | null> {
    return this.snapshot ??= readJson(this.path, maxSessionBytes).then((data) => {
      if (data === null) return null
      const stored = record(data)
      if (stored.version !== 1) throw new Error('Unsupported editor session version.')
      const snapshot = parseSnapshot(stored)
      this.encoded = JSON.stringify(snapshot)
      return snapshot
    })
  }

  async available(): Promise<boolean> {
    await this.pending
    const snapshot = await this.read()
    return Boolean(snapshot && (snapshot.rootPath !== null || snapshot.tabs.length))
  }

  save(value: unknown, scope: WorkspaceFiles): Promise<void> {
    const { rootPath, activeIndex, tabs } = parseSnapshot(value)
    if (rootPath !== null && rootPath !== scope.rootPath) throw new Error('The editor session folder is no longer open.')
    const authorized: EditorSessionTab[] = []
    let selected = -1
    for (const [index, tab] of tabs.entries()) {
      const permitted = tab.path === null || scope.authorizes(tab.path)
      if (!permitted && !tab.draftId) continue
      if (index === activeIndex) selected = authorized.length
      authorized.push(permitted ? tab : { ...tab, path: null })
    }
    const snapshot = { rootPath, activeIndex: selected, tabs: authorized }
    const encoded = JSON.stringify(snapshot)
    const write = this.pending.then(async () => {
      if (encoded === this.encoded) return
      await writeJson(this.path, { version: 1, ...snapshot }, maxSessionBytes)
      this.snapshot = Promise.resolve(snapshot)
      this.encoded = encoded
    })
    this.pending = write.catch(() => undefined)
    return write
  }

  async resume(scope: WorkspaceFiles, recovery: RecoveryStore, current: () => boolean): Promise<ResumedEditorSession> {
    await this.pending
    const snapshot = await this.read()
    if (!snapshot) return { root: null, tabs: [], activeIndex: -1, skipped: 0 }
    const drafts = snapshot.tabs.some(({ draftId }) => draftId)
      ? new Map((await recovery.list()).map((draft) => [draft.id, draft]))
      : null
    const paths = snapshot.tabs.flatMap(({ path, draftId }) =>
      path && (!draftId || !drafts?.has(draftId)) ? [path] : [])
    const { root, restored } = await scope.restoreSession(snapshot.rootPath, paths, current)
    const tabs: ResumedEditorSession['tabs'] = []
    let skipped = Number(snapshot.rootPath !== null && !root)
    for (const [index, { name, path, draftId, notebookMode, view }] of snapshot.tabs.entries()) {
      const draft = draftId ? drafts?.get(draftId) : undefined
      const entry = !draft && path ? restored.get(path) : undefined
      if (!draft && !entry && (path || draftId)) {
        skipped++
        continue
      }
      tabs.push({ index, name: draft?.name ?? entry?.name ?? name, entry, draft, notebookMode, view })
    }
    return { root, tabs, activeIndex: snapshot.activeIndex, skipped }
  }
}
