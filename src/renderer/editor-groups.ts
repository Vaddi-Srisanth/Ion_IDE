import type { DocumentsSnapshot } from './documents'

export type GroupDirection = 'left' | 'right' | 'up' | 'down'
export type GroupOrientation = 'horizontal' | 'vertical'

export interface EditorGroup {
  id: string
  tabs: string[]
  activeId: string | null
}

export type EditorGroupLayout =
  | { kind: 'group'; groupId: string }
  | { kind: 'split'; id: string; orientation: GroupOrientation; percent: number; first: EditorGroupLayout; second: EditorGroupLayout }

export interface EditorGroupsSnapshot {
  version: 1
  layout: EditorGroupLayout
  groups: EditorGroup[]
  activeGroupId: string
}

interface DocumentSource {
  getSnapshot(): DocumentsSnapshot
  subscribe(listener: () => void): () => void
  select(id: string): void
}

interface Rect { left: number; top: number; right: number; bottom: number }

const groupLimit = 4
const minimumPercent = 20
const maximumPercent = 80

const cloneLayout = (layout: EditorGroupLayout): EditorGroupLayout => layout.kind === 'group' ? { ...layout } : {
  ...layout, first: cloneLayout(layout.first), second: cloneLayout(layout.second),
}

function replaceGroup(layout: EditorGroupLayout, groupId: string, replacement: EditorGroupLayout): EditorGroupLayout {
  if (layout.kind === 'group') return layout.groupId === groupId ? replacement : layout
  return { ...layout, first: replaceGroup(layout.first, groupId, replacement), second: replaceGroup(layout.second, groupId, replacement) }
}

function removeGroup(layout: EditorGroupLayout, groupId: string): EditorGroupLayout | null {
  if (layout.kind === 'group') return layout.groupId === groupId ? null : layout
  const first = removeGroup(layout.first, groupId)
  const second = removeGroup(layout.second, groupId)
  if (!first) return second
  if (!second) return first
  return { ...layout, first, second }
}

function groupIds(layout: EditorGroupLayout, result: string[] = []): string[] {
  if (layout.kind === 'group') result.push(layout.groupId)
  else {
    groupIds(layout.first, result)
    groupIds(layout.second, result)
  }
  return result
}

function splitRects(layout: EditorGroupLayout, rect: Rect, result: Map<string, Rect>) {
  if (layout.kind === 'group') {
    result.set(layout.groupId, rect)
    return
  }
  const ratio = layout.percent / 100
  if (layout.orientation === 'horizontal') {
    const middle = rect.left + (rect.right - rect.left) * ratio
    splitRects(layout.first, { ...rect, right: middle }, result)
    splitRects(layout.second, { ...rect, left: middle }, result)
  } else {
    const middle = rect.top + (rect.bottom - rect.top) * ratio
    splitRects(layout.first, { ...rect, bottom: middle }, result)
    splitRects(layout.second, { ...rect, top: middle }, result)
  }
}

function neighbor(layout: EditorGroupLayout, groupId: string, direction: GroupDirection): string | null {
  const rects = new Map<string, Rect>()
  splitRects(layout, { left: 0, top: 0, right: 1, bottom: 1 }, rects)
  const source = rects.get(groupId)
  if (!source) return null
  const sx = (source.left + source.right) / 2
  const sy = (source.top + source.bottom) / 2
  const candidates = [...rects].flatMap(([id, rect]) => {
    if (id === groupId) return []
    const x = (rect.left + rect.right) / 2
    const y = (rect.top + rect.bottom) / 2
    const forward = direction === 'left' ? sx - x : direction === 'right' ? x - sx : direction === 'up' ? sy - y : y - sy
    if (forward <= 0) return []
    const cross = direction === 'left' || direction === 'right' ? Math.abs(y - sy) : Math.abs(x - sx)
    const overlap = direction === 'left' || direction === 'right'
      ? Math.min(source.bottom, rect.bottom) - Math.max(source.top, rect.top)
      : Math.min(source.right, rect.right) - Math.max(source.left, rect.left)
    return [{ id, score: forward * 4 + cross + (overlap > 0.000001 ? 0 : 10) }]
  })
  candidates.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
  return candidates[0]?.id ?? null
}

function normalizedGroup(value: unknown, validTabs: Set<string>): EditorGroup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const group = value as Partial<EditorGroup>
  if (typeof group.id !== 'string' || !/^group-[1-9]\d{0,5}$/.test(group.id) || !Array.isArray(group.tabs)) return null
  const tabs = [...new Set(group.tabs.filter((tab): tab is string => typeof tab === 'string' && validTabs.has(tab)))]
  const activeId = typeof group.activeId === 'string' && tabs.includes(group.activeId) ? group.activeId : tabs.at(-1) ?? null
  return { id: group.id, tabs, activeId }
}

