import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EditorGroups, EditorTabMru } from '../src/renderer/editor-groups'
import type { DocumentsSnapshot } from '../src/renderer/documents'

class FakeDocuments {
  private listeners = new Set<() => void>()
  private snapshot: DocumentsSnapshot

  constructor(ids: string[]) {
    this.snapshot = { tabs: ids.map((id) => ({ id, path: `/workspace/${id}.c`, name: `${id}.c`,
      dirty: false, conflict: false, error: null, epoch: 0 })), activeId: ids.at(-1) ?? null }
  }

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  select = (id: string) => { this.snapshot = { ...this.snapshot, activeId: id }; this.listeners.forEach((listener) => listener()) }
  open(id: string) {
    this.snapshot = { tabs: [...this.snapshot.tabs, { id, path: `/workspace/${id}.c`, name: `${id}.c`,
      dirty: false, conflict: false, error: null, epoch: 0 }], activeId: id }
    this.listeners.forEach((listener) => listener())
  }
  close(id: string) {
    const tabs = this.snapshot.tabs.filter((tab) => tab.id !== id)
    this.snapshot = { tabs, activeId: this.snapshot.activeId === id ? tabs.at(-1)?.id ?? null : this.snapshot.activeId }
    this.listeners.forEach((listener) => listener())
  }
}

test('nested horizontal and vertical groups share document identities and navigate spatially', () => {
  const documents = new FakeDocuments(['one', 'two'])
  const groups = new EditorGroups(documents)
  const right = groups.split('group-1', 'right')!
  assert.equal(right, 'group-2')
  const below = groups.split(right, 'down')!
  assert.equal(below, 'group-3')
  assert.equal(groups.getSnapshot().groups.length, 3)
  assert.deepEqual(groups.getSnapshot().groups.map(({ activeId }) => activeId), ['two', 'two', 'two'])
  assert.equal(groups.focus('up'), true)
  assert.equal(groups.getSnapshot().activeGroupId, right)
  assert.equal(groups.focus('left'), true)
  assert.equal(groups.getSnapshot().activeGroupId, 'group-1')
  assert.equal(groups.focus('up'), true)
  assert.equal(groups.getSnapshot().activeGroupId, right)
  groups.dispose()
})

test('moving tabs between groups does not close or duplicate the underlying document', () => {
  const documents = new FakeDocuments(['one', 'two', 'three'])
  const groups = new EditorGroups(documents)
  const right = groups.split('group-1', 'right')!
  assert.equal(groups.select('group-1', 'one'), true)
  assert.equal(groups.moveActive('right'), true)
  const snapshot = groups.getSnapshot()
  assert.deepEqual(snapshot.groups.find(({ id }) => id === 'group-1')?.tabs, ['two', 'three'])
  assert.deepEqual(snapshot.groups.find(({ id }) => id === right)?.tabs, ['three', 'one'])
  assert.equal(documents.getSnapshot().tabs.length, 3)
  assert.equal(documents.getSnapshot().activeId, 'one')
  assert.equal(groups.moveTab('three', right, 'group-1', 0), true)
  assert.deepEqual(groups.getSnapshot().groups.find(({ id }) => id === 'group-1')?.tabs, ['three', 'two'])
  assert.equal(documents.getSnapshot().tabs.length, 3)
  groups.dispose()
})

test('closing and emptying groups collapse layout without losing document references', () => {
  const documents = new FakeDocuments(['one', 'two'])
  const groups = new EditorGroups(documents)
  const right = groups.split('group-1', 'right')!
  const below = groups.split(right, 'down')!
  assert.equal(groups.moveTab('two', below, 'group-1'), true)
  assert.equal(groups.getSnapshot().groups.some(({ id }) => id === below), false)
  assert.equal(groups.close(right), true)
  assert.equal(groups.getSnapshot().groups.length, 1)
  assert.deepEqual(groups.getSnapshot().groups[0].tabs, ['one', 'two'])
  assert.equal(groups.close('group-1'), false)
  groups.dispose()
})

test('new and closed documents synchronize only the group references', () => {
  const documents = new FakeDocuments(['one'])
  const groups = new EditorGroups(documents)
  const right = groups.split('group-1', 'right')!
  documents.open('two')
  assert.deepEqual(groups.getSnapshot().groups.find(({ id }) => id === right)?.tabs, ['one', 'two'])
  documents.close('one')
  assert.ok(groups.getSnapshot().groups.every(({ tabs }) => !tabs.includes('one')))
  assert.equal(documents.getSnapshot().tabs.length, 1)
  groups.dispose()
})

test('restore rejects malformed layouts and safely drops unavailable tabs', () => {
  const documents = new FakeDocuments(['one', 'two'])
  const groups = new EditorGroups(documents)
  assert.equal(groups.restore({ version: 1, activeGroupId: 'group-1', groups: [{ id: 'group-1', tabs: ['one'], activeId: 'one' }],
    layout: { kind: 'split', id: 'split-1', orientation: 'horizontal', percent: 50,
      first: { kind: 'group', groupId: 'group-1' }, second: { kind: 'group', groupId: '../bad' } } }), false)
  assert.equal(groups.restore({ version: 1, activeGroupId: 'group-2', groups: [
    { id: 'group-1', tabs: ['one', 'missing'], activeId: 'missing' },
    { id: 'group-2', tabs: ['two'], activeId: 'two' },
  ], layout: { kind: 'split', id: 'split-1', orientation: 'vertical', percent: 99,
    first: { kind: 'group', groupId: 'group-1' }, second: { kind: 'group', groupId: 'group-2' } } }), true)
  const restored = groups.getSnapshot()
  assert.equal(restored.layout.kind, 'split')
  if (restored.layout.kind === 'split') assert.equal(restored.layout.percent, 80)
  assert.deepEqual(restored.groups[0], { id: 'group-1', tabs: ['one'], activeId: 'one' })
  assert.equal(restored.activeGroupId, 'group-2')
  groups.dispose()
})

