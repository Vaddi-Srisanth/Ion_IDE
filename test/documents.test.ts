import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Documents } from '../src/renderer/documents'
import { defaultSettings, type IonBridge } from '../src/shared/contracts'

const file = { kind: 'file', name: 'main.c', path: '/workspace/main.c' } as const

function setup(bridge: Partial<IonBridge>, autoSave = false) {
  const messages: string[] = []
  const documents = new Documents({
    readFile: async () => ({ text: 'original', revision: 'r1' }),
    recovery: { write: async () => {}, remove: async () => {} },
    ...bridge,
  } as IonBridge, { ...defaultSettings, autoSave, autoSaveDelay: 20 },
  (message) => messages.push(message), () => {})
  let value: string | undefined
  documents.attachModels({ getText: () => value, drop: () => { value = undefined } })
  return { documents, messages, setValue: (text: string) => { value = text } }
}

test('a prefilled draft is recoverable before editing and saves under its suggested name', { timeout: 2000 }, async () => {
  const starter = 'public class Main {\n    \n}\n'
  const saved = { kind: 'file', name: 'Main.java', path: '/workspace/Main.java', revision: 'r1' } as const
  let checkpoint!: () => void
  const checkpointed = new Promise<void>((resolve) => { checkpoint = resolve })
  const copies: { name: string; text: string; originalPath?: string }[] = []
  const saves: Array<{ name: string; text: string }> = []
  const { documents } = setup({
    readFile: async () => assert.fail('An unsaved starter has no disk source'),
    recovery: {
      list: async () => [],
      read: async () => assert.fail('An unsaved starter already has its own text'),
      write: async ({ name, text, originalPath }) => { copies.push({ name, text, originalPath }); checkpoint() },
      remove: async () => {},
    },
    saveFileAs: async (name, text) => { saves.push({ name, text }); return saved },
  }, true)

  const cursor = { line: 2, column: 5 }
  const id = documents.open(undefined, { name: 'Main.java', text: starter, cursor })!
  const [tab] = documents.getSnapshot().tabs
  assert.equal(tab.name, 'Main.java')
  assert.equal(tab.path, null)
  assert.equal(tab.dirty, true)
  assert.equal(await documents.loadText(id), starter)
  assert.deepEqual(documents.takeInitialCursor(id), cursor)
  assert.equal(documents.takeInitialCursor(id), undefined)
  await checkpointed
  assert.deepEqual(copies, [{ name: 'Main.java', text: starter, originalPath: undefined }])
  assert.deepEqual(saves, [])
  assert.equal(await documents.save(id), true)
  await documents.finishWindowClose(false)
  assert.deepEqual(saves, [{ name: 'Main.java', text: starter }])
  assert.equal(documents.getSnapshot().tabs[0].dirty, false)
})

test('unnamed drafts retain the generated sequence and disk files read their own contents', async () => {
  const { documents } = setup({})
  const first = documents.open()!
  const second = documents.open(undefined, { text: '#include <stdio.h>\n' })!
  const named = documents.open(file, { text: 'different', name: 'other.c' })!
  const [blank, prefilled, fromDisk] = documents.getSnapshot().tabs
  assert.equal(blank.name, 'Untitled-1.c')
  assert.equal(blank.dirty, false)
  assert.equal(await documents.loadText(first), '')
  assert.equal(prefilled.name, 'Untitled-2.c')
  assert.equal(prefilled.dirty, true)
  assert.equal(await documents.loadText(second), '#include <stdio.h>\n')
  assert.equal(fromDisk.name, file.name)
  assert.equal(fromDisk.dirty, false)
  assert.equal(await documents.loadText(named), 'original')
  await documents.discard(second)
})

test('a save completed after more editing leaves the newer edits dirty', async () => {
  let finishFirst!: (result: { revision: string; contentHash: string }) => void
  const firstSave = new Promise<{ revision: string; contentHash: string }>((resolve) => { finishFirst = resolve })
  const writes: Array<{ text: string; revision: string; baseHash?: string }> = []
  const { documents, setValue } = setup({
    readFile: async () => ({ text: 'original', revision: 'r1', contentHash: 'h1' }),
    saveFile: async (_path, text, revision, baseHash) => {
      writes.push({ text, revision, baseHash })
      return writes.length === 1 ? firstSave : { revision: 'r3', contentHash: 'h3' }
    },
  })
  const id = documents.open(file)!
  await documents.loadText(id)
  setValue('first edit')
  documents.changed(id)
  const saving = documents.save(id)
  await Promise.resolve()
  setValue('later edit')
  documents.changed(id)
  finishFirst({ revision: 'r2', contentHash: 'h2' })
  assert.equal(await saving, true)
  assert.equal(documents.getSnapshot().tabs[0].dirty, true)
  assert.equal(await documents.save(id), true)
  assert.deepEqual(writes, [
    { text: 'first edit', revision: 'r1', baseHash: 'h1' },
    { text: 'later edit', revision: 'r2', baseHash: 'h2' },
  ])
  assert.equal(documents.getSnapshot().tabs[0].dirty, false)
})

