import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { zipFixture } from './fixtures/backup-zip'
import { LearningPackStore } from '../src/main/learning/catalog-store'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import { BackupService } from '../src/main/backup/service'
import { portablePath, parseManifest, sha256, limits, type BackupManifest } from '../src/main/backup/format'
import { readArchive, writeArchive } from '../src/main/backup/archive'
import { finishPendingRestore, pendingName, treeHash } from '../src/main/backup/transaction'
import { profileFiles } from '../src/main/backup/profile'
import { backupCategories } from '../src/shared/backup'
import { PreferenceStore } from '../src/main/preferences'
import { RecoveryStore } from '../src/main/recovery'
import { LearningService } from '../src/main/learning'
import { ThemeStore } from '../src/main/themes'
import { PracticeStore } from '../src/main/practice/store'
import { runPracticeBatch } from '../src/main/practice/execute-samples'
import { ProjectRepository } from '../src/main/projects/repository'
import { unavailableTest } from '../src/main/projects/evidence'
import { EditorSessionStore } from '../src/main/editor-session'
import { exportLocalProfile } from '../src/main/profile-export'
import { planningCases } from './fixtures/project-plans'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-backup-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), target = join(root, 'target'), workspace = join(root, 'Working files Ω'), relocated = join(root, 'Relocated')
  for (const path of [source, target, workspace, relocated]) await mkdir(path)
  const prefs = new PreferenceStore(join(source, 'preferences.json'))
  await prefs.updateSettings({ fontSize: 19, smartLanguages: ['java'] })
  await prefs.remember({ path: workspace, name: 'Working files Ω', kind: 'folder' })
  const recovery = new RecoveryStore(join(source, 'recovery')), id = randomUUID()
  await recovery.write({ id, name: 'notes.txt', text: 'unsaved original', originalPath: join(workspace, 'notes.txt') })
  await writeFile(join(source, 'editor-session.json'), JSON.stringify({ version: 1, rootPath: workspace, activeIndex: 0, tabs: [{ path: null, name: 'notes.txt', draftId: id }, { path: join(workspace, 'main.c'), name: 'main.c' }] }))
  await new LearningService(join(source, 'learning.json')).recordTopic('arrays', 'selected')
  const themes = new ThemeStore(source, resolve('src/main/themes/palettes'))
  const theme = await themes.create(JSON.parse(await readFile(resolve('src/main/themes/palettes/dark.json'), 'utf8')))
  const packFile = join(root, 'community-pack.json')
  await writeFile(packFile, JSON.stringify({ schema: 1, id: 'my-notes', name: 'My offline notes', summary: 'My study material.', version: 1,
    lessons: [{ id: 'branches', title: 'Branches', section: 'Syntax', explanation: 'A branch selects code.', example: 'if (ready) start();', api: [{ name: 'if', description: 'Choose a branch.' }], practice: 'Write another condition.' }] }))
  const catalog = join(root, 'catalog'); await mkdir(catalog); await writeFile(join(catalog, 'index.json'), '[]')
  await new LearningPackStore(source, catalog, '0.9.8').importFile(packFile)
  const project = new ProjectRepository(join(source, 'projects-v1')), plan = planningCases[0].reviewed
  const created = await project.save(workspace, plan, null), approved = await project.approve(workspace, plan.tests[0], created.revision)
  await project.evidence(workspace, unavailableTest(plan.tests[0], 'Historical runner unavailable.'), approved.revision)
  const practice = new PracticeStore(join(source, 'practice'))
  const problem = await practice.save({ title: 'Offline practice', statement: 'Print 2.', sourceUrl: '', difficulty: 'Easy', topic: 'Basics', completion: 'In progress', notes: 'My notes', samples: [{ id: randomUUID(), label: 'Sample', input: '', expectedOutput: '2' }] })
  const attempt = await practice.createAttempt(problem.id, 'Edited attempt'), path = await practice.openAttempt(problem.id, attempt.attempt.id)
  await writeFile(path, 'int main(void) { return 2; }\n')
  await practice.runSamples(problem.id, attempt.attempt.id, async () => [{ status: 'success', compiler: '/test/fixture', compileOutput: '', programOutput: '2', programStdout: '2', programStderr: '', exitCode: 0, durationMs: 1, message: 'Synthetic persisted report fixture, not runtime evidence.' }])
  for (const name of ['planning-provider-v1.json', 'run-trust-v1.json', 'Login Data']) await writeFile(join(source, name), 'DO-NOT-EXPORT')
  await writeFile(join(source, 'practice', problem.id, 'not-referenced.secret'), 'DO-NOT-EXPORT')
  await writeFile(join(workspace, 'main.c'), 'int main(void) { return 0; }\n')
  await writeFile(join(workspace, '.env'), 'SECRET=hidden'); await mkdir(join(workspace, 'node_modules')); await writeFile(join(workspace, 'node_modules', 'unused.js'), 'excluded')
  const options = { profile: source, appVersion: '0.9.8' }
  return { root, source, target, workspace, relocated, prefs, id, theme, problem, attempt, options }
}
async function archive(t: TestContext) {
  const f = await fixture(t), service = new BackupService(f.options), folder = await service.addFolder(f.workspace)
  const review = await service.review({ categories: [...backupCategories], folders: [{ ...folder, mode: 'copy' }] })
  const file = join(f.root, 'complete.ionbackup'); await service.create(review.token, file)
  return { ...f, file, folder }
}

