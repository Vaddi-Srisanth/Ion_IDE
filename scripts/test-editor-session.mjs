import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { artifact, atPath, close, createProject, desktopWindowsVisible, editorShows, eventually, launch, openFolder, openFromExplorer,
  stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const execute = promisify(execFile)

async function launchSession(profile) {
  const session = await launch(target, profile)
  if (process.platform !== 'darwin' || !desktopWindowsVisible()) return session
  // Drive the renderer through Playwright without allowing host keyboard
  // input to modify the disposable files while the fixture runs.
  try {
    await eventually(() => session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
      'The test window did not finish its initial show.')
    await session.app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window.webContents.setBackgroundThrottling(false)
      window.hide()
    })
    return session
  } catch (error) {
    await terminateIfRunning(session.app.process())
    throw error
  }
}

async function quitWithDrafts(session, action) {
  const process = session.app.process()
  const quitting = close(session)
  const settled = quitting.catch(() => undefined)
  try {
    const prompt = session.page.getByRole('dialog', { name: 'Unsaved changes' })
    await prompt.getByRole('button', { name: action, exact: true }).click()
    await quitting
    assert.equal(process.exitCode, 0, 'Graceful session quit exited cleanly.')
  } catch (error) {
    throw new Error('The editor session could not quit using ' + action + '.', { cause: error })
  } finally {
    await settled
  }
}

async function terminateIfRunning(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  // Successful paths already verify their intended exit. A failed assertion
  // can leave dirty files open, so cleanup must never wait for an unanswered prompt.
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'The owned test process has no valid PID.')
  const observation = new AbortController()
  const exited = once(child, 'exit', { signal: observation.signal })
  // If native termination fails, disposing the observation must not create an
  // unhandled rejection or retain listeners on a still-live disposable process.
  void exited.catch(() => {})
  try {
    if (process.platform === 'win32') {
      // Killing only Electron main leaves Chromium children holding this exact
      // disposable profile's databases across the intentional crash/reopen.
      await execute(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 })
        .catch(error => {
          if (child.exitCode === null && child.signalCode === null) throw error
        })
    } else child.kill('SIGKILL')
    await exited
  } finally { observation.abort() }
}

async function goToLine(page, line) {
  await page.getByTestId('command-palette').click()
  await page.getByTestId('command-palette-input').fill('Go to Line')
  await page.getByRole('option', { name: /^Go to Line/ }).click()
  await page.getByTestId('goto-line-input').fill(String(line))
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByText(`Ln ${line}, Col 1`, { exact: true }).waitFor()
}