function normalizedLayout(value: unknown, validGroups: Set<string>, seenSplits: Set<string>, depth = 0): EditorGroupLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > groupLimit * 2) return null
  const node = value as Partial<EditorGroupLayout> & { groupId?: unknown; first?: unknown; second?: unknown }
  if (node.kind === 'group') return typeof node.groupId === 'string' && validGroups.has(node.groupId)
    ? { kind: 'group', groupId: node.groupId } : null
  if (node.kind !== 'split' || typeof node.id !== 'string' || !/^split-[1-9]\d{0,5}$/.test(node.id)
    || seenSplits.has(node.id) || node.orientation !== 'horizontal' && node.orientation !== 'vertical'
    || typeof node.percent !== 'number' || !Number.isFinite(node.percent)) return null
  seenSplits.add(node.id)
  const first = normalizedLayout(node.first, validGroups, seenSplits, depth + 1)
  const second = normalizedLayout(node.second, validGroups, seenSplits, depth + 1)
  if (!first || !second) return null
  return { kind: 'split', id: node.id, orientation: node.orientation,
    percent: Math.max(minimumPercent, Math.min(maximumPercent, Math.round(node.percent))), first, second }
}

export class EditorGroups {
  private groups = new Map<string, EditorGroup>()
  private layout: EditorGroupLayout
  private activeGroupId: string
  private sequence = 1
  private splitSequence = 0
  private listeners = new Set<() => void>()
  private snapshot: EditorGroupsSnapshot
  private syncing = false
  private readonly unsubscribe: () => void