// Windows reports forced termination as an exit code, not necessarily a signal.
// A nonzero code alone cannot distinguish our deliberate kill from a restore error.
function verifyInterruption(status: { code: number | null; signal: string | null }, receipt: unknown, pid: number | undefined, boundary: string, platform: string) {
  assert.deepEqual(receipt, { pid, boundary }, 'Child did not reach the requested interruption boundary')
  assert.ok(status.signal === 'SIGKILL' || (platform === 'win32' && status.signal === null && status.code === 1), 'Child did not report the expected forced termination')
}

async function interruptRestore(profile: string, boundary: string) {
  const receiptPath = join(profile, 'test-interruption.json')
  await new Promise<void>((yes, no) => {
    const child = spawn(process.execPath, [__filename], { env: { ...process.env, ION_RESTORE_CRASH_CHILD: profile, ION_RESTORE_CRASH_BOUNDARY: boundary }, stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', d => { errors = (errors + String(d)).slice(0, 4096) })
    child.once('error', no)
    child.once('close', (code, signal) => {
      void (async () => {
        assert.equal(errors, '', 'Restore child reported an error: ' + errors)
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown
        verifyInterruption({ code, signal }, receipt, child.pid, boundary, process.platform)
      })().then(yes, no)
    })
  })
  await rm(receiptPath)
}

if (process.env.ION_RESTORE_CRASH_CHILD) {
  void finishPendingRestore(process.env.ION_RESTORE_CRASH_CHILD, async stage => {
    if (process.env.ION_RESTORE_CRASH_BOUNDARY === 'rollback-after-publication' && stage === 'published') throw new Error('Injected publication failure')
    if ((process.env.ION_RESTORE_CRASH_BOUNDARY === 'rollback-after-publication' && stage === 'rolled-back') || stage === process.env.ION_RESTORE_CRASH_BOUNDARY) {
      await writeFile(join(process.env.ION_RESTORE_CRASH_CHILD!, 'test-interruption.json'), JSON.stringify({ pid: process.pid, boundary: process.env.ION_RESTORE_CRASH_BOUNDARY }), { flag: 'wx', mode: 0o600 })
      process.kill(process.pid, 'SIGKILL')
    }
  }).then(() => process.exit(0), error => { process.stderr.write(String(error)); process.exit(1) })
} else {
  test('interruption fixture accepts Windows exit 1 only with the exact child boundary receipt', async () => {
    // Status control only: this is not a substitute for native Windows execution.
    const status = await new Promise<{ code: number | null; signal: string | null }>((yes, no) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' })
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal }))
    })
    assert.deepEqual(status, { code: 1, signal: null })
    verifyInterruption(status, { pid: 123, boundary: 'published' }, 123, 'published', 'win32')
    for (const receipt of [undefined, { pid: 124, boundary: 'published' }, { pid: 123, boundary: 'journal' }]) {
      assert.throws(() => verifyInterruption(status, receipt, 123, 'published', 'win32'), /requested interruption boundary/)
    }
    assert.throws(() => verifyInterruption(status, { pid: 123, boundary: 'published' }, 123, 'published', 'darwin'), /forced termination/)
    assert.throws(() => verifyInterruption({ code: 0, signal: null }, { pid: 123, boundary: 'published' }, 123, 'published', 'win32'), /forced termination/)
    assert.throws(() => verifyInterruption({ code: 2, signal: null }, { pid: 123, boundary: 'published' }, 123, 'published', 'win32'), /forced termination/)
  })
  test('full archive round-trip restores normal stores, detached drafts and stale evidence, excluding credentials', async t => {
    const f = await archive(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' })
    const local = new RecoveryStore(join(f.target, 'recovery'))
    // Same ID deliberately collides with the archived draft.
    await local.write({ id: f.id, name: 'local.txt', text: 'keep current' })
    const review = await service.openRestore(f.file), mapping = await service.addFolder(f.relocated)
    assert.ok(review.warnings.some(w => w.includes('stale')))
    assert.ok(!review.entries.some(e => /provider|trust|Login|not-referenced|node_modules|\.env/.test(e.path)))
    const ready = await service.prepareRestore(review.token, { replace: [...backupCategories], mappings: [{ id: review.projects[0].id, folderId: mapping.id }], copyFolders: [f.folder.id] }, f.root)
    await service.finalize(ready.token)
    assert.equal(await finishPendingRestore(f.target), 'applied')
    assert.equal((await new PreferenceStore(join(f.target, 'preferences.json')).get()).settings.fontSize, 19)
    assert.deepEqual((await new PreferenceStore(join(f.target, 'preferences.json')).get()).settings.smartLanguages, [])
    assert.equal((await new ThemeStore(f.target, resolve('src/main/themes/palettes')).load(f.theme.id)).id, f.theme.id)
    assert.deepEqual(await new LearningService(join(f.target, 'learning.json')).getHistory(), await new LearningService(join(f.source, 'learning.json')).getHistory())
    const practice = new PracticeStore(join(f.target, 'practice')), restoredProblem = await practice.get(f.problem.id)
    assert.equal(restoredProblem.notes, 'My notes')
    assert.equal(restoredProblem.attempts[0].lastRun?.current, false)
    assert.equal(restoredProblem.attempts[0].lastRun?.results[0].status, 'passed')
    assert.equal((await new LearningPackStore(f.target, '', '0.9.8').getLesson('my-notes', 'branches')).title, 'Branches')
    assert.match(await readFile(await practice.openAttempt(f.problem.id, f.attempt.attempt.id), 'utf8'), /return 2/)
    const drafts = await local.list(); assert.equal(drafts.length, 2); assert.equal(await local.read(f.id), 'keep current')
    const imported = drafts.find(d => d.id !== f.id)!; assert.equal(imported.originalPath, undefined); assert.equal(await local.read(imported.id), 'unsaved original')
    const session = JSON.parse(await readFile(join(f.target, 'editor-session.json'), 'utf8'))
    assert.equal(session.rootPath, null); assert.equal(session.tabs[0].draftId, imported.id); assert.equal(session.tabs[0].path, null)
    assert.equal(session.restoredReferences[0].path, join(f.workspace, 'main.c'))
    assert.equal(await new EditorSessionStore(join(f.target, 'editor-session.json')).available(), true)
    const project = await new ProjectRepository(join(f.target, 'projects-v1')).read(f.relocated)
    assert.deepEqual(project?.approved, []); assert.deepEqual(project?.evidence, []); assert.equal(project?.restoredEvidence?.length, 1)
    assert.ok((await readdir(f.root)).some(n => n.startsWith('Ion Restored Workspaces ')))
    const verification = join(f.root, 'rollback'); await mkdir(verification)
    await readArchive(ready.rollback, verification)
    assert.equal(await finishPendingRestore(f.target), 'none')
    await service.cancel()
  })
  test('Practice submission archives contain only aggregate evidence and restore each past verdict as historical', async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-submission-backup-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    const source = join(root, 'source'), target = join(root, 'target'), extracted = join(root, 'extracted')
    for (const directory of [source, target, extracted]) await mkdir(directory)
    const practice = new PracticeStore(join(source, 'practice'))
    const { problem, attempt } = await practice.start('minutes-to-clock', 'javascript')
    const sourcePath = await practice.openAttempt(problem.id, attempt.id)
    const publicProblem = await readFile(join(source, 'practice', problem.id, 'problem.json'))
    const submit = async (store: PracticeStore) => {
      const signal = new AbortController().signal
      return store.submit(problem.id, attempt.id, async (path, inputs, _revision, hash) => {
        const text = await readFile(path, 'utf8')
        assert.equal(hash, sha256(text))
        return runPracticeBatch(path, text, inputs, async () => sha256(await readFile(path)) === hash, signal)
      }, signal)
    }

    const wrong = 'process.stdout.write("private-verdict-stdout"); process.stderr.write("private-verdict-stderr");'
    const correct = [
      "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => { input += part })",
      "process.stdin.on('end', () => { const n = Number(input); console.log(Math.floor(n / 60), n % 60) })",
    ].join('\n')
    await writeFile(sourcePath, wrong)
    const failed = await submit(practice)
    assert.equal(failed.attempts[0].submissions?.[0].verdict, 'wrong-answer')
    await writeFile(sourcePath, correct)
    const solved = await submit(practice)
    const results = solved.attempts[0].submissions!
    assert.deepEqual(results.map(({ verdict, current }) => [verdict, current]), [['wrong-answer', false], ['accepted', true]])
    const rows = results.map(({ judgedAt, verdict, passed, total, runtimeMs }, i) => ({
      judgedAt, verdict, passed, total, runtimeMs, suiteVersion: 1, sourceSha256: sha256(i === 0 ? wrong : correct),
    }))

    const prefix = 'profile/practice/' + problem.id + '/', base = 'attempt-' + attempt.id
    const ledger = prefix + base + '.submissions.json', problemEntry = prefix + 'problem.json', codeEntry = prefix + base + '.js'
    const producer = new BackupService({ profile: source, appVersion: '0.9.9' })
    const reviewed = await producer.review({ categories: ['practice'], folders: [] })
    const archive = join(root, 'practice.ionbackup')
    await producer.create(reviewed.token, archive)
    const manifest = await readArchive(archive, extracted)
    // Check every decompressed entry against the public problem, the saved source or the exact aggregate ledger.
    assert.deepEqual(manifest.entries.map(e => e.path).sort(), [ledger, problemEntry, codeEntry].sort())
    assert.deepEqual(await readFile(join(extracted, problemEntry)), publicProblem)
    assert.equal(await readFile(join(extracted, codeEntry), 'utf8'), correct)
    assert.deepEqual(JSON.parse(await readFile(join(extracted, ledger), 'utf8')), { version: 1, submissions: rows })
    for (const entry of manifest.entries) {
      assert.doesNotMatch(await readFile(join(extracted, entry.path), 'utf8'), /private-verdict-(stdout|stderr)/)
    }

    const consumer = new BackupService({ profile: target, appVersion: '0.9.9' })
    const review = await consumer.openRestore(archive)
    const plan = await consumer.prepareRestore(review.token, { replace: ['practice'], mappings: [], copyFolders: [] })
    await consumer.finalize(plan.token)
    assert.equal(await finishPendingRestore(target), 'applied')
    const restored = new PracticeStore(join(target, 'practice'))
    const history = (await restored.get(problem.id)).attempts[0].submissions!
    assert.deepEqual(history, results.map(result => ({ ...result, current: false })))
    assert.equal(await readFile(await restored.openAttempt(problem.id, attempt.id), 'utf8'), correct)
    const fresh = await submit(restored)
    const refreshed = fresh.attempts[0].submissions!
    assert.deepEqual(refreshed.slice(0, -1), history)
    assert.equal(refreshed.at(-1)?.verdict, 'accepted')
    assert.equal(refreshed.at(-1)?.current, true)
    const localLedger = join(target, 'practice', problem.id, base + '.submissions.json')
    const retained = await readFile(localLedger, 'utf8')
    const published = JSON.parse(retained).submissions
    assert.deepEqual(published.slice(0, -1), rows.map(row => ({ ...row, restored: true })))
    assert.equal(published.at(-1).restored, undefined)
    assert.equal(published.at(-1).sourceSha256, rows[1].sourceSha256)

    // A valid checksum must not authorize new fields carrying private judge material, or an oversized history.
    const altered = [
      { version: 1, submissions: [{ ...rows[0], expectedOutput: 'private test answer' }] },
      { version: 1, submissions: rows, stdout: 'private-verdict-stdout' },
      { version: 1, submissions: Array.from({ length: 11 }, () => rows[0]) },
    ]
    for (const [i, invalid] of altered.entries()) {
      const data = Buffer.from(JSON.stringify(invalid)), path = join(root, 'bad-submissions-' + i + '.ionbackup')
      const adjusted = { ...manifest, entries: manifest.entries.map(entry => entry.path === ledger
        ? { ...entry, bytes: data.length, sha256: sha256(data) } : entry) }
      await writeFile(join(extracted, ledger), data)
      await writeArchive(extracted, adjusted, path)
      await assert.rejects(consumer.openRestore(path), /submission|history|field/i)
      assert.equal(await readFile(localLedger, 'utf8'), retained)
    }
    await consumer.cancel()
  })
  test('legacy folder exports are validated and label their missing original checksums', async t => {
    const f = await fixture(t), legacy = await exportLocalProfile(f.source, f.root, f.prefs)
    const service = new BackupService({ profile: f.target, appVersion: '0.9.8' }), review = await service.openRestore(legacy, true)
    assert.equal(review.legacy, true); assert.ok(review.warnings.some(w => w.includes('original checksums')))
    const p = await service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] })
    await service.finalize(p.token); assert.equal(await finishPendingRestore(f.target), 'applied')
    assert.equal((await new PreferenceStore(join(f.target, 'preferences.json')).get()).settings.fontSize, 19)
  })
  test('changed previews and nonexistent category choices cannot overwrite newer work', async t => {
    const f = await archive(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' })
    const prefs = new PreferenceStore(join(f.target, 'preferences.json')); await prefs.updateSettings({ fontSize: 14 })
    const review = await service.openRestore(f.file)
    await prefs.updateSettings({ fontSize: 22 })
    await assert.rejects(service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] }), /changed/)
    assert.equal((await prefs.get()).settings.fontSize, 22)
    await assert.rejects(service.prepareRestore(review.token, { replace: [] as never[], mappings: [], copyFolders: [] }), /Invalid/)
    await service.cancel(); assert.ok(!(await readdir(f.target)).some(n => n.startsWith('.ion-backup-stage-')))
  })
  test('exclusive archive publication preserves an existing backup and changed source review fails', async t => {
    const f = await fixture(t), service = new BackupService(f.options)
    const review = await service.review({ categories: ['preferences'], folders: [] }), file = join(f.root, 'kept.ionbackup')
    await writeFile(file, 'existing')
    await assert.rejects(service.create(review.token, file), /EEXIST/)
    assert.equal(await readFile(file, 'utf8'), 'existing')
    await f.prefs.updateSettings({ fontSize: 20 })
    await assert.rejects(service.create(review.token, join(f.root, 'changed.ionbackup')), /changed/)
    await service.cancel(); assert.ok(!(await readdir(f.root)).some(n => n.endsWith('.tmp')))
  })
  test('cancelled creation and injected ENOSPC do not publish partial archives', async t => {
    const f = await fixture(t), service = new BackupService(f.options), review = await service.review({ categories: ['preferences'], folders: [] })
    const stage = (await readdir(f.source)).find(n => n.startsWith('.ion-backup-stage-'))!, payload = join(f.source, stage)
    const manifest: BackupManifest = { format: 'ion-backup', version: 1, id: randomUUID(), appVersion: '0.9.8', createdAt: new Date().toISOString(), categories: ['preferences'], schemas: { preferences: 1 }, folders: [], projects: [], exclusions: [], exclusionsOmitted: 0, entries: review.entries.map(e => ({ ...e, category: 'preferences', sha256: sha256('irrelevant') })) }
    manifest.entries[0].sha256 = sha256(await readFile(join(payload, manifest.entries[0].path)))
    const controller = new AbortController(); controller.abort()
    await assert.rejects(writeArchive(payload, manifest, join(f.root, 'cancel.ionbackup'), controller.signal), /cancel/i)
    await assert.rejects(writeArchive(payload, manifest, join(f.root, 'full.ionbackup'), undefined, async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }), /disk full/)
    assert.deepEqual((await readdir(f.root)).filter(n => n.endsWith('.ionbackup') || n.endsWith('.tmp')), [])
    await service.cancel()
  })
  test('malformed paths, schemas, duplicates and decompression declarations are rejected', () => {
    for (const value of ['../escape', '/absolute', 'C:/device', '\\\\host\\share', 'a:stream', 'NUL.txt', 'CONIN$', 'a/../b', 'a.', 'e\u0301.txt', 'a\\b']) assert.throws(() => portablePath(value), Error, value)
    const base: BackupManifest = { format: 'ion-backup', version: 1, id: randomUUID(), createdAt: new Date().toISOString(), appVersion: '0.9.8', categories: ['preferences'], schemas: { preferences: 1 }, entries: [{ path: 'profile/preferences.json', bytes: 1, sha256: '0'.repeat(64), category: 'preferences' }], folders: [], projects: [], exclusions: [], exclusionsOmitted: 0 }
    assert.throws(() => parseManifest({ ...base, schemas: { preferences: 2 } }))
    assert.throws(() => parseManifest({ ...base, entries: [...base.entries, ...base.entries] }))
    assert.throws(() => parseManifest({ ...base, entries: [{ ...base.entries[0], bytes: limits.fileBytes + 1 }] }))
  })
  test('corruption and truncated archives fail without modifying current profile', async t => {
    const f = await archive(t), bytes = await readFile(f.file), service = new BackupService({ profile: f.target, appVersion: '0.9.8' })
    for (const [name, value] of [['truncated', bytes.subarray(0, bytes.length - 15)], ['bad-header', Buffer.from(bytes)]] as const) {
      if (name === 'bad-header') value[0] = 0
      const path = join(f.root, name + '.ionbackup'); await writeFile(path, value)
      await assert.rejects(service.openRestore(path)); assert.deepEqual(await readdir(f.target), [])
    }
  })
  test('linked profile payloads fail and no external file is copied', { skip: process.platform === 'win32' ? 'Creating a symlink requires a Windows privilege not assumed by this fixture.' : false }, async t => {
    const f = await fixture(t), outside = join(f.root, 'private.txt'); await writeFile(outside, 'private')
    await rm(join(f.source, 'learning.json')); await symlink(outside, join(f.source, 'learning.json'))
    const service = new BackupService(f.options)
    await assert.rejects(service.review({ categories: ['learning'], folders: [] }), /regular|link/)
    assert.equal(await readFile(outside, 'utf8'), 'private')
    assert.ok(!(await readdir(f.source)).some(n => n.startsWith('.ion-backup-stage-')))
  })
  for (const boundary of ['journal', 'previous-moved', 'published', 'committed']) test('actual process interruption resumes safely at ' + boundary, async t => {
    const f = await archive(t), prefs = new PreferenceStore(join(f.target, 'preferences.json')); await prefs.updateSettings({ fontSize: 12 })
    const service = new BackupService({ profile: f.target, appVersion: '0.9.8' }), review = await service.openRestore(f.file)
    const ready = await service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] }); await service.finalize(ready.token)
    await interruptRestore(f.target, boundary)
    assert.equal(await finishPendingRestore(f.target), 'applied')
    assert.equal((await new PreferenceStore(join(f.target, 'preferences.json')).get()).settings.fontSize, 19)
    assert.ok(!(await readdir(f.target)).includes(pendingName))
  })
  test('transaction sharing/permission failures roll back and preserve original data', async t => {
    const f = await archive(t), prefs = new PreferenceStore(join(f.target, 'preferences.json')); await prefs.updateSettings({ fontSize: 12 })
    const before = await treeHash(f.target, 'preferences.json'), service = new BackupService({ profile: f.target, appVersion: '0.9.8' }), review = await service.openRestore(f.file)
    const ready = await service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] }); await service.finalize(ready.token)
    assert.equal(await finishPendingRestore(f.target, async stage => { if (stage === 'previous-moved') throw Object.assign(new Error('Sharing violation'), { code: 'EPERM' }) }), 'rolled-back')
    assert.equal(await treeHash(f.target, 'preferences.json'), before)
  })
  test('hostile ZIP entries are rejected before any profile publication', async t => {
    const f = await fixture(t), data = await readFile(join(f.source, 'preferences.json'))
    const entry = { path: 'profile/preferences.json', category: 'preferences' as const, bytes: data.length, sha256: sha256(data) }
    const manifest: BackupManifest = { format: 'ion-backup', version: 1, id: randomUUID(), createdAt: new Date().toISOString(), appVersion: '0.9.8', categories: ['preferences'], schemas: { preferences: 1 }, entries: [entry], folders: [], projects: [], exclusions: [], exclusionsOmitted: 0 }
    const header = { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, payload = { name: entry.path, data }
    const cases = [
      [{ ...payload, name: '../escape' }], [{ ...payload, name: '/absolute' }], [{ ...payload, name: 'C:/device' }],
      [{ ...payload, name: 'profile/preferences.json:stream' }], [{ ...payload, mode: 0o120777 }], [{ ...payload, mode: 0o020600 }],
      [payload, payload], [payload, { ...payload, name: payload.name.toUpperCase() }], [{ ...payload, flags: 0x801 }],
      [{ ...payload, localName: 'profile/unauthorized.json' }], [{ ...payload, size: limits.fileBytes + 1 }], [{ ...payload, badCrc: true }],
    ]
    const service = new BackupService({ profile: f.target, appVersion: '0.9.8' })
    for (let i = 0; i < cases.length; i++) {
      const path = join(f.root, 'hostile-' + i + '.ionbackup'); await writeFile(path, zipFixture([header, ...cases[i]]))
      await assert.rejects(service.openRestore(path), Error, 'hostile case ' + i)
      assert.deepEqual(await readdir(f.target), [])
    }
    const path = join(f.root, 'valid-stored.ionbackup'); await writeFile(path, zipFixture([header, payload]))
    assert.equal((await service.openRestore(path)).files, 1); await service.cancel()
  })
  test('selecting an ancestor prunes the active profile, credentials and staging', async t => {
    const f = await fixture(t), service = new BackupService(f.options), folder = await service.addFolder(f.root)
    const review = await service.review({ categories: ['preferences'], folders: [{ ...folder, mode: 'copy' }] })
    assert.ok(review.exclusions.some(e => e.reason.includes('Active Ion profile')))
    assert.ok(!review.entries.some(e => e.path.includes('/source/')))
    assert.ok(review.entries.some(e => e.path.endsWith('/main.c')))
    await service.cancel()
    await assert.rejects(service.review({ categories: ['preferences'], folders: [{ id: randomUUID(), name: 'expired', mode: 'copy' }] }), /again/)
    assert.ok(!(await readdir(f.source)).some(n => n.startsWith('.ion-backup-stage-')))
  })
  test('selected empty categories do not modify unselected current categories', async t => {
    const f = await archive(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' })
    await new LearningService(join(f.target, 'learning.json')).recordTopic('loops', 'selected')
    const before = await treeHash(f.target, 'learning.json'), review = await service.openRestore(f.file)
    const ready = await service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] })
    await service.finalize(ready.token); await finishPendingRestore(f.target)
    assert.equal(await treeHash(f.target, 'learning.json'), before)
  })
  test('combined recovery limits reject before replacement, and stale final confirmation cannot overwrite', async t => {
    const f = await archive(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' }), recovery = new RecoveryStore(join(f.target, 'recovery'))
    for (let i = 0; i < 64; i++) await recovery.write({ id: randomUUID(), name: 'current.txt', text: 'keep' })
    let review = await service.openRestore(f.file)
    const ready = await service.prepareRestore(review.token, { replace: ['recovery'], mappings: [], copyFolders: [] })
    await assert.rejects(service.finalize(ready.token), /64-draft/)
    assert.equal((await recovery.list()).length, 64); assert.ok(!(await readdir(f.target)).includes(pendingName))
    await service.cancel(); review = await service.openRestore(f.file)
    const p = await service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] })
    await new PreferenceStore(join(f.target, 'preferences.json')).updateSettings({ fontSize: 28 })
    await assert.rejects(service.finalize(p.token), /changed/); await service.cancel()
  })
  test('an error after marker publication preserves the journal and forces startup repair', async t => {
    const f = await archive(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' }), review = await service.openRestore(f.file)
    const ready = await service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] })
    const original = fs.link
    fs.link = (async (source, target) => { await original(source, target); if (String(target).endsWith(pendingName)) throw Object.assign(new Error('Injected directory sync failure after publication'), { code: 'EIO' }) }) as typeof fs.link
    try { await assert.rejects(service.finalize(ready.token), /Injected/) } finally { fs.link = original }
    assert.equal(service.restartRequired, true)
    await service.cancel() // Cannot delete a transaction referenced by the marker.
    assert.equal(await finishPendingRestore(f.target), 'applied')
  })
  test('post-arm temporary cleanup failure cannot turn a committed restart into editing', async t => {
    const f = await archive(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' }), review = await service.openRestore(f.file)
    const ready = await service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] }), original = fs.rm
    fs.rm = (async (path, options) => { if (service.restartRequired && String(path).includes('.ion-backup-stage-')) throw Object.assign(new Error('Injected cleanup permission error'), { code: 'EPERM' }); return original(path, options) }) as typeof fs.rm
    try { await service.finalize(ready.token) } finally { fs.rm = original }
    assert.equal(service.restartRequired, true); assert.equal(await finishPendingRestore(f.target), 'applied')
  })
  test('multi-category rollback survives a real process interruption and restores all original bytes', async t => {
    const f = await archive(t), prefs = new PreferenceStore(join(f.target, 'preferences.json')); await prefs.updateSettings({ fontSize: 12 })
    await new LearningService(join(f.target, 'learning.json')).recordTopic('loops', 'selected')
    const before = await Promise.all(['preferences.json', 'learning.json'].map(n => treeHash(f.target, n)))
    const service = new BackupService({ profile: f.target, appVersion: '0.9.8' }), review = await service.openRestore(f.file)
    const ready = await service.prepareRestore(review.token, { replace: ['preferences', 'learning'], mappings: [], copyFolders: [] }); await service.finalize(ready.token)
    await interruptRestore(f.target, 'rollback-after-publication')
    assert.equal(await finishPendingRestore(f.target), 'rolled-back')
    assert.deepEqual(await Promise.all(['preferences.json', 'learning.json'].map(n => treeHash(f.target, n))), before)
  })
  test('cancelling an active ZIP stream closes its input handle before cleanup', async t => {
    const f = await fixture(t), stage = join(f.root, 'stream-stage'), folder = randomUUID(), name = 'workspaces/' + folder + '/big.txt'
    await mkdir(join(stage, 'workspaces', folder), { recursive: true }); const bytes = Buffer.alloc(2 * 1024 * 1024, 'x')
    const source = join(stage, name); await writeFile(source, bytes)
    const manifest: BackupManifest = { format: 'ion-backup', version: 1, id: randomUUID(), createdAt: new Date().toISOString(), appVersion: '0.9.8', categories: ['preferences'], schemas: { preferences: 1 },
      entries: [{ path: name, bytes: bytes.length, sha256: sha256(bytes), folder }], folders: [{ id: folder, name: 'Disposable', mode: 'copy', originalPath: f.workspace }], projects: [], exclusions: [], exclusionsOmitted: 0 }
    const controller = new AbortController(), original = fs.open
    let input: import('node:fs').ReadStream | undefined
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args)
      if (String(args[0]) === source) {
        const create = file.createReadStream.bind(file)
        file.createReadStream = options => { input = create(options); input.once('data', () => controller.abort()); return input }
      }
      return file
    }) as typeof fs.open
    try { await assert.rejects(writeArchive(stage, manifest, join(f.root, 'interrupted.ionbackup'), controller.signal), /abort|cancel/i) }
    finally { fs.open = original }
    assert.equal(input?.closed, true)
    assert.ok(!(await readdir(f.root)).some(n => n.endsWith('.tmp') || n === 'interrupted.ionbackup'))
  })
  test('ENOSPC during transaction staging leaves no pending marker or abandoned transaction', async t => {
    const f = await archive(t), service = new BackupService({ profile: f.target, appVersion: '0.9.8' }), review = await service.openRestore(f.file)
    const p = await service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] }), original = fs.open
    fs.open = (async (...args: Parameters<typeof fs.open>) => { if (String(args[0]).includes('.ion-restores') && String(args[0]).endsWith('preferences.json') && args[1] === 'wx') throw Object.assign(new Error('Injected ENOSPC'), { code: 'ENOSPC' }); return original(...args) }) as typeof fs.open
    try { await assert.rejects(service.finalize(p.token), /ENOSPC/) } finally { fs.open = original }
    assert.ok(!(await readdir(f.target)).includes(pendingName)); assert.deepEqual(await readdir(join(f.target, '.ion-restores')), [])
    await service.cancel()
  })
  test('an external profile write during transaction staging requires renewed review', async t => {
    const f = await archive(t), prefs = new PreferenceStore(join(f.target, 'preferences.json')); await prefs.updateSettings({ fontSize: 12 })
    const service = new BackupService({ profile: f.target, appVersion: '0.9.8' }), review = await service.openRestore(f.file)
    const p = await service.prepareRestore(review.token, { replace: ['preferences'], mappings: [], copyFolders: [] }), original = fs.open
    let changed = false
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args)
      if (!changed && String(args[0]).includes('.ion-restores') && String(args[0]).endsWith('preferences.json') && args[1] === 'wx') { changed = true; await prefs.updateSettings({ fontSize: 29 }) }
      return file
    }) as typeof fs.open
    try { await assert.rejects(service.finalize(p.token), /changed during restore staging/) } finally { fs.open = original }
    assert.equal((await prefs.get()).settings.fontSize, 29); assert.ok(!(await readdir(f.target)).includes(pendingName)); await service.cancel()
  })
  test('repeated reviews and cancellations leave no owned staging or pending work', async t => {
    const f = await fixture(t), service = new BackupService(f.options)
    for (let i = 0; i < 12; i++) { await service.review({ categories: ['preferences', 'recovery'], folders: [] }); await service.cancel(); assert.equal(service.busy, false) }
    assert.ok(!(await readdir(f.source)).some(n => n.startsWith('.ion-backup-stage-')))
    assert.equal((await profileFiles(f.source, [...backupCategories])).length > 4, true)
  })
}