await withScratch('editor-session', async (scratch) => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const profile = join(scratch, 'profile')
  const anchor = join(project.directory, 'anchor.txt')
  const missing = join(project.directory, 'missing.txt')
  const named = join(project.directory, 'named.txt')
  const notebook = join(project.directory, 'notes.ipynb')
  const external = join(scratch, 'outside.txt')
  const savedLines = Array.from({ length: 250 }, (_, index) => 'alpha-' + (index + 1)).join('\n')
  const edited = 'kept draft λ'
  await mkdir(profile)
  await Promise.all([
    writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { autoSave: false } })),
    writeFile(anchor, savedLines),
    writeFile(missing, 'replace this file'),
    writeFile(named, 'initial named version'),
    writeFile(notebook, JSON.stringify({
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [{ id: 'notes-cell', cell_type: 'markdown', metadata: {}, source: ['Ion notebook session'] }],
    }, null, 2)),
    writeFile(external, 'private file'),
  ])

  const first = await launchSession(profile)
  const firstProcess = first.app.process()
  try {
    const { app, page } = first
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await openFromExplorer(page, anchor, 'alpha-1')
    await openFromExplorer(page, missing, 'replace this file')
    await atPath(page, 'explorer-entry', notebook).click()
    await page.getByTestId('notebook-open-json').click()
    await editorShows(page, '"nbformat"')
    await openFromExplorer(page, named, 'initial named version')
    await page.keyboard.press(modifier + '+a')
    await page.keyboard.insertText(edited)
    await editorShows(page, edited)
    await atPath(page, 'tab', anchor).getByRole('button', { name: 'anchor.txt', exact: true }).click()
    await editorShows(page, 'alpha-1')
    await goToLine(page, 140)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.getByText('Ln 140, Col 4', { exact: true }).waitFor()
    assert.deepEqual(first.errors, [])
    await quitWithDrafts(first, 'Keep Drafts and Quit')
  } finally {
    await terminateIfRunning(firstProcess)
  }

  assert.equal(await readFile(named, 'utf8'), 'initial named version')
  await writeFile(named, 'new disk content')
  await rm(missing)
  await symlink(external, missing)
  assert.equal(await realpath(missing), external)
  const snapshotPath = join(profile, 'editor-session.json')
  const kept = JSON.parse(await readFile(snapshotPath, 'utf8'))
  assert.equal(kept.rootPath, project.directory)
  assert.deepEqual(kept.tabs.map(({ path }) => path), [anchor, missing, notebook, named])
  assert.equal(kept.tabs[kept.activeIndex].path, anchor)
  const keptView = kept.tabs[kept.activeIndex].view
  assert.ok(keptView.scrollTop > 0)
  assert.deepEqual(keptView.selections, [{
    selectionStartLineNumber: 140, selectionStartColumn: 1, positionLineNumber: 140, positionColumn: 4,
  }])
  assert.deepEqual(kept.tabs.filter(({ draftId }) => draftId).map(({ path }) => path), [named])

  const second = await launchSession(profile)
  const secondProcess = second.app.process()
  try {
    const { page } = second
    await page.context().setOffline(true)
    await page.getByTestId('resume-session').click()
    await page.getByTestId('workspace').waitFor()
    assert.deepEqual(await page.getByTestId('tab').locator('.tab-name').allTextContents(), ['anchor.txt', 'notes.ipynb', 'named.txt'])
    assert.equal(await atPath(page, 'tab', anchor).locator('.tab-name').getAttribute('aria-current'), 'true')
    await (await editorShows(page, 'alpha-140')).dispose()
    const status = page.locator('.document-status')
    const cursor = status.getByText('Ln 140, Col 4', { exact: true })
    await cursor.waitFor().catch(async (error) => {
      const actual = await status.textContent({ timeout: 500 }).catch(() => null)
      throw new Error('Resumed cursor did not reach line 140, column 4. Document status was ' + JSON.stringify(actual), { cause: error })
    })
    await page.keyboard.insertText('XYZ')
    await editorShows(page, 'XYZha-140')
    assert.equal(await readFile(anchor, 'utf8'), savedLines)
    const namedTab = page.getByTestId('tab').filter({ has: page.getByRole('button', { name: 'named.txt', exact: true }) })
    assert.equal(await namedTab.getAttribute('data-path'), null)
    assert.match(await namedTab.getByTestId('close-tab').getAttribute('class'), /\btab-dirty\b/)
    await namedTab.getByRole('button', { name: 'named.txt', exact: true }).click()
    await editorShows(page, edited)
    assert.equal(await readFile(named, 'utf8'), 'new disk content')
    await atPath(page, 'tab', notebook).locator('.tab-name').click()
    await editorShows(page, '"nbformat"')
    await eventually(async () => {
      const stored = JSON.parse(await readFile(snapshotPath, 'utf8'))
      return stored.tabs[stored.activeIndex]?.name === 'notes.ipynb' &&
        await page.evaluate(async () => (await window.ion.recovery.list()).length === 2)
    }, 'The live session and recovery drafts must be checkpointed before a crash.')
    assert.deepEqual(second.errors, [])
    assert.deepEqual(second.requests, [])
    await terminateIfRunning(secondProcess)
    if (process.platform !== 'win32') assert.equal(secondProcess.signalCode, 'SIGKILL')
  } finally {
    await terminateIfRunning(secondProcess)
  }

  const third = await launchSession(profile)
  const thirdProcess = third.app.process()
  try {
    const { page } = third
    await page.context().setOffline(true)
    await page.getByTestId('resume-session').click()
    await editorShows(page, '"nbformat"')
    const tabs = page.getByTestId('tab')
    assert.deepEqual(await tabs.locator('.tab-name').allTextContents(), ['anchor.txt', 'notes.ipynb', 'named.txt'])
    assert.equal(await tabs.nth(1).locator('.tab-name').getAttribute('aria-current'), 'true')
    await tabs.last().getByRole('button', { name: 'named.txt', exact: true }).click()
    await editorShows(page, edited)
    await tabs.first().getByRole('button', { name: 'anchor.txt', exact: true }).click()
    await editorShows(page, 'XYZha-140')
    assert.equal(await readFile(anchor, 'utf8'), savedLines)
    await quitWithDrafts(third, 'Discard')
    console.log('PASS clean relaunch and abrupt exit restore ordered tabs, active tab, cursor, selection, scroll, workspace, and detached unsaved drafts.')
  } finally {
    await terminateIfRunning(thirdProcess)
  }
})
