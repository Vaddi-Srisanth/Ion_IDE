import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  runProgram, stubDialogs, waitForFile, withScratch,
} from './desktop-harness.mjs'

const { values: options } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  screenshots: { type: 'string' },
  help: { type: 'boolean' },
} })
if (options.help) {
  console.log('npm run test:desktop -- [--target dist] [--screenshots performance-results/screenshots]')
  process.exit(0)
}

const target = await artifact(options.target)
const screenshots = options.screenshots ? resolve(options.screenshots) : null
if (screenshots) await mkdir(screenshots, { recursive: true })

async function screenshot(page, name) {
  if (screenshots) await page.screenshot({ path: join(screenshots, name + '.png') })
}

async function replaceEditor(page, text) {
  await page.locator('.monaco-editor .view-line').first().click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.insertText(text.endsWith('\n') ? text.slice(0, -1) : text)
  if (text.endsWith('\n')) await page.keyboard.press('Enter')
}

async function expectOutput(page, expression) {
  await page.getByTestId('output').filter({ hasText: expression }).waitFor({ timeout: 15_000 })
}

async function dragSeparator(page, name, dx, dy) {
  const handle = page.getByRole('separator', { name })
  const bounds = await handle.boundingBox()
  assert.ok(bounds, `Expected a visible ${name} divider`)
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await page.mouse.up()
}