test('autosave debounces edits and preserves the buffer when the disk revision changes', async () => {
  const writes: string[] = []
  let attempted!: () => void
  const autoSaveAttempt = new Promise<void>((resolve) => { attempted = resolve })
  const { documents, messages, setValue } = setup({
    saveFile: async (_path, text) => {
      writes.push(text)
      attempted()
      throw new Error('FILE_CHANGED')
    },
  }, true)
  const id = documents.open(file)!
  await documents.loadText(id)
  setValue('first edit')
  documents.changed(id)
  setValue('final edit')
  documents.changed(id)
  await Promise.race([autoSaveAttempt, delay(2000, undefined, { ref: false }).then(() => {
    throw new Error('Autosave did not run')
  })])
  await documents.settle([id])
  assert.deepEqual(writes, ['final edit'])
  const [tab] = documents.getSnapshot().tabs
  assert.equal(tab.dirty, true)
  assert.equal(tab.conflict, true)
  assert.equal(await documents.loadText(id), 'final edit')
  assert.ok(messages.some((message) => message.includes('changed on disk')))
})

test('saving an evicted model releases staged text so reopening reads the disk revision', async () => {
  let content = 'initial'
  const { documents } = setup({
    readFile: async () => ({ text: content, revision: content }),
    saveFile: async (_path, text) => {
      content = text
      return { revision: text }
    },
  })
  const id = documents.open(file)!
  await documents.loadText(id)
  documents.changed(id)
  documents.releaseModel(id, () => 'saved draft')
  assert.equal(await documents.save(id), true)
  assert.equal(content, 'saved draft')
  content = 'new external content'
  assert.equal(await documents.loadText(id), content)
})

test('checkpointing keeps an evicted dirty buffer and waits for the last write before discarding', { timeout: 2000 }, async () => {
  const calls: string[] = []
  let started!: () => void
  let finish!: () => void
  const startedWrite = new Promise<void>((resolve) => { started = resolve })
  const writing = new Promise<void>((resolve) => { finish = resolve })
  const { documents } = setup({
    recovery: {
      list: async () => [],
      read: async () => '',
      write: async (draft) => {
        calls.push(draft.text)
        started()
        await writing
      },
      remove: async () => { calls.push('removed') },
    },
  })
  const id = documents.open(file)!
  documents.changed(id)
  documents.releaseModel(id, () => 'first evicted version')
  documents.changed(id)
  documents.releaseModel(id, () => 'latest evicted version')
  await startedWrite
  const discarding = documents.discard(id)
  await Promise.resolve()
  assert.deepEqual(calls, ['latest evicted version'])
  finish()
  await discarding
  assert.deepEqual(calls, ['latest evicted version', 'removed'])
  assert.equal(documents.getSnapshot().tabs.length, 0)
})

test('restored tabs stay detached and fetch their contents only when needed', async () => {
  const reads: string[] = []
  const removed: string[] = []
  const { documents } = setup({
    readFile: async () => assert.fail('Recovery must not read the original file'),
    saveFileAs: async (name, text) => {
      assert.equal(name, file.name)
      assert.equal(text, 'local draft')
      return { ...file, path: '/workspace/copy.c', revision: 'saved' }
    },
    recovery: {
      list: async () => [],
      read: async (id) => { reads.push(id); return 'local draft' },
      write: async () => {},
      remove: async (ids) => { removed.push(...ids) },
    },
  })
  assert.deepEqual(documents.restoreDrafts([
    { id: 'named', name: file.name, originalPath: file.path },
    { id: 'unnamed', name: 'Untitled-1.c' },
  ]), ['named', 'unnamed'])
  assert.deepEqual(reads, [])
  const [named, unnamed] = documents.getSnapshot().tabs
  assert.equal(named.path, null)
  assert.equal(named.recoveredFrom, file.path)
  assert.equal(named.dirty, true)
  assert.equal(await documents.save(named.id), true)
  await documents.finishWindowClose(false)
  assert.deepEqual(reads, ['named'])
  assert.deepEqual(removed, ['named'])
  await documents.discard(unnamed.id)
  assert.deepEqual(removed, ['named', 'unnamed'])
})
