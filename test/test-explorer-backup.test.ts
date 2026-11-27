import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { readArchive } from '../src/main/backup/archive'
import { sha256, type BackupManifest } from '../src/main/backup/format'
import { BackupService } from '../src/main/backup/service'
import { finishPendingRestore, pendingName } from '../src/main/backup/transaction'
import { WorkspaceFiles } from '../src/main/files'
import { PreferenceStore } from '../src/main/preferences'
import { selectedTestIds, testId, testLimits, type StoredTests } from '../src/main/test-explorer/model'
import { TestRepository } from '../src/main/test-explorer/repository'
import { zipFixture } from './fixtures/backup-zip'

function record(root: string, message: string, historyCount: number): StoredTests {
  const fileId = testId('file:test_math.py'), caseId = testId('test_math.py::test_add')
  return {
    schema: 1,
    snapshot: {
      root, revision: randomUUID(), adapter: 'pytest', discoveredAt: 1_700_000_000_000,
      nodes: [
        { id: fileId, parentId: null, kind: 'file', label: 'test_math.py', location: { path: 'test_math.py', line: 1 } },
        { id: caseId, parentId: fileId, kind: 'test', label: 'test_add', location: { path: 'test_math.py', line: 2 } },
      ],
      history: Array.from({ length: historyCount }, (_, index) => ({
        id: randomUUID(), checkedAt: 1_700_000_000_000 + index, durationMs: 20 + index,
        status: 'completed' as const, selectedIds: [caseId], stale: false,
        cases: [{ id: caseId, outcome: index % 2 ? 'passed' as const : 'failed' as const,
          durationMs: 10 + index, message, output: 'Synthetic historical fixture; no test process was run.',
          location: { path: 'test_math.py', line: 2 } }],
      })),
      stale: false,
    },
    selectors: { [caseId]: 'test_math.py::test_add' },
    sources: { 'test_math.py': 'snapshot-revision' },
  }
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-test-history-backup-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), target = join(root, 'target'), workspace = join(root, 'Project Ω')
  for (const directory of [source, target, workspace]) await mkdir(directory)
  const sourceText = 'def test_add():\n    assert 1 + 1 == 2\n'
  await writeFile(join(workspace, 'test_math.py'), sourceText)
  const original = await new TestRepository(join(source, 'test-explorer-v1')).save(record(workspace, 'archived result', testLimits.history), null)
  const current = await new TestRepository(join(target, 'test-explorer-v1')).save(record(workspace, 'current local result', 1), null)
  const currentPath = join(target, 'test-explorer-v1', testId(workspace) + '.json')
  const currentBytes = await readFile(currentPath)
  await new PreferenceStore(join(source, 'preferences.json')).updateSettings({ fontSize: 19 })
  await new PreferenceStore(join(target, 'preferences.json')).updateSettings({ fontSize: 15 })
  const preferencesBefore = await readFile(join(target, 'preferences.json'))
  for (const name of ['run-trust-v1.json', 'planning-provider-v1.json']) {
    await writeFile(join(source, name), 'ARCHIVED-SECRET-OR-APPROVAL')
    await writeFile(join(target, name), 'KEEP-CURRENT-SECRET-OR-APPROVAL')
  }
  const backup = new BackupService({ profile: source, appVersion: '0.9.8' })
  const selection = await backup.review({ categories: ['tests', 'preferences'], folders: [] })
  assert.ok(selection.categories.some(category => category.id === 'tests' && category.present))
  assert.ok(!selection.entries.some(entry => /trust|provider/.test(entry.path)))
  const archive = join(root, 'test-history.ionbackup')
  await backup.create(selection.token, archive)
  await backup.cancel()
  return { root, source, target, workspace, sourceText, original, current, currentPath, currentBytes, preferencesBefore, archive }
}

async function assertClean(profile: string) {
  const files = await readdir(profile)
  assert.ok(!files.includes(pendingName))
  assert.ok(!files.some(name => name.startsWith('.ion-backup-stage-')))
  // Completed transactions deliberately retain previous/unapplied versions for
  // manual recovery. Only a pending marker or active snapshot staging is a leak.
}

