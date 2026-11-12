import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { artifact, close, editorShows, eventually, launch, withScratch } from './desktop-harness.mjs'

// This check never raises native windows, including on otherwise-visible CI.
process.env.ION_SHOW_TEST_WINDOWS = '0'
const target = await artifact('dist')
assert.ok(!target.path.endsWith('.app'), 'Use the built production files for the isolated native-helper boundary.')
const modifier = platform() === 'darwin' ? 'Meta' : 'Control'

async function events(path) {
  return (await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })).split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function exited(session, action) {
  const process = session.appProcess
  const exit = once(process, 'exit')
  let timer
  try {
    await action()
    assert.deepEqual(await Promise.race([exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The update lifecycle did not exit normally within 12 seconds.')), 12000)
    })]), [0, null], 'Ion exited normally without a forced termination.')
  } finally { clearTimeout(timer) }
}

async function fixture(scratch, scenario, marker = '') {
  const directory = join(scratch, scenario)
  const profile = join(directory, 'profile')
  const log = join(directory, 'lifecycle.ndjson')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
    settings: { checkUpdatesOnLaunch: true, autoSave: false, openFullScreen: false }, recents: [] }) + '\n')
  const suffix = platform() === 'win32' ? 'windows-x64-setup.exe' : `mac-${arch()}.dmg`
  const name = `Ion-IDE-0.10.0-${suffix}`
  const content = 'Disposable update payload; native installation is tested separately.'
  const data = { profile, log, marker, name, content, expectedFontSize: marker ? 17 : undefined, entry: target.args[0],
    nativeModule: join(dirname(target.args[0]), 'update-install.cjs'),
    digest: 'sha256:' + createHash('sha256').update(content).digest('hex') }
  const entry = join(directory, 'lifecycle-fixture.cjs')
  await writeFile(entry, `
    const fs = require('node:fs');
    const path = require('node:path');
    const { app, BrowserWindow } = require('electron');
    const data = ${JSON.stringify(data)};
    const record = (event, extra = {}) => fs.appendFileSync(data.log,
      JSON.stringify({ event, pid: process.pid, time: Date.now(), ...extra }) + '\\n');
    app.getVersion = () => '0.9.6';
    globalThis.ionDeferUpdatePrepare = false;
    globalThis.ionUpdateFixtureCounts = { prepares: 0, starts: 0, disposes: 0 };
    const counts = globalThis.ionUpdateFixtureCounts;
    require.cache[data.nativeModule] = { id: data.nativeModule, filename: data.nativeModule, loaded: true,
      exports: { prepareUpdate: async () => {
        const id = ++counts.prepares;
        record('prepare', { id });
        let disposed = false;
        const prepared = {
          async start() {
            if (disposed) throw new Error('A disposed prepared update cannot be started.');
            const recovery = path.join(data.profile, 'recovery');
            const drafts = fs.existsSync(recovery) ? fs.readdirSync(recovery).filter(name => name.endsWith('.draft')) : [];
            const recoveredDraft = drafts.some(name => {
              const bytes = fs.readFileSync(path.join(recovery, name));
              if (bytes.length < 8) return false;
              const headerLength = bytes.readUInt32BE(0);
              const bodyLength = bytes.readUInt32BE(4);
              if (bytes.length !== 8 + headerLength + bodyLength) return false;
              const header = JSON.parse(bytes.subarray(8, 8 + headerLength).toString('utf8'));
              return header.version === 1 && bytes.subarray(8 + headerLength).toString('utf8') === data.marker;
            });
            const windows = BrowserWindow.getAllWindows().length;
            const fontSize = JSON.parse(fs.readFileSync(path.join(data.profile, 'preferences.json'), 'utf8')).settings.fontSize;
            if (data.marker && !recoveredDraft) throw new Error('The real recovery draft was not committed before handoff.');
            if (data.expectedFontSize !== undefined && fontSize !== data.expectedFontSize) throw new Error('Queued preference writes were not drained before handoff.');
            if (windows) throw new Error('The editor window had not closed before handoff.');
            counts.starts++;
            record('start', { id, recoveredDraft, windows, fontSize });
          },
          async dispose() { disposed = true; counts.disposes++; record('dispose', { id }); },
        };
        if (globalThis.ionDeferUpdatePrepare) await new Promise(resolve => { globalThis.ionReleaseUpdatePrepare = resolve; });
        return prepared;
      } },
    };
    const release = 'https://github.com/Vaddi-Srisanth/Ion_IDE/releases/download/v0.10.0/' + data.name;
    const asset = 'https://release-assets.githubusercontent.com/ion-lifecycle-fixture';
    globalThis.fetch = async input => {
      input = String(input);
      if (input === 'https://api.github.com/repos/Vaddi-Srisanth/Ion_IDE/releases/latest') return Response.json({
        tag_name: 'v0.10.0', draft: false, prerelease: false, assets: [
          { name: data.name, digest: data.digest, size: Buffer.byteLength(data.content), state: 'uploaded', browser_download_url: release },
        ],
      });
      if (input === release) return Response.redirect(asset);
      if (input === asset) return new Response(data.content);
      throw new Error('Unexpected network request in the lifecycle fixture.');
    };
    app.on('will-quit', () => record('will-quit'));
    process.on('exit', code => record('exit', { code }));
    require(data.entry);
  `)
  return { profile, log, target: { ...target, args: [entry] } }
}

