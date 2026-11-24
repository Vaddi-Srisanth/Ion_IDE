import { basename, isAbsolute, resolve, win32, posix } from 'node:path'
import {
  editorSessionTabLimit, editorViewSelectionLimit,
  type EditorSelection, type EditorSessionGroupLayout, type EditorSessionGroups, type EditorSessionSnapshot,
  type EditorSessionTab, type EditorViewState, type ResumedEditorSession,
} from '../shared/editor-session'
import type { WorkspaceFiles } from './files'
import { readJson, writeJson } from './projects/storage'
import type { RecoveryStore } from './recovery'

const maxSessionBytes = 1024 * 1024
const recoveryIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const selectionKeys = ['selectionStartLineNumber', 'selectionStartColumn', 'positionLineNumber', 'positionColumn'] as const
const groupIdPattern = /^group-[1-9]\d{0,5}$/
const splitIdPattern = /^split-[1-9]\d{0,5}$/

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

function inertReference(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)
    || !(posix.isAbsolute(value) || win32.isAbsolute(value))) throw new Error('Invalid restored file reference.')
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

function parseEditorGroups(value: unknown, tabCount: number): EditorSessionGroups | undefined {
  if (value === undefined) return undefined
  const input = record(value)
  if (input.version !== 1 || !Array.isArray(input.groups) || input.groups.length < 2 || input.groups.length > 4
    || typeof input.activeGroupId !== 'string') throw new Error('Invalid editor group session.')
  const ids = new Set<string>()
  const groups = input.groups.map((value): EditorSessionGroups['groups'][number] => {
    const group = record(value)
    if (typeof group.id !== 'string' || !groupIdPattern.test(group.id) || ids.has(group.id)
      || !Array.isArray(group.tabs) || group.tabs.length > editorSessionTabLimit
      || typeof group.activeIndex !== 'number' || !Number.isInteger(group.activeIndex)) {
      throw new Error('Invalid editor group session.')
    }
    ids.add(group.id)
    const tabs = group.tabs.map((index) => {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= tabCount) {
        throw new Error('Invalid editor group tab.')
      }
      return index
    })
    if (new Set(tabs).size !== tabs.length || group.activeIndex < -1 || group.activeIndex >= tabCount
      || group.activeIndex !== -1 && !tabs.includes(group.activeIndex)) throw new Error('Invalid editor group tab.')
    return { id: group.id, tabs, activeIndex: group.activeIndex }
  })
  if (!ids.has(input.activeGroupId)) throw new Error('Invalid active editor group.')
  const splits = new Set<string>()
  const parseLayout = (value: unknown, depth = 0): EditorSessionGroupLayout => {
    if (depth > 8) throw new Error('Invalid editor group layout.')
    const node = record(value)
    if (node.kind === 'group') {
      if (typeof node.groupId !== 'string' || !ids.has(node.groupId)) throw new Error('Invalid editor group layout.')
      return { kind: 'group', groupId: node.groupId }
    }
    if (node.kind !== 'split' || typeof node.id !== 'string' || !splitIdPattern.test(node.id) || splits.has(node.id)
      || node.orientation !== 'horizontal' && node.orientation !== 'vertical'
      || typeof node.percent !== 'number' || !Number.isFinite(node.percent) || node.percent < 20 || node.percent > 80) {
      throw new Error('Invalid editor group layout.')
    }
    splits.add(node.id)
    return { kind: 'split', id: node.id, orientation: node.orientation, percent: Math.round(node.percent),
      first: parseLayout(node.first, depth + 1), second: parseLayout(node.second, depth + 1) }
  }
  const layout = parseLayout(input.layout)
  const layoutIds: string[] = []
  const collect = (node: EditorSessionGroupLayout): void => {
    if (node.kind === 'group') layoutIds.push(node.groupId)
    else { collect(node.first); collect(node.second) }
  }
  collect(layout)
  if (layoutIds.length !== ids.size || new Set(layoutIds).size !== ids.size) throw new Error('Invalid editor group layout.')
  return { version: 1, layout, groups, activeGroupId: input.activeGroupId }
}