await withScratch('smoke', async (scratch) => {
  const project = await createProject(join(scratch, 'project'))
  const profile = join(scratch, 'profile')
  const save = join(project.directory, 'new-note.txt')
  const outside = join(scratch, 'outside.txt')
  const inputProgram = join(project.directory, 'input.c')
  await Promise.all([mkdir(profile), writeFile(outside, 'inaccessible'), writeFile(inputProgram,
    '#include <stdio.h>\nint main(void) { char input[80]; if (!fgets(input, sizeof input, stdin)) return 1; puts(input); return 0; }\n')])
  const choices = { folder: project.directory, file: project.files[0], save, allowRun: true }
  const first = await launch(target, profile)
  let completed = false
  try {
    const { app, page } = first
    const webPreferences = await app.evaluate(({ BrowserWindow }) => {
      const { sandbox, contextIsolation, nodeIntegration } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { sandbox, contextIsolation, nodeIntegration }
    })
    assert.deepEqual(webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false })
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    await stubDialogs(app, choices)
    await screenshot(page, 'welcome-dark')

    await openFolder(page, project)
    const denial = await page.evaluate(async (path) => {
      try { await window.ion.readFile(path); return false } catch { return true }
    }, outside)
    assert.equal(denial, true, 'renderer read outside project authorization rejected')
    await openFromExplorer(page, project.files[0], 'Ion fixture notes-00.txt')
    const content = 'Editor autosave is real.\n'
    await replaceEditor(page, content)
    await editorShows(page, content.trim())
    await waitForFile(readFile, project.files[0], content)
    console.log('PASS folder open, Monaco edits, autosave and IPC path scoping')

    await openFromExplorer(page, project.files[1], 'Ion fixture notes-01.txt')
    assert.equal(await page.getByTestId('tab').count(), 2)
    await atPath(page, 'tab', project.files[0]).locator('.tab-name').click()
    await editorShows(page, content.trim())
    await page.locator('.monaco-editor .view-line').first().click()
    await page.keyboard.press('Meta+f')
    const find = page.locator('.monaco-editor .find-widget')
    await find.waitFor()
    await page.keyboard.insertText('autosave')
    await find.getByText(/1 of 1|1 match/i).waitFor()
    await find.getByRole('button', { name: 'Toggle Replace' }).click()
    await find.locator('.replace-part textarea').fill('autosaved')
    await find.getByRole('button', { name: /Replace All/ }).click()
    await page.keyboard.press('Escape')
    await waitForFile(readFile, project.files[0], 'Editor autosaved is real.\n')
    const editedOutside = project.files[1]
    await atPath(page, 'tab', editedOutside).locator('.tab-name').click()
    await editorShows(page, 'Ion fixture notes-01.txt')
    await writeFile(editedOutside, 'Changed on disk by another editor.\n')
    await replaceEditor(page, 'Conflicting local buffer.\n')
    const conflict = page.locator('.conflict-banner')
    await conflict.waitFor()
    assert.equal(await readFile(editedOutside, 'utf8'), 'Changed on disk by another editor.\n')
    await editorShows(page, 'Conflicting local buffer.')
    await conflict.getByRole('button', { name: 'Reload', exact: true }).click()
    const confirmReload = page.getByRole('dialog').getByRole('button', { name: 'Reload', exact: true })
    if (await confirmReload.isVisible()) await confirmReload.click()
    await editorShows(page, 'Changed on disk by another editor.')
    await atPath(page, 'close-tab', project.files[1]).click()
    assert.equal(await page.getByTestId('tab').count(), 1)
    console.log('PASS tabs, Monaco find and replace, and external-change conflict recovery')

    await page.getByTestId('new-file').first().click()
    const draft = 'Created and saved through Ion.\n'
    await replaceEditor(page, draft)
    await editorShows(page, draft.trim())
    await page.keyboard.press('Meta+s')
    const shortcutSaved = await waitForFile(readFile, save, draft, 900).then(() => true, () => false)
    if (!shortcutSaved) await page.getByTestId('save-file').click()
    await waitForFile(readFile, save, draft)
    await atPath(page, 'tab', save).waitFor()
    console.log(`PASS untitled editor and native save path (${shortcutSaved ? 'shortcut' : 'toolbar'})`)

    const created = join(project.directory, 'created.txt')
    const renamed = join(project.directory, 'renamed.txt')
    await page.getByTestId('create-file').click()
    await page.getByTestId('entry-name').fill(basename(created))
    await page.getByTestId('entry-submit').click()
    await atPath(page, 'explorer-entry', created).waitFor()
    assert.equal(await readFile(created, 'utf8'), '')
    const row = atPath(page, 'explorer-row', created)
    await row.hover()
    await row.getByTestId('rename-entry').click()
    await page.getByTestId('entry-name').fill(basename(renamed))
    await page.getByTestId('entry-submit').click()
    await atPath(page, 'explorer-entry', renamed).waitFor()
    assert.equal(await readFile(renamed, 'utf8'), '')
    await assert.rejects(readFile(created), { code: 'ENOENT' })
    await page.getByTestId('create-folder').click()
    await page.getByTestId('entry-name').fill('new-folder')
    await page.getByTestId('entry-submit').click()
    await atPath(page, 'explorer-entry', join(project.directory, 'new-folder')).waitFor()
    console.log('PASS explorer file/folder creation and rename on disk')

    await openFromExplorer(page, project.program, '#include')
    await stubDialogs(app, { ...choices, allowRun: false })
    await page.getByTestId('run').click()
    await page.locator('[data-testid="output"][data-status="rejected"]').waitFor()
    await stubDialogs(app, choices)
    await runProgram(page)
    const panes = await page.evaluate(async () => (await window.ion.getPreferences()).settings)
    await dragSeparator(page, 'Resize Explorer', 34, 0)
    await dragSeparator(page, 'Resize Console', 0, -32)
    await eventually(() => page.evaluate(async ({ explorer, output }) => {
      const { explorerWidth, outputHeight } = (await window.ion.getPreferences()).settings
      return Math.abs(explorerWidth - explorer) <= 2 && Math.abs(outputHeight - output) <= 2
    }, { explorer: panes.explorerWidth + 34, output: panes.outputHeight + 32 }), 'Pane sizes were not written.')
    const explorerToggle = page.getByRole('button', { name: 'Toggle Explorer' })
    await explorerToggle.click()
    await page.getByTestId('explorer').waitFor({ state: 'detached' })
    await explorerToggle.click()
    await atPath(page, 'explorer-entry', project.program).waitFor()
    const outputToggle = page.getByRole('button', { name: 'Toggle Console' })
    await outputToggle.click()
    await page.getByTestId('output').waitFor({ state: 'detached' })
    await outputToggle.click()
    await expectOutput(page, /ION-DESKTOP-RUN-OK/)
    console.log('PASS explorer and output resize, collapse and reopen')
    await screenshot(page, 'workspace-dark')
    await openFromExplorer(page, project.broken, 'return')
    await page.getByTestId('run').click()
    await expectOutput(page, /error:|expected.+;/i)
    console.log('PASS run approval gate, successful native C compile/run and genuine compiler errors')

    await openFromExplorer(page, inputProgram, 'fgets')
    await page.getByTestId('run').click()
    await page.locator('[data-testid="output"][data-phase="running"]').waitFor()
    const terminal = page.getByTestId('run-console-input')
    await terminal.waitFor({ state: 'attached' })
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'run-console-input')
    await page.keyboard.type('STDIN marker from Ion')
    await page.keyboard.press('Enter')
    await page.locator('[data-testid="output"][data-status="success"]').waitFor()
    await expectOutput(page, /STDIN marker from Ion/)
    console.log('PASS local C program receives live keyboard input from the Run Console')

    await openFromExplorer(page, project.loop, 'for (;;)')
    await page.getByTestId('run').click()
    await page.getByTestId('stop').click()
    await expectOutput(page, /cancel|stopped/i)
    console.log('PASS stopping a local run')

    await page.getByTestId('settings').first().click()
    await page.getByTestId('theme-light').click()
    await eventually(() => page.evaluate(async () => (await window.ion.getPreferences()).settings.theme === 'light'),
      'Theme preference was not written.')
    await screenshot(page, 'settings-light')
    await page.getByRole('dialog', { name: 'Preferences' }).getByRole('button', { name: 'Done' }).click()
    console.log('PASS theme preference saved from the UI')

    assert.deepEqual(first.errors, [], 'No uncaught renderer errors')
    assert.deepEqual(first.requests, [], 'No observed remote renderer requests')
    completed = true
  } finally {
    if (screenshots) await screenshot(first.page, 'smoke-last').catch(() => {})
    await close(first).catch((error) => {
      if (completed) throw error
      console.error(error.message)
    })
  }

  const second = await launch(target, profile)
  try {
    const { app, page } = second
    assert.equal(await page.evaluate(async () => (await window.ion.getPreferences()).settings.theme), 'light')
    await stubDialogs(app, choices)
    await page.getByTestId('welcome').getByTestId('open-file').click()
    await atPath(page, 'tab', project.files[0]).waitFor()
    await editorShows(page, 'Editor autosaved is real.')
    await screenshot(page, 'workspace-light')
    const nativeWindow = await app.browserWindow(page)
    await nativeWindow.evaluate((window) => window.setSize(820, 600))
    await nativeWindow.dispose()
    await page.waitForFunction(() => innerWidth <= 820 && innerHeight <= 600)
    await editorShows(page, 'Editor autosaved is real.')
    await screenshot(page, 'workspace-compact')
    assert.ok((await page.evaluate(async () => (await window.ion.getPreferences()).recents.map((entry) => entry.name)))
      .includes(basename(project.directory)))
    assert.deepEqual(second.errors, [], 'No uncaught renderer errors after relaunch')
    assert.deepEqual(second.requests, [], 'No observed remote renderer requests after relaunch')
    console.log('PASS relaunch, durable settings/recents, individual file open and compact layout')
  } finally {
    await close(second)
  }
})
