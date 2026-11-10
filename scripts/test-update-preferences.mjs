import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { artifact, close, eventually, launch, withScratch } from './desktop-harness.mjs'

const target = await artifact('dist')
const prefs = (path) => join(path, 'preferences.json')
async function openUpdates(page) {
  await page.getByTestId('settings').first().click()
  const dialog = page.getByRole('dialog', { name: 'Preferences' })
  const checkbox = dialog.getByRole('checkbox', { name: /^Check for updates on launch/ })
  await eventually(() => checkbox.isEnabled(), 'The update preference never finished loading.')
  return { dialog, checkbox }
}

async function closeUpdates(session) {
  const dialog = session.page.getByRole('dialog', { name: 'Preferences' })
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await close(session)
}

await withScratch('update-preferences', async (scratch) => {
  const healthy = join(scratch, 'healthy')
  const unsupported = join(scratch, 'unsupported')
  await Promise.all([mkdir(healthy), mkdir(unsupported)])
  const existing = '{"version":999,"settings":{"checkUpdatesOnLaunch":false}}\n'
  await writeFile(prefs(unsupported), existing)
  const good = await launch(target, healthy)
  try {
    await good.page.context().setOffline(true)
    const { checkbox } = await openUpdates(good.page)
    assert.equal(await checkbox.isChecked(), false)
    for (const enabled of [true, false]) {
      await checkbox.click()
      await eventually(async () => await checkbox.isEnabled() && await checkbox.isChecked() === enabled,
        'The update preference did not acknowledge the saved value.')
      assert.equal(JSON.parse(await readFile(prefs(healthy), 'utf8')).settings.checkUpdatesOnLaunch, enabled)
    }
    assert.deepEqual(good.requests, [])
    console.log('PASS the real update preference acknowledges both saved values without contacting GitHub')
  } finally {
    await closeUpdates(good)
  }
  const broken = await launch(target, unsupported)
  try {
    await broken.page.context().setOffline(true)
    const { checkbox, dialog } = await openUpdates(broken.page)
    await checkbox.click()
    await dialog.getByRole('alert').filter({ hasText: 'Could not save the update preference' }).waitFor()
    assert.equal(await checkbox.isChecked(), false)
    assert.equal(await readFile(prefs(unsupported), 'utf8'), existing)
    console.log('PASS an unreadable preference format keeps the previous choice and exposes the save error')
  } finally {
    await closeUpdates(broken)
  }
})

await withScratch('title-update', async (scratch) => {
  const downloads = join(scratch, 'Downloads')
  await mkdir(downloads)
  const suffix = platform() === 'win32' ? 'windows-x64-setup.exe' : `mac-${arch()}.dmg`
  const name = 'Ion-IDE-0.10.0-' + suffix
  const content = 'disposable installer bytes'
  const fixture = {
    name, content, downloads, entry: target.args[0],
    digest: 'sha256:' + createHash('sha256').update(content).digest('hex'),
  }
  const entry = join(scratch, 'update-fixture.cjs')
  await writeFile(entry, `
    const { app, shell } = require('electron');
    const { name, content, downloads, entry, digest } = ${JSON.stringify(fixture)};
    app.setPath('downloads', downloads);
    app.getVersion = () => '0.9.5';
    shell.showItemInFolder = () => {};
    const release = 'https://github.com/Vaddi-Srisanth/Ion_IDE/releases/download/v0.10.0/' + name;
    const asset = 'https://release-assets.githubusercontent.com/ion-fixture';
    globalThis.ionUpdateRequests = [];
    globalThis.fetch = async (input) => {
      input = String(input);
      globalThis.ionUpdateRequests.push(input);
      if (input === 'https://api.github.com/repos/Vaddi-Srisanth/Ion_IDE/releases/latest') {
        return Response.json({ tag_name: 'v0.10.0', draft: false, prerelease: false, assets: [
          { name, digest, size: Buffer.byteLength(content), state: 'uploaded', browser_download_url: release },
        ] });
      }
      if (input === release) return Response.redirect(asset);
      if (input === asset) {
        const bytes = await new Promise((resolve) => { globalThis.ionSendInstaller = resolve; });
        return new Response(bytes);
      }
      throw new Error('Unexpected request in updater fixture: ' + input);
    };
    require(entry);
  `)
  const appTarget = { ...target, args: [entry] }
  const optedIn = join(scratch, 'automatic')
  await mkdir(optedIn)
  await writeFile(prefs(optedIn), '{"version":1,"settings":{"checkUpdatesOnLaunch":true},"recents":[]}\n')
  const automatic = await launch(appTarget, optedIn)
  try {
    const badge = automatic.page.getByRole('button', { name: 'Update available', exact: true })
    await badge.waitFor()
    assert.equal(await badge.locator('xpath=ancestor::header[contains(@class, "titlebar")]').count(), 1)
    assert.equal((await automatic.app.evaluate(() => globalThis.ionUpdateRequests)).length, 1)
    assert.deepEqual(await readdir(downloads), [])
    console.log('PASS the opted-in launch shows a quiet update button without downloading')
  } finally {
    await close(automatic)
  }

  const manual = await launch(appTarget, join(scratch, 'manual'))
  try {
    const { app, page } = manual
    const badge = page.getByTestId('title-update')
    const { dialog } = await openUpdates(page)
    await dialog.getByText('Ion 0.9.5', { exact: true }).waitFor()
    assert.equal(await badge.count(), 0)
    assert.deepEqual(await app.evaluate(() => globalThis.ionUpdateRequests), [])
    await dialog.getByRole('button', { name: 'Check for Updates' }).click()
    await dialog.getByRole('button', { name: 'Download Update', exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: 'Update available', exact: true }).waitFor()

    const sendInstaller = async (bytes) => {
      await eventually(() => app.evaluate(() => Boolean(globalThis.ionSendInstaller)), 'The installer request never reached GitHub.')
      await app.evaluate((_, body) => {
        globalThis.ionSendInstaller(body)
        delete globalThis.ionSendInstaller
      }, bytes)
    }
    await badge.click()
    await eventually(() => badge.isDisabled(), 'The download did not lock the title bar button.')
    await sendInstaller('corrupt')
    await page.getByTestId('status').getByRole('alert').filter({ hasText: 'checksum' }).waitFor()
    assert.deepEqual(await readdir(downloads), [])
    await badge.click()
    await sendInstaller(content)
    await page.getByRole('button', { name: 'Update downloaded', exact: true }).waitFor()
    const [directory] = await readdir(downloads)
    assert.match(directory, /^Ion Update /)
    assert.deepEqual(await readdir(join(downloads, directory)), [name])
    assert.equal(await readFile(join(downloads, directory, name), 'utf8'), content)
    await badge.click()
    await dialog.getByRole('status').filter({ hasText: 'is ready in Downloads' }).waitFor()
    assert.equal((await app.evaluate(() => globalThis.ionUpdateRequests)).length, 5)
    console.log('PASS the title-bar download rejects corrupt bytes, retries, and saves the verified installer')
  } finally {
    await closeUpdates(manual)
  }
})
