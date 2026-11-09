import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
    await close(good)
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
    await close(broken)
  }
})