  constructor(private readonly documents: DocumentSource) {
    const tabs = documents.getSnapshot().tabs.map(({ id }) => id)
    const group: EditorGroup = { id: 'group-1', tabs, activeId: documents.getSnapshot().activeId }
    this.groups.set(group.id, group)
    this.layout = { kind: 'group', groupId: group.id }
    this.activeGroupId = group.id
    this.snapshot = this.buildSnapshot()
    this.unsubscribe = documents.subscribe(() => this.syncDocuments())
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  dispose() {
    this.unsubscribe()
    this.listeners.clear()
  }

  select(groupId: string, tabId: string) {
    const group = this.groups.get(groupId)
    if (!group || !group.tabs.includes(tabId)) return false
    group.activeId = tabId
    this.activeGroupId = groupId
    this.publish()
    if (this.documents.getSnapshot().activeId !== tabId) this.documents.select(tabId)
    return true
  }

  split(groupId: string, direction: GroupDirection): string | null {
    const source = this.groups.get(groupId)
    if (!source || this.groups.size >= groupLimit) return null
    const id = `group-${++this.sequence}`
    const orientation: GroupOrientation = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'
    const created: EditorGroup = { id, tabs: source.activeId ? [source.activeId] : [], activeId: source.activeId }
    this.groups.set(id, created)
    const existing: EditorGroupLayout = { kind: 'group', groupId }
    const added: EditorGroupLayout = { kind: 'group', groupId: id }
    const first = direction === 'left' || direction === 'up' ? added : existing
    const second = first === added ? existing : added
    this.layout = replaceGroup(this.layout, groupId, {
      kind: 'split', id: `split-${++this.splitSequence}`, orientation, percent: 50, first, second,
    })
    this.activeGroupId = id
    this.publish()
    return id
  }

  focus(direction: GroupDirection) {
    const target = neighbor(this.layout, this.activeGroupId, direction)
    if (!target) return false
    const group = this.groups.get(target)
    if (!group) return false
    this.activeGroupId = target
    this.publish()
    if (group.activeId && this.documents.getSnapshot().activeId !== group.activeId) this.documents.select(group.activeId)
    return true
  }

  moveActive(direction: GroupDirection) {
    const source = this.groups.get(this.activeGroupId)
    const tabId = source?.activeId
    const targetId = neighbor(this.layout, this.activeGroupId, direction)
    const target = targetId ? this.groups.get(targetId) : undefined
    if (!source || !tabId || !target) return false
    source.tabs = source.tabs.filter((id) => id !== tabId)
    source.activeId = source.tabs.at(-1) ?? null
    if (!target.tabs.includes(tabId)) target.tabs.push(tabId)
    target.activeId = tabId
    this.activeGroupId = target.id
    if (!source.tabs.length && this.groups.size > 1) this.removeEmptyGroup(source.id)
    this.publish()
    return true
  }

  moveTab(tabId: string, fromGroupId: string, toGroupId: string, index?: number) {
    const source = this.groups.get(fromGroupId)
    const target = this.groups.get(toGroupId)
    if (!source || !target || !source.tabs.includes(tabId)) return false
    source.tabs = source.tabs.filter((id) => id !== tabId)
    source.activeId = source.activeId === tabId ? source.tabs.at(-1) ?? null : source.activeId
    target.tabs = target.tabs.filter((id) => id !== tabId)
    const position = Math.max(0, Math.min(target.tabs.length, index ?? target.tabs.length))
    target.tabs.splice(position, 0, tabId)
    target.activeId = tabId
    this.activeGroupId = target.id
    if (!source.tabs.length && this.groups.size > 1) this.removeEmptyGroup(source.id)
    this.publish()
    if (this.documents.getSnapshot().activeId !== tabId) this.documents.select(tabId)
    return true
  }

  close(groupId: string) {
    const source = this.groups.get(groupId)
    if (!source || this.groups.size === 1) return false
    const ordered = groupIds(this.layout)
    const index = ordered.indexOf(groupId)
    const targetId = ordered[index + 1] ?? ordered[index - 1]
    const target = this.groups.get(targetId)
    if (!target) return false
    for (const tab of source.tabs) if (!target.tabs.includes(tab)) target.tabs.push(tab)
    target.activeId = source.activeId ?? target.activeId ?? target.tabs.at(-1) ?? null
    this.removeEmptyGroup(groupId)
    this.activeGroupId = target.id
    this.publish()
    if (target.activeId && this.documents.getSnapshot().activeId !== target.activeId) this.documents.select(target.activeId)
    return true
  }

  resize(splitId: string, percent: number) {
    if (!Number.isFinite(percent)) return false
    let changed = false
    const update = (layout: EditorGroupLayout): EditorGroupLayout => {
      if (layout.kind === 'group') return layout
      if (layout.id === splitId) {
        changed = true
        return { ...layout, percent: Math.max(minimumPercent, Math.min(maximumPercent, Math.round(percent))) }
      }
      return { ...layout, first: update(layout.first), second: update(layout.second) }
    }
    this.layout = update(this.layout)
    if (changed) this.publish()
    return changed
  }

  restore(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const saved = value as Partial<EditorGroupsSnapshot>
    const validTabs = new Set(this.documents.getSnapshot().tabs.map(({ id }) => id))
    if (saved.version !== 1 || !Array.isArray(saved.groups) || saved.groups.length < 1 || saved.groups.length > groupLimit) return false
    const groups = saved.groups.map((group) => normalizedGroup(group, validTabs))
    if (groups.some((group) => !group)) return false
    const map = new Map(groups.map((group) => [group!.id, group!]))
    if (map.size !== groups.length) return false
    const layout = normalizedLayout(saved.layout, new Set(map.keys()), new Set())
    if (!layout || groupIds(layout).length !== map.size || new Set(groupIds(layout)).size !== map.size) return false
    const activeGroupId = typeof saved.activeGroupId === 'string' && map.has(saved.activeGroupId)
      ? saved.activeGroupId : groupIds(layout)[0]
    this.groups = map
    this.layout = layout
    this.activeGroupId = activeGroupId
    this.sequence = Math.max(...[...map.keys()].map((id) => Number(id.slice(6))))
    const splitIds: number[] = []
    const collect = (node: EditorGroupLayout) => {
      if (node.kind === 'split') {
        splitIds.push(Number(node.id.slice(6)))
        collect(node.first)
        collect(node.second)
      }
    }
    collect(layout)
    this.splitSequence = Math.max(0, ...splitIds)
    this.syncDocuments()
    this.publish()
    return true
  }

  private syncDocuments() {
    if (this.syncing) return
    this.syncing = true
    try {
      const { tabs, activeId } = this.documents.getSnapshot()
      const valid = new Set(tabs.map(({ id }) => id))
      let changed = false
      for (const group of this.groups.values()) {
        const next = group.tabs.filter((id) => valid.has(id))
        if (next.length !== group.tabs.length) {
          group.tabs = next
          changed = true
        }
        if (group.activeId && !valid.has(group.activeId)) {
          group.activeId = group.tabs.at(-1) ?? null
          changed = true
        }
      }
      if (activeId && ![...this.groups.values()].some((group) => group.tabs.includes(activeId))) {
        const group = this.groups.get(this.activeGroupId)!
        group.tabs.push(activeId)
        group.activeId = activeId
        changed = true
      } else if (activeId) {
        const active = this.groups.get(this.activeGroupId)
        if (!active?.tabs.includes(activeId)) {
          const group = [...this.groups.values()].find((candidate) => candidate.tabs.includes(activeId))
          if (group) {
            this.activeGroupId = group.id
            group.activeId = activeId
            changed = true
          }
        }
      }
      if (changed) this.publish()
    } finally {
      this.syncing = false
    }
  }

  private removeEmptyGroup(groupId: string) {
    this.groups.delete(groupId)
    this.layout = removeGroup(this.layout, groupId) ?? { kind: 'group', groupId: this.groups.keys().next().value! }
  }

  private buildSnapshot(): EditorGroupsSnapshot {
    return { version: 1, layout: cloneLayout(this.layout),
      groups: groupIds(this.layout).map((id) => ({ ...this.groups.get(id)!, tabs: [...this.groups.get(id)!.tabs] })),
      activeGroupId: this.activeGroupId }
  }

  private publish() {
    this.snapshot = this.buildSnapshot()
    this.listeners.forEach((listener) => listener())
  }
}
