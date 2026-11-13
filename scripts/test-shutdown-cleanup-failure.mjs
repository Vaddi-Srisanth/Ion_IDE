import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { artifact, eventually, launch, stubDialogs, withScratch } from './desktop-harness.mjs'
import { processTree } from './development-workflow-fixtures.mjs'

// Only the requested owner's final failure and the recovery publication timing
// are injected. Electron, IPC, recovery serialization/fsync and quit stay real.
// This verifies lifecycle fault handling, not native Windows Job cleanup.
process.env.ION_SHOW_TEST_WINDOWS = '0'
const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  scenario: { type: 'string', default: 'all' },
  out: { type: 'string', default: 'performance-results/shutdown-cleanup-failure.json' },
} })
assert.ok(['all', 'quit', 'crash', 'update'].includes(values.scenario))
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use an unpackaged production build and a disposable profile.')
const entry = resolve(target.args[0])
const mainDirectory = dirname(entry)
const output = resolve(values.out)
const report = { complete: false, startedAt: new Date().toISOString(), platform: platform(), arch: arch(),
  target: target.path, mainSha256: createHash('sha256').update(await readFile(entry)).digest('hex'),
  kernelSha256: createHash('sha256').update(await readFile(join(mainDirectory, 'notebooks/kernel-service.cjs'))).digest('hex'),
  scope: 'Real hidden Electron shutdown/recovery/update orchestration with injected cleanup rejection; no native Windows verification.',
  cases: [] }

const events = async path => (await readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''
  throw error
})).split('\n').filter(Boolean).map(line => JSON.parse(line))
const alive = pid => {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
async function bounded(promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
function draftText(bytes, expectedId) {
  assert.ok(bytes.length >= 8)
  const headerLength = bytes.readUInt32BE(0)
  const bodyLength = bytes.readUInt32BE(4)
  assert.equal(bytes.length, 8 + headerLength + bodyLength)
  const header = JSON.parse(bytes.subarray(8, 8 + headerLength).toString('utf8'))
  assert.equal(header.version, 1)
  assert.equal(header.id, expectedId)
  return bytes.subarray(8 + headerLength).toString('utf8')
}

async function fixture(scratch, scenario) {
  const directory = join(scratch, scenario)
  const profile = join(directory, 'profile')
  const log = join(directory, 'events.ndjson')
  const notebook = join(directory, 'cleanup λ.ipynb')
  const id = randomUUID()
  const published = join(profile, 'recovery', id + '.draft')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
    settings: { resourceProfile: 'minimal', autoSave: false, openFullScreen: false,
      checkUpdatesOnLaunch: scenario === 'update' }, recents: [] }))
  await writeFile(notebook, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }))
  const suffix = platform() === 'win32' ? 'windows-x64-setup.exe' : `mac-${arch()}.dmg`
  const name = `Ion-IDE-0.10.0-${suffix}`
  const content = 'Lifecycle-only disposable update payload; no native installer is executed.'
  const data = { entry, profile, log, published, scenario, name, content,
    kernelModule: join(mainDirectory, 'notebooks/kernel-service.cjs'),
    nativeModule: join(mainDirectory, 'update-install.cjs'),
    digest: 'sha256:' + createHash('sha256').update(content).digest('hex') }
  const wrapper = join(directory, 'cleanup-failure-wrapper.cjs')
  await writeFile(wrapper, `
    const fs = require('node:fs');
    const promises = require('node:fs/promises');
    const { app } = require('electron');
    const data = ${JSON.stringify(data)};
    const record = (event, extra = {}) => fs.appendFileSync(data.log,
      JSON.stringify({ event, pid: process.pid, time: Date.now(), ...extra }) + '\\n');
    process.on('unhandledRejection', error => record('unhandled-rejection', {
      message: String(error?.message ?? error).slice(0, 500) }));
    const latch = globalThis.ionCleanupFailureFixture = { enabled: false, held: false, release: undefined };
    const rename = promises.rename;
    promises.rename = async (from, to) => {
      if (latch.enabled && String(to) === data.published && String(from).includes('.ion-recovery-')) {
        latch.held = true;
        record('recovery-held');
        await new Promise(resolve => { latch.release = resolve; });
        record('recovery-released');
      }
      const result = await rename(from, to);
      if (String(to) === data.published) record('recovery-published');
      return result;
    };
    const { NotebookKernels } = require(data.kernelModule);
    const dispose = NotebookKernels.prototype.dispose;
    NotebookKernels.prototype.dispose = async function () {
      record('kernel-dispose-enter');
      await dispose.call(this);
      record('kernel-dispose-reject');
      throw new Error('Injected notebook cleanup rejection');
    };
    app.on('browser-window-created', (_event, window) => {
      record('window-created');
      window.once('closed', () => record('window-closed'));
    });
    app.on('will-quit', () => record('will-quit'));
    process.on('exit', code => record('exit', { code }));
    if (data.scenario === 'update') {
      app.getVersion = () => '0.9.6';
      require.cache[data.nativeModule] = { id: data.nativeModule, filename: data.nativeModule, loaded: true,
        exports: { prepareUpdate: async () => {
          record('update-prepare');
          return { async start() { record('update-start'); }, async dispose() { record('update-dispose'); } };
        } } };
      const release = 'https://github.com/Vaddi-Srisanth/Ion_IDE/releases/download/v0.10.0/' + data.name;
      const asset = 'https://release-assets.githubusercontent.com/ion-cleanup-failure-fixture';
      globalThis.fetch = async input => {
        input = String(input);
        if (input === 'https://api.github.com/repos/Vaddi-Srisanth/Ion_IDE/releases/latest') return Response.json({
          tag_name: 'v0.10.0', draft: false, prerelease: false, assets: [
            { name: data.name, digest: data.digest, size: Buffer.byteLength(data.content), state: 'uploaded', browser_download_url: release },
          ],
        });
        if (input === release) return Response.redirect(asset);
        if (input === asset) return new Response(data.content);
        throw new Error('Unexpected network access in isolated cleanup fixture.');
      };
    }
    require(data.entry);
  `)
  return { profile, log, notebook, id, published, target: { ...target, args: [wrapper] } }
}