async function downloaded(session) {
  await session.page.context().setOffline(true)
  const button = session.page.getByTestId('title-update')
  await session.page.getByRole('button', { name: 'Update available', exact: true }).waitFor()
  await button.click()
  await session.page.getByRole('button', { name: 'Install and Restart', exact: true }).waitFor()
  assert.deepEqual(session.requests, [], 'The renderer made no internet requests.')
  return button
}

await withScratch('update-lifecycle', async scratch => {
  const marker = 'ION-UPDATE-UNSAVED-λ'
  const first = await fixture(scratch, 'dirty-cancel-retry', marker)
  const session = await launch(first.target, first.profile)
  try {
    const button = await downloaded(session)
    const { app, page } = session
    await page.getByTestId('new-file').first().click()
    await page.getByTestId('editor').locator('.view-line').first().click()
    await page.keyboard.press(modifier + '+a')
    await page.keyboard.insertText(marker)
    await (await editorShows(page, marker)).dispose()

    await button.click()
    const confirmation = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
    await confirmation.waitFor()
    assert.equal(session.appProcess.exitCode, null)
    assert.deepEqual(await app.evaluate(() => globalThis.ionUpdateFixtureCounts), { prepares: 1, starts: 0, disposes: 0 })
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await confirmation.waitFor({ state: 'detached' })
    await eventually(async () => (await events(first.log)).filter(item => item.event === 'dispose').length === 1,
      'Cancel did not dispose of the prepared native update.')
    await page.getByRole('button', { name: 'Install and Restart', exact: true }).waitFor()
    await (await editorShows(page, marker)).dispose()
    assert.equal((await events(first.log)).filter(item => item.event === 'start').length, 0)
    console.log('PASS Install and Restart uses the real unsaved-changes dialog; Cancel disposes preparation and preserves editor text.')

    await exited(session, async () => {
      await button.click()
      await confirmation.waitFor()
      // Queue real serialized, synced preference writes immediately before
      // confirming quit; do not mock the filesystem or its drain operation.
      await page.evaluate(() => {
        for (let index = 0; index < 32; index++) void window.ion.updateSettings({ fontSize: 14 + index % 4 }).catch(() => {})
      })
      await confirmation.getByRole('button', { name: 'Keep Drafts and Quit', exact: true }).click()
    })
    const completed = await events(first.log)
    assert.equal(completed.filter(item => item.event === 'prepare').length, 2)
    assert.equal(completed.filter(item => item.event === 'dispose').length, 1)
    assert.deepEqual(completed.filter(item => item.event === 'start').map(({ recoveredDraft, windows }) => ({ recoveredDraft, windows })),
      [{ recoveredDraft: true, windows: 0 }])
    assert.equal(completed.find(item => item.event === 'start').fontSize, 17)
    assert.ok(completed.findIndex(item => item.event === 'start') < completed.findIndex(item => item.event === 'will-quit'))
    assert.deepEqual(completed.at(-1).event, 'exit')
    assert.equal(completed.at(-1).code, 0)
    assert.deepEqual(session.errors, [])
    console.log('PASS retry commits the actual recovery draft, closes the editor, hands off exactly once and exits normally.')
  } finally { await close(session) }

  const restored = await launch(first.target, first.profile)
  try {
    const { app, page } = restored
    await page.context().setOffline(true)
    await page.getByTestId('recover-edits').click()
    await page.getByRole('dialog', { name: 'Recover unsaved edits', exact: true })
      .getByRole('button', { name: 'Restore Drafts', exact: true }).click()
    await (await editorShows(page, marker)).dispose()
    await exited(restored, async () => {
      void app.evaluate(({ app }) => app.quit()).catch(() => {})
      await page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
        .getByRole('button', { name: 'Discard', exact: true }).click()
    })
    assert.deepEqual(restored.errors, [])
    console.log('PASS a new Electron session restores the exact unsaved draft from the real local recovery files.')
  } finally { await close(restored) }

  const second = await fixture(scratch, 'close-during-prepare')
  const preparing = await launch(second.target, second.profile)
  try {
    const button = await downloaded(preparing)
    const { app, page } = preparing
    await app.evaluate(() => { globalThis.ionDeferUpdatePrepare = true })
    await button.click()
    await eventually(() => app.evaluate(() => globalThis.ionUpdateFixtureCounts.prepares === 1),
      'The asynchronous preparation did not begin.')
    const duplicate = await page.evaluate(async () => {
      try { await window.ion.updates.install(); return 'unexpected success' }
      catch (error) { return String(error?.message ?? error) }
    })
    assert.match(duplicate, /already being prepared/)
    assert.equal((await events(second.log)).filter(item => item.event === 'prepare').length, 1)
    await exited(preparing, async () => {
      void app.evaluate(({ app }) => app.quit()).catch(() => {})
      await eventually(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 0),
        'The normal close request did not close the clean editor.')
      assert.equal(preparing.appProcess.exitCode, null, 'Shutdown waits for its still-owned preparation.')
      void app.evaluate(() => { globalThis.ionReleaseUpdatePrepare() }).catch(() => {})
    })
    const completed = await events(second.log)
    assert.equal(completed.filter(item => item.event === 'prepare').length, 1)
    assert.equal(completed.filter(item => item.event === 'dispose').length, 1)
    assert.equal(completed.filter(item => item.event === 'start').length, 0)
    assert.ok(completed.findIndex(item => item.event === 'dispose') < completed.findIndex(item => item.event === 'will-quit'))
    assert.deepEqual(preparing.errors, [])
    console.log('PASS duplicate requests do not duplicate preparation; closing during preparation awaits disposal and never installs.')
  } finally { await close(preparing) }
})
