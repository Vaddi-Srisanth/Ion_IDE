import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { RecoveryStore } from '../src/main/recovery'
import { maxEditableTextBytes, maxTextCopyBytes } from '../src/shared/large-text'

async function setup(t: TestContext) {
  const profile = await mkdtemp(join(tmpdir(), 'ion-recovery-test-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const directory = join(profile, 'recovery')
  return { profile, directory, store: new RecoveryStore(directory) }
}

test('recovery survives a new store instance with private files and preserves Unicode, line endings, and BOM', async (t) => {
  const { profile, directory, store } = await setup(t)
  const name = 'Δraft source.c'
  const originalPath = join(profile, 'user files', name)
  const metadata = { id: randomUUID(), name, originalPath }
  const text = '\ufeff/* β and 😀 */\r\n\r\n'
  await mkdir(join(profile, 'user files'))
  await writeFile(originalPath, 'untouched source')
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(await readdir(profile), ['user files'])
  await store.write({ ...metadata, text })

  const restarted = new RecoveryStore(directory)
  assert.deepEqual(await restarted.list(), [metadata])
  assert.equal(await restarted.read(metadata.id), text)
  assert.equal(await readFile(originalPath, 'utf8'), 'untouched source')
  const files = await readdir(directory)
  assert.deepEqual(files, [metadata.id + '.draft'])
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
  }
})

test('recovery rejects malformed drafts and validates all IDs before deleting', async (t) => {
  const { store } = await setup(t)
  const valid = { id: randomUUID(), name: 'draft.c', text: '' }
  await store.write(valid)
  const invalid = [
    null,
    { ...valid, id: '../draft.c' },
    { ...valid, id: '00000000-0000-0000-0000-000000000000' },
    { ...valid, name: '../draft.c' },
    { ...valid, name: 'a'.repeat(1025) },
    { ...valid, originalPath: 'relative.c' },
    { ...valid, text: 123 },
    { ...valid, text: '😀'.repeat(maxTextCopyBytes / 4 + 1) },
    { ...valid, text: '\ud800' },
  ]
  for (const draft of invalid) await assert.rejects(store.write(draft))
  await assert.rejects(store.read('../../escape'), /Invalid recovery draft ID/)
  await assert.rejects(store.remove([valid.id, '../../escape']), /Invalid recovery draft ID/)
  await assert.rejects(store.remove([valid.id, ,]), /Invalid recovery draft ID/)
  await assert.rejects(store.remove(Array.from({ length: 65 }, () => valid.id)), /Invalid recovery draft IDs/)
  assert.equal(await store.read(valid.id), '')
})

test('recovery preserves a source edit that grows beyond the normal editing limit', async (t) => {
  const { directory, store } = await setup(t)
  const draft = { id: randomUUID(), name: 'large edit.txt' }
  const text = '😀'.repeat(maxEditableTextBytes / 4 + 1)
  await store.write({ ...draft, text })
  assert.equal(await new RecoveryStore(directory).read(draft.id), text)
})

test('listing skips malformed headers and cleans interrupted temporary writes without loading payloads', async (t) => {
  const { directory, store } = await setup(t)
  const intact = { id: randomUUID(), name: 'intact.txt' }
  const corrupt = { id: randomUUID(), name: 'corrupt.txt' }
  const truncated = { id: randomUUID(), name: 'truncated.txt' }
  const tempName = '.ion-recovery-' + randomUUID() + '.tmp'
  await store.write({ ...intact, text: 'original' })
  await store.write({ ...corrupt, text: 'x' })
  await store.write({ ...truncated, text: 'truncate me' })
  const corruptFile = join(directory, corrupt.id + '.draft')
  const bytes = await readFile(corruptFile)
  bytes[bytes.length - 1] = 0xff
  await writeFile(corruptFile, bytes)
  await truncate(join(directory, truncated.id + '.draft'), 10)
  await writeFile(join(directory, tempName), 'interrupted')

  const restarted = new RecoveryStore(directory)
  assert.deepEqual((await restarted.list()).sort((a, b) => a.id.localeCompare(b.id)),
    [intact, corrupt].sort((a, b) => a.id.localeCompare(b.id)))
  await assert.rejects(restarted.read(corrupt.id), /unavailable or damaged/)
  await assert.rejects(restarted.read(truncated.id), /unavailable or damaged/)
  assert.equal(await restarted.read(intact.id), 'original')
  assert.ok(!(await readdir(directory)).includes(tempName))
})

test('drain settles accepted checkpoints and removals before another store opens them', async (t) => {
  const { directory, store } = await setup(t)
  const draft = { id: randomUUID(), name: 'queued.txt' }
  const requests = [
    store.write({ ...draft, text: 'earlier' }),
    store.remove([draft.id]),
    store.write({ ...draft, text: 'latest unacknowledged request' }),
  ]
  await store.drain()
  assert.equal(await new RecoveryStore(directory).read(draft.id), 'latest unacknowledged request')
  await Promise.all(requests)
  assert.deepEqual(await readdir(directory), [draft.id + '.draft'])
})

test('a failed checkpoint does not poison draining or the next accepted write', async (t) => {
  const { directory, store } = await setup(t)
  const intact = { id: randomUUID(), name: 'intact.txt' }
  await store.write({ ...intact, text: 'previously acknowledged' })
  const blocked = { id: randomUUID(), name: 'blocked.txt' }
  await mkdir(join(directory, blocked.id + '.draft'))
  const failed = assert.rejects(store.write({ ...blocked, text: 'must not publish' }), /Invalid recovery draft destination/)
  const next = store.write({ ...intact, text: 'later successful checkpoint' })
  await store.drain()
  await Promise.all([failed, next])
  assert.equal(await new RecoveryStore(directory).read(intact.id), 'later successful checkpoint')
  assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.tmp')))
})

test('queued writes and removals run in request order and leave no temporary files', async (t) => {
  const { directory, store } = await setup(t)
  const draft = { id: randomUUID(), name: 'draft.txt' }
  await Promise.all([
    store.write({ ...draft, text: 'first' }),
    store.remove([draft.id]),
    store.write({ ...draft, text: 'second' }),
    store.write({ ...draft, text: 'final' }),
  ])
  assert.equal(await store.read(draft.id), 'final')
  assert.deepEqual(await readdir(directory), [draft.id + '.draft'])
  await Promise.all([store.write({ ...draft, text: 'discarded' }), store.remove([draft.id])])
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(await readdir(directory), [])
})

test('recovery caps the number of drafts and still permits updates at capacity', async (t) => {
  const { store } = await setup(t)
  const drafts = Array.from({ length: 65 }, () => ({ id: randomUUID(), name: 'draft.txt', text: '' }))
  for (const draft of drafts.slice(0, 64)) await store.write(draft)
  await assert.rejects(store.write(drafts[64]), /64-draft limit/)
  await store.write({ ...drafts[0], text: 'updated' })
  assert.equal(await store.read(drafts[0].id), 'updated')
  await store.remove([drafts[1].id])
  await store.write(drafts[64])
  assert.equal((await store.list()).length, 64)
})

test('recovery refuses a symlink as its storage directory', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, profile, store } = await setup(t)
  const outside = join(profile, 'outside')
  await mkdir(outside)
  await symlink(outside, directory)
  await assert.rejects(store.list(), /must be a directory/)
  await assert.rejects(store.write({ id: randomUUID(), name: 'draft.txt', text: 'secret' }), /must be a directory/)
  assert.deepEqual(await readdir(outside), [])
})