async function runCase(scratch, scenario) {
  const paths = await fixture(scratch, scenario)
  const result = { scenario, passed: false, cleanupVerified: false, forcedTeardown: false }
  report.cases.push(result)
  let session
  let owned = []
  try {
    session = await launch(paths.target, paths.profile)
    const { app, page, appProcess } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { file: paths.notebook })
    await page.getByTestId('welcome').getByTestId('open-file').click()
    await page.getByTestId('notebook-view').waitFor()
    const rejected = await page.evaluate(async path => {
      try { await window.ion.notebooks.run(path, {}); return 'unexpected success' }
      catch (error) { return String(error?.message ?? error) }
    }, paths.notebook)
    assert.match(rejected, /Invalid notebook execution request/)
    // The actual service was instantiated before request validation. No local
    // interpreter, native supervisor or notebook code is started by this test.
    if (scenario === 'update') {
      const button = page.getByTestId('title-update')
      await page.getByRole('button', { name: 'Update available', exact: true }).waitFor()
      await button.click()
      await page.getByRole('button', { name: 'Install and Restart', exact: true }).waitFor()
    }
    const previous = 'previous acknowledged revision λ'
    const latest = 'latest queued checkpoint survives cleanup failure λ\n'
    await page.evaluate(async ({ id, text }) => window.ion.recovery.write({ id, name: 'pending.txt', text }),
      { id: paths.id, text: previous })
    assert.equal(draftText(await readFile(paths.published), paths.id), previous)
    await page.evaluate(() => window.ion.updateSettings({ fontSize: 17 }))
    await app.evaluate(() => { globalThis.ionCleanupFailureFixture.enabled = true })
    await page.evaluate(({ id, text }) => {
      void window.ion.recovery.write({ id, name: 'pending.txt', text }).catch(() => {})
    }, { id: paths.id, text: latest })
    await eventually(() => app.evaluate(() => globalThis.ionCleanupFailureFixture.held), 'The real recovery rename was not held.')
    owned = (await processTree(session)).members.map(({ pid }) => pid)
    result.ownedPids = owned
    const exited = once(appProcess, 'exit')
    if (scenario === 'crash') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()).catch(() => {})
    } else if (scenario === 'update') {
      await page.getByRole('button', { name: 'Install and Restart', exact: true }).click()
    } else {
      void app.evaluate(({ app }) => app.quit()).catch(() => {})
    }
    await eventually(async () => (await events(paths.log)).some(event => event.event === 'kernel-dispose-reject'),
      'The actual notebook owner did not reach its injected disposal failure.')
    await sleep(200)
    assert.equal(appProcess.exitCode, null, 'Shutdown exited before the accepted checkpoint could finish.')
    assert.equal(appProcess.signalCode, null)
    assert.equal(draftText(await readFile(paths.published), paths.id), previous,
      'The completed checkpoint must remain intact while its replacement is held.')
    const heldEvents = await events(paths.log)
    assert.equal(heldEvents.filter(event => event.event === 'window-created').length, 1,
      'A replacement window must not start while cleanup is incomplete.')
    assert.equal(heldEvents.filter(event => event.event === 'will-quit').length, 0)
    await app.evaluate(() => globalThis.ionCleanupFailureFixture.release())
    assert.deepEqual(await bounded(exited, 6000, 'Cleanup rejection stranded shutdown after recovery publication.'), [0, null])
    result.events = await events(paths.log)
    assert.equal(result.events.filter(event => event.event === 'unhandled-rejection').length, 0,
      'Cleanup failure must be handled by the lifecycle owner.')
    assert.equal(result.events.filter(event => event.event === 'window-created').length, 1,
      'Failed cleanup must suppress an automatic crash replacement.')
    const publication = result.events.findLastIndex(event => event.event === 'recovery-published')
    const quit = result.events.findIndex(event => event.event === 'will-quit')
    assert.ok(publication >= 0 && quit > publication, 'The checkpoint must be published before final quit.')
    assert.equal(draftText(await readFile(paths.published), paths.id), latest)
    assert.deepEqual(await readdir(join(paths.profile, 'recovery')), [paths.id + '.draft'])
    assert.equal(JSON.parse(await readFile(join(paths.profile, 'preferences.json'), 'utf8')).settings.fontSize, 17)
    if (scenario === 'update') {
      assert.equal(result.events.filter(event => event.event === 'update-prepare').length, 1)
      assert.equal(result.events.filter(event => event.event === 'update-start').length, 0,
        'An update must never start after any cleanup owner rejects.')
      assert.equal(result.events.filter(event => event.event === 'update-dispose').length, 1)
    }
    assert.deepEqual(session.requests, [], 'The renderer must remain offline.')
    assert.deepEqual(session.errors, [])
    result.passed = true
    console.log(`PASS ${scenario}: cleanup rejection handled, queued recovery published, normal exit, no replacement${scenario === 'update' ? ', update refused and staging disposed' : ''}`)
  } catch (error) {
    result.error = error.stack ?? String(error)
    result.events = await events(paths.log)
    console.error(`FAIL ${scenario}: ${error.message}`)
  } finally {
    if (session) {
      const proc = session.appProcess
      if (proc.exitCode === null && proc.signalCode === null) {
        result.forcedTeardown = true
        const exited = once(proc, 'exit')
        // Test-only teardown of this exact disposable Electron owner. Never use
        // the installed application or infer a test pass from a forced exit.
        await session.app.evaluate(({ app }) => {
          globalThis.ionCleanupFailureFixture?.release?.()
          app.exit(79)
        }).catch(() => {})
        await bounded(exited, 4000, 'The failed disposable fixture could not exit.').catch(async error => {
          proc.kill('SIGKILL')
          await bounded(exited, 4000, error.message)
        })
      }
      await eventually(() => owned.every(pid => !alive(pid)), 'Owned disposable processes survived fixture teardown.')
      result.cleanupVerified = true
      result.exitCode = proc.exitCode
      result.signal = proc.signalCode
      result.events = await events(paths.log)
    }
  }
}

try {
  await withScratch('shutdown-cleanup-failure', async scratch => {
    for (const scenario of values.scenario === 'all' ? ['quit', 'crash', 'update'] : [values.scenario]) {
      await runCase(scratch, scenario)
    }
  })
  report.complete = report.cases.every(result => result.passed && result.cleanupVerified)
} catch (error) { report.error = error.stack ?? String(error) }
finally {
  report.finishedAt = new Date().toISOString()
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
if (!report.complete) process.exitCode = 1