test('group count and resize bounds remain explicit', () => {
  const documents = new FakeDocuments(['one'])
  const groups = new EditorGroups(documents)
  const two = groups.split('group-1', 'right')!
  const three = groups.split(two, 'down')!
  const four = groups.split(three, 'left')!
  assert.equal(groups.split(four, 'up'), null)
  const root = groups.getSnapshot().layout
  assert.equal(root.kind, 'split')
  if (root.kind === 'split') {
    assert.equal(groups.resize(root.id, 2), true)
    const resized = groups.getSnapshot().layout
    assert.equal(resized.kind, 'split')
    if (resized.kind === 'split') assert.equal(resized.percent, 20)
  }
  groups.dispose()
})

test('MRU identity includes the editor group and remains bounded', () => {
  const mru = new EditorTabMru(3)
  mru.record({ groupId: 'group-1', tabId: 'shared' })
  mru.record({ groupId: 'group-2', tabId: 'shared' })
  mru.record({ groupId: 'group-1', tabId: 'other' })
  assert.deepEqual(mru.snapshot(), [
    { groupId: 'group-1', tabId: 'other' },
    { groupId: 'group-2', tabId: 'shared' },
    { groupId: 'group-1', tabId: 'shared' },
  ])
  mru.record({ groupId: 'group-3', tabId: 'new' })
  assert.deepEqual(mru.snapshot(), [
    { groupId: 'group-3', tabId: 'new' },
    { groupId: 'group-1', tabId: 'other' },
    { groupId: 'group-2', tabId: 'shared' },
  ])
})

test('MRU move and prune remove closed group-tab identities without conflating documents', () => {
  const mru = new EditorTabMru()
  mru.record({ groupId: 'group-1', tabId: 'one' })
  mru.record({ groupId: 'group-1', tabId: 'two' })
  mru.record({ groupId: 'group-2', tabId: 'one' })
  assert.equal(mru.move({ groupId: 'group-1', tabId: 'two' }, { groupId: 'group-2', tabId: 'two' }), true)
  assert.deepEqual(mru.snapshot(), [
    { groupId: 'group-2', tabId: 'one' },
    { groupId: 'group-2', tabId: 'two' },
    { groupId: 'group-1', tabId: 'one' },
  ])
  assert.equal(mru.prune([
    { groupId: 'group-2', tabId: 'one' },
    { groupId: 'group-2', tabId: 'two' },
  ]), true)
  assert.deepEqual(mru.snapshot(), [
    { groupId: 'group-2', tabId: 'one' },
    { groupId: 'group-2', tabId: 'two' },
  ])
})

test('MRU traversal sessions are stable while activation history changes', () => {
  const mru = new EditorTabMru()
  const one = { groupId: 'group-1', tabId: 'one' }
  const two = { groupId: 'group-1', tabId: 'two' }
  const three = { groupId: 'group-2', tabId: 'three' }
  mru.record(one)
  mru.record(two)
  mru.record(three)
  const started = mru.begin(three)!
  const next = mru.step(started, 1)
  assert.deepEqual(mru.selected(next), two)
  mru.record({ groupId: 'group-3', tabId: 'later' })
  const again = mru.step(next, 1)
  assert.deepEqual(mru.selected(again), one)
  assert.deepEqual(mru.commit(again), one)
  assert.deepEqual(mru.snapshot()[0], one)
  assert.deepEqual(mru.cancel(started), three)
})

test('editor groups track MRU moves, close pruning, preview, commit, and cancel', () => {
  const documents = new FakeDocuments(['one', 'two', 'three'])
  const groups = new EditorGroups(documents)
  const right = groups.split('group-1', 'right')!
  assert.deepEqual(groups.getMruSnapshot().slice(0, 2), [
    { groupId: right, tabId: 'three' },
    { groupId: 'group-1', tabId: 'three' },
  ])
  assert.equal(groups.select('group-1', 'one'), true)
  assert.equal(groups.select('group-1', 'two'), true)
  const history = groups.getMruSnapshot()
  let traversal = groups.beginTabTraversal()!
  traversal = groups.stepTabTraversal(traversal, 1)
  assert.equal(groups.previewTabTraversal(traversal), true)
  assert.deepEqual(groups.getMruSnapshot(), history)
  traversal = groups.stepTabTraversal(traversal, 1)
  assert.equal(groups.commitTabTraversal(traversal), true)
  assert.deepEqual(groups.getMruSnapshot()[0], { groupId: right, tabId: 'three' })

  const cancelSession = groups.beginTabTraversal()!
  const cancelPreview = groups.stepTabTraversal(cancelSession, 1)
  assert.equal(groups.previewTabTraversal(cancelPreview), true)
  assert.equal(groups.cancelTabTraversal(cancelSession), true)
  assert.equal(groups.getSnapshot().activeGroupId, right)
  assert.equal(groups.getSnapshot().groups.find(({ id }) => id === right)?.activeId, 'three')

  assert.equal(groups.moveTab('one', 'group-1', right), true)
  assert.ok(!groups.getMruSnapshot().some((entry) => entry.groupId === 'group-1' && entry.tabId === 'one'))
  assert.equal(groups.close(right), true)
  assert.ok(groups.getMruSnapshot().every((entry) => entry.groupId === 'group-1'))
  groups.dispose()
})