export function validateEditorSnapshot(value: unknown, parsePath = pathOrNull): EditorSessionSnapshot {
  const { rootPath, activeIndex, tabs, editorGroups, restoredReferences, restoredRoot } = record(value)
  if (!Array.isArray(tabs) || tabs.length > editorSessionTabLimit || typeof activeIndex !== 'number'
    || !Number.isInteger(activeIndex) || activeIndex < -1 || activeIndex >= tabs.length) {
    throw new Error('Invalid editor session tabs.')
  }
  let references: EditorSessionTab[] | undefined
  if (restoredReferences !== undefined) {
    if (!Array.isArray(restoredReferences) || restoredReferences.length > 64) throw new Error('Invalid restored session references.')
    references = validateEditorSnapshot({ rootPath: null, activeIndex: -1, tabs: restoredReferences }, inertReference).tabs
    if (references.some(t => t.path === null || t.draftId)) throw new Error('Invalid restored session reference.')
  }
  const restored = restoredRoot === undefined ? undefined : inertReference(restoredRoot)
  const paths = new Set<string>()
  const drafts = new Set<string>()
  const groups = parseEditorGroups(editorGroups, tabs.length)
  return {
    ...(references ? { restoredReferences: references } : {}),
    ...(restored ? { restoredRoot: restored } : {}),
    rootPath: parsePath(rootPath),
    activeIndex,
    ...(groups ? { editorGroups: groups } : {}),
    tabs: tabs.map((value: unknown): EditorSessionTab => {
      const { path, name, draftId, view, notebookMode } = record(value)
      const parsed = parsePath(path)
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
      return { path: parsed, name: parsed === null ? draftName(name) : (win32.isAbsolute(parsed) && !posix.isAbsolute(parsed) ? win32.basename(parsed) : basename(parsed)), draftId, notebookMode, view: parseView(view) }
    }),
  }
}

function remapGroups(groups: EditorSessionGroups | undefined, indexes: Map<number, number>): EditorSessionGroups | undefined {
  if (!groups) return undefined
  const mapped = groups.groups.map((group) => ({ ...group,
    tabs: group.tabs.flatMap((index) => indexes.has(index) ? [indexes.get(index)!] : []),
    activeIndex: indexes.get(group.activeIndex) ?? -1,
  })).filter((group) => group.tabs.length)
  if (mapped.length < 2) return undefined
  const ids = new Set(mapped.map(({ id }) => id))
  const prune = (node: EditorSessionGroupLayout): EditorSessionGroupLayout | null => {
    if (node.kind === 'group') return ids.has(node.groupId) ? node : null
    const first = prune(node.first), second = prune(node.second)
    return first && second ? { ...node, first, second } : first ?? second
  }
  const layout = prune(groups.layout)
  if (!layout) return undefined
  return { version: 1, groups: mapped, layout,
    activeGroupId: ids.has(groups.activeGroupId) ? groups.activeGroupId : mapped[0].id }
}

export class EditorSessionStore {
  private snapshot?: Promise<EditorSessionSnapshot | null>
  private pending = Promise.resolve()
  private encoded?: string

  drain(): Promise<void> { return this.pending }

  constructor(private readonly path: string) {}

  private read(): Promise<EditorSessionSnapshot | null> {
    return this.snapshot ??= readJson(this.path, maxSessionBytes).then((data) => {
      if (data === null) return null
      const stored = record(data)
      if (stored.version !== 1) throw new Error('Unsupported editor session version.')
      const snapshot = validateEditorSnapshot(stored)
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
    const { rootPath, activeIndex, tabs, editorGroups } = validateEditorSnapshot(value)
    if (rootPath !== null && rootPath !== scope.rootPath) throw new Error('The editor session folder is no longer open.')
    const authorized: EditorSessionTab[] = []
    const indexes = new Map<number, number>()
    let selected = -1
    for (const [index, tab] of tabs.entries()) {
      const permitted = tab.path === null || scope.authorizes(tab.path)
      if (!permitted && !tab.draftId) continue
      if (index === activeIndex) selected = authorized.length
      indexes.set(index, authorized.length)
      authorized.push(permitted ? tab : { ...tab, path: null })
    }
    const groups = remapGroups(editorGroups, indexes)
    const snapshot = { rootPath, activeIndex: selected, tabs: authorized, ...(groups ? { editorGroups: groups } : {}) }
    const encoded = JSON.stringify(snapshot)
    const write = this.pending.then(async () => {
      if (encoded === this.encoded) return
      const previous = await this.read().catch(() => null)
      const saved = { ...snapshot, ...(previous?.restoredReferences ? { restoredReferences: previous.restoredReferences } : {}),
        ...(previous?.restoredRoot ? { restoredRoot: previous.restoredRoot } : {}) }
      await writeJson(this.path, { version: 1, ...saved }, maxSessionBytes)
      this.snapshot = Promise.resolve(saved)
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
    return { root, tabs, activeIndex: snapshot.activeIndex, skipped, ...(snapshot.editorGroups ? { editorGroups: snapshot.editorGroups } : {}) }
  }
}
