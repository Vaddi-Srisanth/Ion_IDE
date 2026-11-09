import assert from 'node:assert/strict'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, close, eventually, launch, withScratch } from './desktop-harness.mjs'

if (process.platform !== 'darwin') {
  console.log('SKIP native macOS full-screen startup')
  process.exit(0)
}

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)

function expectWindowMode(app, fullScreen, message) {
  return eventually(() => app.evaluate(({ BrowserWindow }, expected) => {
    const window = BrowserWindow.getAllWindows()[0]
    return window?.isVisible() && window.isFullScreen() === expected
  }, fullScreen), message)
}

function startupPreference(page) {
  return page.evaluate(async () => (await window.ion.getPreferences()).settings.openFullScreen)
}

async function updateStartupPreference(page, fullScreen) {
  await page.getByTestId('settings').first().click()
  const preferences = page.getByRole('dialog', { name: 'Preferences' })
  await preferences.getByRole('checkbox', { name: /Open in full screen/i }).setChecked(fullScreen)
  await eventually(async () => await startupPreference(page) === fullScreen, 'Startup preference was not saved.')
  await preferences.getByRole('button', { name: 'Done' }).click()
}

await withScratch('window-startup', async (scratch) => {
  const profile = join(scratch, 'profile')
  let session = await launch(target, profile)
  try {
    await expectWindowMode(session.app, false, 'A fresh profile did not start in a regular window.')
    assert.equal(await startupPreference(session.page), false)
    await updateStartupPreference(session.page, true)
    await expectWindowMode(session.app, false, 'Updating the startup preference changed the current window.')
    await close(session)

    session = await launch(target, profile)
    await expectWindowMode(session.app, true, 'Ion did not open in native full screen after relaunch.')
    await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false))
    await expectWindowMode(session.app, false, 'The app did not exit native full screen.')
    assert.equal(await startupPreference(session.page), true, 'Leaving full screen changed the startup preference.')
    await updateStartupPreference(session.page, false)
    await close(session)

    session = await launch(target, profile)
    await expectWindowMode(session.app, false, 'Ion did not return to a regular window on relaunch.')
    assert.equal(await startupPreference(session.page), false)
    console.log('PASS native macOS full-screen launch, temporary exit, and preference changes across relaunches')
  } finally {
    await close(session)
  }
})
