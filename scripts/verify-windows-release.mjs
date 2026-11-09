import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { editorShows, eventually, withScratch } from './desktop-harness.mjs'
import { verifyWindowsConsole, windowsInputFilename, windowsInputSource } from './verify-windows-run-console.mjs'

assert.equal(process.platform, 'win32', 'Use a disposable Windows machine for this installed-app test.')
assert.ok(process.env.LOCALAPPDATA && process.env.APPDATA)
const run = promisify(execFile)
const release = JSON.parse(await readFile('package.json', 'utf8'))
const setup = resolve(process.argv[2] ?? `release/Ion-IDE-${release.version}-windows-x64-setup.exe`)
const installDir = join(process.env.LOCALAPPDATA, 'Programs', 'Ion IDE')
const app = join(installDir, 'App', 'Ion IDE.exe')
const uninstaller = join(installDir, 'Uninstall.exe')
const shortcut = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Ion IDE.lnk')
const profile = join(process.env.APPDATA, 'Ion IDE')
const prefs = join(profile, 'preferences.json')
const present = (path) => lstat(path).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false
  throw error
})

for (const path of [installDir, shortcut, profile]) {
  assert.equal(await present(path), false, 'Use a disposable Windows machine without an existing Ion installation.')
}
const quiet = { windowsHide: true, timeout: 120_000 }

await withScratch('windows-release', async (scratch) => {
  const project = join(scratch, 'Release test workspace')
  const source = join(project, 'verify.txt')
  const inputProgram = join(project, windowsInputFilename)
  const original = 'Windows setup search marker'
  const edited = 'Saved by the installed Windows editor'
  const userFile = join(installDir, 'App', 'uninstall-preservation-test.txt')
  const portFile = join(profile, 'DevToolsActivePort')
  let child
  let browser
  let profileOwned = false
  try {
    await mkdir(project)
    await mkdir(profile)
    profileOwned = true
    await writeFile(source, original)
    await writeFile(inputProgram, windowsInputSource)
    await writeFile(prefs, JSON.stringify({
      version: 1,
      settings: { autoSave: false, openFullScreen: false },
      recents: [{ path: project, name: 'Release test workspace', kind: 'folder', lastOpened: 1 }],
    }))

    await run(setup, ['/S'], quiet)
    assert.equal(await present(app), true, 'installed executable exists')
    assert.equal(await present(shortcut), true, 'Start menu shortcut exists')
    const search = join(installDir, 'App', 'resources', 'ion-rg.exe')
    assert.match((await run(search, ['--version'], quiet)).stdout, /ripgrep/)

    child = spawn(app, ['--remote-debugging-port=0'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''
    let launchError
    child.stderr.setEncoding('utf8').on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000) })
    child.once('error', (error) => { launchError = error })
    let port
    await eventually(async () => {
      if (launchError) throw launchError
      assert.equal(child.exitCode, null, diagnostic || 'Installed Electron app exited during startup.')
      port = Number(await readFile(portFile, 'utf8').then((value) => value.split(/\r?\n/, 1)[0], () => ''))
      return port > 0
    }, 'Installed app never exposed its test debugging endpoint.', 20_000)
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10_000 })
    const context = browser.contexts()[0]
    const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15_000 })
    page.setDefaultTimeout(15_000)
    await page.getByTestId('welcome').waitFor()
    assert.equal(page.url(), 'app://workbench/index.html')
    await context.setOffline(true)
    await page.getByTestId('settings').click()
    const preferences = page.getByRole('dialog', { name: 'Preferences' })
    const updateOptIn = preferences.getByRole('checkbox', { name: /^Check for updates on launch/ })
    assert.equal(await updateOptIn.isChecked(), false, 'network checks start disabled')
    await updateOptIn.check()
    await eventually(async () => JSON.parse(await readFile(prefs, 'utf8')).settings.checkUpdatesOnLaunch === true,
      'Update opt-in was not saved.')
    await updateOptIn.uncheck()
    await eventually(async () => JSON.parse(await readFile(prefs, 'utf8')).settings.checkUpdatesOnLaunch === false,
      'Update opt-out was not saved.')
    await preferences.getByRole('button', { name: 'Done', exact: true }).click()
    await page.locator('.recent-entry').filter({ hasText: 'Release test workspace' }).click()
    await page.getByRole('button', { name: 'Search in Files', exact: true }).click()
    await page.getByTestId('workspace-search-input').fill(original)
    await page.getByRole('button', { name: /verify\.txt, line 1/ }).click()
    await (await editorShows(page, original)).dispose()
    await page.locator('.monaco-editor .view-line').first().click({ position: { x: 8, y: 7 } })
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText(edited)
    await (await editorShows(page, edited)).dispose()
    assert.equal(await readFile(source, 'utf8'), original, 'manual save did not run before the save command')
    await page.getByTestId('save-file').click()
    await eventually(async () => await readFile(source, 'utf8') === edited, 'The installed editor did not save the file.')
    await page.getByTestId('close-tab').click()
    await page.getByTestId('explorer-entry').filter({ hasText: 'verify.txt' }).click()
    await (await editorShows(page, edited)).dispose()
    console.log('PASS silent install, Start menu shortcut, bundled search, and offline open/edit/save/reopen.')

    await verifyWindowsConsole(page, child.pid)
    console.log('PASS update opt-in persists.')

    const exited = once(child, 'exit')
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `if (!(Get-Process -Id ${child.pid}).CloseMainWindow()) { exit 1 }`], quiet)
    const exit = await Promise.race([exited, sleep(8000, undefined, { ref: false })])
    assert.deepEqual(exit, [0, null], 'Installed app exited cleanly.')
    await writeFile(userFile, 'preserve unowned files')
    await run(uninstaller, ['/S'], quiet)
    await eventually(async () => !(await present(app)) && !(await present(shortcut)) && !(await present(uninstaller)),
      'The uninstaller left its program files or Start menu shortcut behind.', 20_000)
    assert.equal(await readFile(source, 'utf8'), edited, 'uninstall preserved the saved source file')
    assert.equal(await readFile(userFile, 'utf8'), 'preserve unowned files')
    assert.equal(JSON.parse(await readFile(prefs, 'utf8')).settings.autoSave, false)
    await rm(userFile)
    await rmdir(join(installDir, 'App'))
    await rmdir(installDir)
    console.log('PASS quiet uninstall preserved the saved workspace, unknown files and Ion preferences.')
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], quiet).catch(() => {})
    }
    if (browser) await Promise.race([browser.close().catch(() => {}), sleep(3000, undefined, { ref: false })])
    await rm(userFile, { force: true })
    if (await present(uninstaller)) {
      await run(uninstaller, ['/S'], quiet).catch(() => {})
      await eventually(async () => !(await present(installDir)), 'Could not clean up the disposable install.', 20_000)
    }
    if (profileOwned) await rm(profile, { recursive: true, force: true, maxRetries: 5 })
  }
})
