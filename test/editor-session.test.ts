import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EditorSessionStore } from '../src/main/editor-session'
import { WorkspaceFiles } from '../src/main/files'
import { RecoveryStore } from '../src/main/recovery'
import type { EditorSessionSnapshot } from '../src/shared/editor-session'

test('reopening a session grants only previously scoped paths, skips changed links, and preserves detached drafts', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-session-test-')))
  try {
    const root = join(directory, 'project')
    const first = join(root, 'first.txt')
    const changed = join(root, 'changed.txt')
    const draftPath = join(root, 'draft.txt')
    const outside = join(directory, 'private.txt')
    const sessionPath = join(directory, 'editor-session.json')
    await mkdir(root)
    await Promise.all([first, changed, draftPath, outside].map((path) => writeFile(path, 'original')))
    const scope = new WorkspaceFiles()
    await scope.grant(root, 'folder')
    const recovery = new RecoveryStore(join(directory, 'recovery'))
    const draft = { id: randomUUID(), name: 'draft.txt', originalPath: draftPath, text: 'unsaved content' }
    await recovery.write(draft)
    const view = { selections: [{
      selectionStartLineNumber: 2, selectionStartColumn: 4, positionLineNumber: 2, positionColumn: 9,
    }], scrollTop: 50, scrollLeft: 10 }
    const snapshot: EditorSessionSnapshot = { rootPath: root, activeIndex: 2, tabs: [
      { path: first, name: 'first.txt', view },
      { path: changed, name: 'changed.txt' },
      { path: draftPath, name: 'draft.txt', draftId: draft.id },
      { path: outside, name: 'private.txt' },
    ] }
    const store = new EditorSessionStore(sessionPath)
    assert.equal(await store.available(), false)
    await assert.rejects(async () => store.save({ ...snapshot, rootPath: directory }, scope), /folder is no longer open/)
    await store.save(snapshot, scope)
    const saved = await readFile(sessionPath, 'utf8')
    assert.equal(saved.includes(outside), false)
    assert.equal(saved.includes(draft.text), false)
    await assert.rejects(async () => store.save({ ...snapshot, activeIndex: 999 }, scope), /Invalid editor session/)
    assert.equal(await readFile(sessionPath, 'utf8'), saved)
    await rm(changed)
    await symlink(outside, changed)
    await writeFile(draftPath, 'new disk content')

    const reopened = new WorkspaceFiles()
    const reloaded = new EditorSessionStore(sessionPath)
    assert.equal(await reloaded.available(), true)
    const restored = await reloaded.resume(reopened, recovery, () => true)
    assert.equal(restored.root?.path, root)
    assert.equal(restored.activeIndex, 2)
    assert.equal(restored.skipped, 1)
    assert.deepEqual(restored.tabs.map(({ index }) => index), [0, 2])
    assert.deepEqual(restored.tabs[0].view, view)
    assert.equal(restored.tabs[1].entry, undefined)
    assert.equal(restored.tabs[1].draft?.id, draft.id)
    assert.equal(await recovery.read(draft.id), draft.text)
    assert.equal((await reopened.read(draftPath)).text, 'new disk content')
    await assert.rejects(reopened.read(changed))
    await assert.rejects(reopened.read(outside))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
