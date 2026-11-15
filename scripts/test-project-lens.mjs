import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, editorShows, eventually, launch, openFolder, stubDialogs, withScratch } from './desktop-harness.mjs'

// Native CI fixture only. It launches a disposable production Electron process;
// use the existing desktop harness's visibility policy, never the installed Ion.
const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  out: { type: 'string', default: 'performance-results/project-lens-native.json' },
} })
const target = await artifact(values.target)
assert.equal(target.args.length, 1, 'Project Lens observation requires an unpackaged production target.')
const output = resolve(values.out)
const digest = value => createHash('sha256').update(value).digest('hex')
const report = { schemaVersion: 1, protocol: 'project-lens-native-v1', complete: false,
  platform: process.platform, arch: process.arch, checks: {}, skipped: [], cleanupVerified: false }
let phase = 'fixture', failed
const exists = path => access(path).then(() => true, () => false)

try {
  await withScratch('project-lens-native', async scratch => {
    const root = join(scratch, 'Mixed project ü with spaces')
    const second = join(scratch, 'Second project')
    const outside = join(scratch, 'Outside disposable evidence')
    const profile = join(scratch, 'profile')
    const manifest = join(root, 'package.json')
    const marker = join(root, 'DO_NOT_EXECUTE.marker')
    const sourceSentinel = 'ION_LENS_SOURCE_CONTENT_MUST_STAY_UNREAD'
    const documentSentinel = 'ION_LENS_DOCUMENT_CONTENT_MUST_STAY_UNREAD'
    const secretSentinel = 'ION_LENS_SYNTHETIC_SECRET_MUST_STAY_UNREAD'
    const manifestSecret = 'ION_LENS_SYNTHETIC_COMMAND_TOKEN'
    const packageText = JSON.stringify({ name: 'ion-disposable-lens-fixture', version: '1.0.0', main: 'src/main.py',
      dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^6.0.0' },
      scripts: {
        prepare: `node -e "require('node:fs').writeFileSync('DO_NOT_EXECUTE.marker','executed')"`,
        test: `AUTH_TOKEN=${manifestSecret} node -e "process.exit(97)"`,
      },
    }, null, 2) + '\n'
    const files = {
      'program.c': `/* ${sourceSentinel} */\nint main(void) { return 0; }\n`,
      'src/Main.java': `// ${sourceSentinel}\npublic class Main { public static void main(String[] args) {} }\n`,
      'src/main.py': `# ${sourceSentinel}\nprint('not executed')\n`,
      'README.md': '# Fixture\n' + documentSentinel + '\n',
      'docs/guide.md': documentSentinel,
      'tests/program.test.py': `# ${sourceSentinel}\nraise RuntimeError('must not run')\n`,
      '.env': 'AUTH_TOKEN=' + secretSentinel,
      'secrets/password.txt': secretSentinel,
      'certificate.pem': secretSentinel,
      'node_modules/ignored/package.json': secretSentinel,
      'build/generated.c': sourceSentinel,
      'package-lock.json': secretSentinel,
      'figure.png': Buffer.from([0, 1, 2, 3]),
      'package.json': packageText,
    }
    await Promise.all([mkdir(root), mkdir(second), mkdir(outside), mkdir(profile)])
    for (const [name, data] of Object.entries(files)) {
      const path = join(root, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
    }
    await writeFile(join(second, 'program.c'), 'int main(void) { return 0; }\n')
    await writeFile(join(second, 'package.json'), '{"name":"second-disposable-fixture"}\n')
    await writeFile(join(outside, 'package.json'), secretSentinel)
    for (const [name, destination, type] of [
      ['outside-file.json', join(outside, 'package.json'), 'file'],
      ['outside-directory', outside, process.platform === 'win32' ? 'junction' : 'dir'],
    ]) {
      try { await symlink(destination, join(root, name), type) }
      catch (error) {
        if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error
        report.skipped.push({ name: 'symlink-' + type, code: error.code,
          reason: 'Native filesystem or user permissions do not allow this fixture. Not marked passed.' })
      }
    }
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
      settings: { resourceProfile: 'minimal', autoSave: false, openFullScreen: false, checkUpdatesOnLaunch: false } }))

    // Observe real reads and optionally hold one real manifest open. All calls
    // delegate unchanged. No fake snapshots, file contents or process results.
    const wrapper = join(scratch, 'project-lens-entry.cjs')
    await writeFile(wrapper, `const fs = require('node:fs/promises');
const path = require('node:path');
const roots = ${JSON.stringify({ workspace: root, secondary: second, outside })};
const manifest = ${JSON.stringify(manifest)};
const state = globalThis.ionProjectLensFixture = { reads: [], overflow: false, hold: false, waiting: false, release: null,
  manifestOpened: 0, manifestClosed: 0, activeManifestIds: [], analyses: 0 };
const { ipcMain } = require('electron');
const originalHandle = ipcMain.handle;
ipcMain.handle = function(channel, listener) {
  if (channel !== 'ion:project-lens-analyze') return originalHandle.call(this, channel, listener);
  return originalHandle.call(this, channel, async function(...args) {
    state.analyses++;
    try { return await listener.apply(this, args); }
    finally { state.analyses--; }
  });
};
function scopeFor(file) {
  if (typeof file !== 'string') return;
  for (const [scope, root] of Object.entries(roots)) {
    const relative = path.relative(root, file);
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) return { scope, relative };
  }
}
function observe(file, operation) {
  const watched = scopeFor(file);
  if (!watched) return;
  if (state.reads.length === 128) { state.overflow = true; return; }
  state.reads.push({ scope: watched.scope, operation, path: watched.relative.split(path.sep).join('/') });
}
const originalOpen = fs.open;
fs.open = async function(file, flags, ...rest) {
  const reading = typeof flags === 'number' ? (flags & 3) !== 1 : !String(flags).startsWith('w') && !String(flags).startsWith('a');
  if (reading) observe(file, 'open');
  if (file === manifest && state.hold) {
    state.hold = false; state.waiting = true;
    await new Promise(resolve => { state.release = resolve; });
    state.release = null; state.waiting = false;
  }
  const handle = await originalOpen.call(this, file, flags, ...rest);
  if (reading && scopeFor(file) && path.basename(file) === 'package.json') {
    const id = ++state.manifestOpened;
    state.activeManifestIds.push(id);
    const originalClose = handle.close;
    let closed = false;
    handle.close = async function(...args) {
      const result = await originalClose.apply(this, args);
      if (!closed) {
        closed = true; state.manifestClosed++;
        state.activeManifestIds = state.activeManifestIds.filter(active => active !== id);
      }
      return result;
    };
  }
  return handle;
};
const originalReadFile = fs.readFile;
fs.readFile = function(file, ...args) { observe(file, 'readFile'); return originalReadFile.call(this, file, ...args); };
require(${JSON.stringify(target.args[0])});\n`)
    let session, primaryError
    try {
      phase = 'launch'
      session = await launch({ ...target, args: [wrapper] }, profile)
      const { app, page } = session
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: root })
      await openFolder(page, { directory: root, program: join(root, 'program.c') })
      await page.getByTestId('navigate-projects').click()
      const projects = page.getByTestId('projects-panel')
      await projects.waitFor()
      await projects.getByTestId('project-view-lens').click()
      const lens = page.getByTestId('project-lens')
      await lens.waitFor()
      phase = 'explicit-action-boundary'
      assert.equal(await lens.getByTestId('project-lens-summary').count(), 0)
      const observed = () => app.evaluate(() => {
        const state = globalThis.ionProjectLensFixture;
        return { reads: state.reads, overflow: state.overflow, opened: state.manifestOpened,
          closed: state.manifestClosed, active: state.activeManifestIds, analyses: state.analyses };
      })
      assert.deepEqual((await observed()).reads, [], 'Opening Project Lens must not read workspace contents.')
      await assert.rejects(page.evaluate(path => window.ion.projectLens.analyze(path), outside), /exact currently open folder/)
      await lens.getByTestId('project-lens-analyze').click()
      await lens.getByTestId('project-lens-summary').waitFor()
      report.checks.explicitAnalyze = 'passed'

      phase = 'real-snapshot-and-read-observation'
      // This second explicitly requested IPC analysis retrieves the real native
      // snapshot for assertions without replacing or mocking the UI bridge.
      const snapshot = await page.evaluate(path => window.ion.projectLens.analyze(path), root)
      assert.equal(snapshot.root, root)
      assert.equal(snapshot.status, 'complete')
      const serialized = JSON.stringify(snapshot)
      for (const sentinel of [sourceSentinel, documentSentinel, secretSentinel, manifestSecret]) {
        assert.equal(serialized.includes(sentinel), false, 'Unapproved content appeared in the native snapshot.')
      }
      const returned = snapshot.files.map(file => file.reference.path)
      for (const excluded of ['.env', 'secrets/password.txt', 'certificate.pem', 'node_modules/ignored/package.json',
        'build/generated.c', 'package-lock.json', 'figure.png', 'outside-file.json']) assert.equal(returned.includes(excluded), false)
      for (const language of ['c', 'java', 'python']) assert.ok(snapshot.languages.some(item => item.id === language))
      assert.ok(snapshot.documentation.some(item => item.path === 'README.md'))
      assert.ok(snapshot.tests.some(item => item.path === 'tests/program.test.py'))
      assert.ok(snapshot.frameworks.some(item => item.name === 'React' && item.confidence === 'declared'))
      assert.ok(snapshot.frameworks.some(item => item.name === 'Vite' && item.confidence === 'declared'))
      assert.equal(snapshot.counts.manifestBytesRead, Buffer.byteLength(packageText))
      assert.ok(snapshot.exclusions.secret >= 2)
      const reads = await observed()
      assert.equal(reads.overflow, false)
      assert.ok(reads.reads.length >= 2, 'Observer must witness actual manifest reads, not a vacuous empty trace.')
      assert.ok(reads.reads.every(item => item.scope === 'workspace' && item.path === 'package.json'),
        'Analysis read source, documentation, generated, secret, or outside contents.')
      assert.equal(await exists(marker), false, 'A manifest command executed.')
      report.checks.offlineStructureAndNoSourceSecretReads = 'passed'
      report.checks.manifestCommandsInert = 'passed'
      report.observations = { counts: snapshot.counts, exclusions: snapshot.exclusions,
        manifestReadCalls: reads.reads.length, sourceReadCalls: 0, outsideReadCalls: 0,
        snapshotBytes: Buffer.byteLength(serialized), symlinkChecksAvailable: 2 - report.skipped.length }

      phase = 'reference-authority'
      const reference = snapshot.manifests.find(item => item.reference.path === 'package.json').reference
      assert.deepEqual(reference.range, { startLine: 1, startColumn: 1,
        endLine: packageText.split('\n').length, endColumn: 1 })
      for (const forged of [
        { ...reference, path: '../Outside disposable evidence/package.json' },
        { ...reference, path: 'secrets/password.txt' },
        { ...reference, range: { ...reference.range, startColumn: 2 } },
      ]) await assert.rejects(page.evaluate(({ root, reference }) => window.ion.projectLens.openReference(root, reference),
        { root, reference: forged }), /Invalid Project Lens reference|not part of the last Project Lens snapshot/)
      const opened = await page.evaluate(({ root, reference }) => window.ion.projectLens.openReference(root, reference), { root, reference })
      assert.equal(opened.entry.path, manifest)
      assert.deepEqual(opened.range, reference.range)
      const manifestView = lens.getByTestId('project-lens-manifest').filter({ hasText: 'package.json' })
      await manifestView.locator('summary').click()
      await manifestView.getByRole('button', { name: 'package.json', exact: true }).click()
      await atPath(page, 'tab', manifest).waitFor()
      await editorShows(page, 'ion-disposable-lens-fixture')
      await page.getByText('Ln 1, Col 1', { exact: true }).waitFor()
      await writeFile(manifest, packageText + ' \n')
      await assert.rejects(page.evaluate(({ root, reference }) => window.ion.projectLens.openReference(root, reference),
        { root, reference }), /changed on disk/)
      report.checks.referenceMembershipRevisionAndSourceNavigation = 'passed'

      phase = 'hide-reopen-no-automatic-analysis'
      await atPath(page, 'close-tab', manifest).click()
      await atPath(page, 'tab', manifest).waitFor({ state: 'detached' })
      const readsBeforeReopen = (await observed()).reads.length
      await page.getByTestId('navigate-projects').click()
      await projects.waitFor({ state: 'detached' })
      await assert.rejects(page.evaluate(({ root, reference }) => window.ion.projectLens.openReference(root, reference),
        { root, reference }), /Open Project Lens|Projects panel|Analyze the current folder/)
      await page.getByTestId('navigate-projects').click()
      await projects.waitFor()
      await projects.getByTestId('project-view-lens').click()
      await lens.waitFor()
      assert.equal(await lens.getByTestId('project-lens-summary').count(), 0)
      await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
      assert.equal((await observed()).reads.length, readsBeforeReopen, 'Hide/reopen automatically read workspace contents.')
      report.checks.hideRevokesSnapshotAndReopenDoesNotAnalyze = 'passed'

      phase = 'cancel-held-real-analysis'
      const beforeCancel = await observed()
      await app.evaluate(() => { globalThis.ionProjectLensFixture.hold = true })
      await lens.getByTestId('project-lens-analyze').click()
      await eventually(() => app.evaluate(() => globalThis.ionProjectLensFixture.waiting), 'Real manifest open did not reach the cancellation gate.')
      await lens.getByTestId('project-lens-cancel').click()
      await app.evaluate(() => globalThis.ionProjectLensFixture.release?.())
      await eventually(() => app.evaluate(() => !globalThis.ionProjectLensFixture.waiting), 'The cancelled real manifest open remained held.')
      await eventually(async () => {
        const handles = await observed()
        return handles.analyses === 0 && handles.active.length === 0 && handles.opened > beforeCancel.opened && handles.closed > beforeCancel.closed
      }, 'Cancelled analysis did not close its real manifest FileHandle.')
      assert.equal(await lens.getByTestId('project-lens-summary').count(), 0)
      await assert.rejects(page.evaluate(({ root, reference }) => window.ion.projectLens.openReference(root, reference),
        { root, reference }), /Analyze the current folder/)
      report.checks.explicitCancellationRevokesEvidence = 'passed'

      phase = 'unmount-held-real-analysis'
      await app.evaluate(() => { globalThis.ionProjectLensFixture.hold = true })
      await lens.getByTestId('project-lens-analyze').click()
      await eventually(() => app.evaluate(() => globalThis.ionProjectLensFixture.waiting), 'Analysis did not reach the unmount gate.')
      await projects.getByTestId('project-view-roadmap').click()
      await lens.waitFor({ state: 'detached' })
      await app.evaluate(() => globalThis.ionProjectLensFixture.release?.())
      await eventually(async () => { const state = await observed(); return state.analyses === 0 && state.active.length === 0 },
        'Unmounted analysis did not settle and close its handles.')
      await projects.getByTestId('project-view-lens').click()
      await lens.waitFor()
      assert.equal(await lens.getByTestId('project-lens-summary').count(), 0)
      report.checks.unmountCancelsAndDrainsAnalysis = 'passed'

      phase = 'workspace-change-during-real-analysis'
      const beforeRootChange = await observed()
      await app.evaluate(() => { globalThis.ionProjectLensFixture.hold = true })
      const pending = page.evaluate(path => window.ion.projectLens.analyze(path), root)
      void pending.catch(() => undefined)
      await eventually(() => app.evaluate(() => globalThis.ionProjectLensFixture.waiting), 'Real manifest open did not reach the workspace-change gate.')
      await stubDialogs(app, { folder: second })
      await page.getByTestId('open-folder').click()
      await atPath(page, 'explorer-entry', join(second, 'program.c')).waitFor()
      await app.evaluate(() => globalThis.ionProjectLensFixture.release?.())
      const stale = await pending
      assert.ok(['cancelled', 'invalidated'].includes(stale.status), 'Old-root work must not remain usable after workspace change.')
      await eventually(async () => {
        const handles = await observed()
        return handles.analyses === 0 && handles.active.length === 0 && handles.opened > beforeRootChange.opened && handles.closed > beforeRootChange.closed
      }, 'Workspace invalidation did not close its real manifest FileHandle.')
      await lens.waitFor()
      assert.equal(await lens.getByTestId('project-lens-summary').count(), 0)
      await assert.rejects(page.evaluate(({ root, reference }) => window.ion.projectLens.openReference(root, reference),
        { root, reference }), /Analyze the current folder|exact currently open folder/)
      await lens.getByTestId('project-lens-analyze').click()
      await lens.getByTestId('project-lens-summary').waitFor()
      assert.equal(await lens.getByText('React', { exact: true }).count(), 0)
      report.checks.workspaceChangeCancelsAndRejectsOldEvidence = 'passed'
      assert.equal(await exists(marker), false)
      assert.equal(await readFile(join(root, '.env'), 'utf8'), 'AUTH_TOKEN=' + secretSentinel)
      assert.deepEqual(session.requests, [], 'The workflow attempted a network request.')
      assert.deepEqual(session.errors, [], 'The real renderer reported an error.')
      const finalHandles = await observed()
      assert.equal(finalHandles.analyses, 0, 'A real native analysis was still pending.')
      assert.deepEqual(finalHandles.active, [], 'A manifest FileHandle remained open.')
      assert.equal(finalHandles.opened, finalHandles.closed, 'Manifest handle opens and successful closes differ.')
      report.observations.manifestHandlesOpened = finalHandles.opened
      report.observations.manifestHandlesClosed = finalHandles.closed
      report.checks.allManifestHandlesReleased = 'passed'
      report.checks.noNetworkAndOriginalSecretPreserved = 'passed'
      report.complete = true
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      if (session) {
        await session.app.evaluate(() => globalThis.ionProjectLensFixture.release?.()).catch(() => undefined)
        try {
          await close(session)
          report.cleanupVerified = session.appProcess.exitCode === 0 && session.appProcess.signalCode === null
          assert.equal(report.cleanupVerified, true, 'The disposable application did not shut down cleanly.')
        } catch (error) {
          report.cleanupVerified = false
          report.cleanupFailure = { name: error.name, messageSha256: digest(String(error.message)) }
          if (primaryError) throw new AggregateError([primaryError, error], 'Project Lens workload and shutdown both failed.')
          phase = 'shutdown'
          throw error
        }
      }
    }
  })
} catch (error) {
  failed = error
  report.complete = false
  // Keep failure identity without publishing local paths, file contents or stack traces.
  report.failure = { stage: phase, name: error.name, messageSha256: digest(String(error.message)) }
  if (error instanceof AggregateError) report.failures = error.errors.map(item => ({
    name: item?.name ?? 'Error', messageSha256: digest(String(item?.message ?? item)),
  }))
} finally {
  await mkdir(dirname(output), { recursive: true })
  const encoded = JSON.stringify(report, null, 2) + '\n'
  assert.ok(Buffer.byteLength(encoded) < 32 * 1024, 'Diagnostic receipt exceeded its bound.')
  await writeFile(output, encoded)
}
if (failed) {
  console.error('Project Lens native fixture failed during ' + phase + '; failure receipt: ' + output)
  throw failed
}
console.log('PASS native offline Project Lens scope, inert manifests, real read observation, references and lifecycle; receipt: ' + output)