test('Test Explorer backup restores bounded historical results through normal stores without runnable discovery or grants', async t => {
  const f = await fixture(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' })
  const access = new WorkspaceFiles()
  const review = await service.openRestore(f.archive)
  assert.ok(review.categories.some(category => category.id === 'tests' && category.conflict))
  assert.ok(review.warnings.some(warning => /historical and stale/.test(warning)))
  const prepared = await service.prepareRestore(review.token, { replace: ['tests'], mappings: [], copyFolders: [] })
  await service.finalize(prepared.token)
  assert.equal(service.restartRequired, true)
  assert.deepEqual(await readFile(f.currentPath), f.currentBytes, 'Arming restore must not replace a live store')
  assert.deepEqual(await readFile(join(f.target, 'preferences.json')), f.preferencesBefore)

  const rollback = join(f.root, 'rollback-review')
  await mkdir(rollback)
  const rollbackManifest = await readArchive(prepared.rollback, rollback)
  assert.ok(rollbackManifest.entries.some(entry => entry.category === 'tests'))
  assert.deepEqual(await readFile(join(rollback, 'profile', 'test-explorer-v1', testId(f.workspace) + '.json')), f.currentBytes,
    'Verified pre-restore archive must preserve the complete original local snapshot')

  // Startup publishes first; fresh store instances then read the restored profile.
  assert.equal(await finishPendingRestore(f.target), 'applied')
  const restored = await new TestRepository(join(f.target, 'test-explorer-v1')).read(f.workspace)
  assert.ok(restored)
  assert.equal(restored.snapshot.root, f.workspace, 'The root remains inert association metadata')
  assert.notEqual(restored.snapshot.revision, f.original.snapshot.revision)
  assert.equal(restored.snapshot.stale, true)
  assert.equal(restored.snapshot.history.length, testLimits.history)
  assert.deepEqual(restored.snapshot.history, f.original.snapshot.history.map(run => ({ ...run, stale: true, restored: true })))
  assert.deepEqual(restored.snapshot.nodes, [])
  assert.deepEqual(restored.selectors, {})
  assert.deepEqual(restored.sources, {})
  assert.throws(() => selectedTestIds(restored, f.original.snapshot.history[0].selectedIds), /Discover again/)
  assert.equal(Object.hasOwn(restored, 'approved'), false)
  assert.equal(Object.hasOwn(restored.snapshot, 'approved'), false)
  assert.deepEqual(access.rootPaths, [])
  assert.equal(access.authorizes(f.workspace), false)
  await assert.rejects(access.inspect(f.workspace, 'folder'), /before accessing/)
  for (const name of ['run-trust-v1.json', 'planning-provider-v1.json']) {
    assert.equal(await readFile(join(f.target, name), 'utf8'), 'KEEP-CURRENT-SECRET-OR-APPROVAL')
  }
  assert.deepEqual(await readFile(join(f.target, 'preferences.json')), f.preferencesBefore)
  assert.equal(await readFile(join(f.workspace, 'test_math.py'), 'utf8'), f.sourceText)
  assert.deepEqual(await new TestRepository(join(f.target, 'test-explorer-v1')).read(f.workspace), restored,
    'A later repository instance must retain history without reactivating discovery')
  assert.equal(await finishPendingRestore(f.target), 'none')
  await assertClean(f.target)
})

test('Test Explorer restore publication failure rolls back the populated local snapshot byte-for-byte', async t => {
  const f = await fixture(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' })
  const review = await service.openRestore(f.archive)
  const prepared = await service.prepareRestore(review.token, { replace: ['tests'], mappings: [], copyFolders: [] })
  await service.finalize(prepared.token)
  let interrupted = false
  assert.equal(await finishPendingRestore(f.target, async (stage, category) => {
    if (stage === 'published' && category === 'tests') {
      interrupted = true
      throw Object.assign(new Error('Injected publication failure'), { code: 'EPERM' })
    }
  }), 'rolled-back')
  assert.equal(interrupted, true, 'The test must reach publication before injecting its failure')
  assert.deepEqual(await readFile(f.currentPath), f.currentBytes)
  assert.deepEqual(await new TestRepository(join(f.target, 'test-explorer-v1')).read(f.workspace), f.current)
  assert.deepEqual(await readFile(join(f.target, 'preferences.json')), f.preferencesBefore)
  assert.equal(await finishPendingRestore(f.target), 'none')
  await assertClean(f.target)
})

test('valid archive checksums cannot authorize malformed or oversized Test Explorer history', async t => {
  const f = await fixture(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' })
  const malformed: unknown[] = [
    { ...f.original, approved: ['pytest'] },
    { ...f.original, snapshot: { ...f.original.snapshot, history: [...f.original.snapshot.history, f.original.snapshot.history[0]] } },
    { ...f.original, sources: { '../outside.py': 'untrusted' } },
    { ...f.original, selectors: { ...f.original.selectors, [testId('missing case')]: 'test_math.py::unknown' } },
  ]
  for (const [index, record] of malformed.entries()) {
    const data = Buffer.from(JSON.stringify(record))
    const entry = { path: 'profile/test-explorer-v1/' + testId(f.workspace) + '.json', category: 'tests' as const,
      bytes: data.length, sha256: sha256(data) }
    const manifest: BackupManifest = { format: 'ion-backup', version: 1, id: randomUUID(), appVersion: '0.9.8',
      createdAt: new Date().toISOString(), categories: ['tests'], schemas: { tests: 1 }, entries: [entry],
      folders: [], projects: [], exclusions: [], exclusionsOmitted: 0 }
    const archive = join(f.root, 'invalid-history-' + index + '.ionbackup')
    await writeFile(archive, zipFixture([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: entry.path, data }]))
    await assert.rejects(service.openRestore(archive), /test|Test/)
    assert.deepEqual(await readFile(f.currentPath), f.currentBytes)
    assert.deepEqual(await readFile(join(f.target, 'preferences.json')), f.preferencesBefore)
    await assertClean(f.target)
  }
})
