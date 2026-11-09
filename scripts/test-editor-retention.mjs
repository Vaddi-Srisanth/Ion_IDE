import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder,
  openFromExplorer, stubDialogs, withScratch } from './desktop-harness.mjs'

const target = await artifact(process.argv[2] ?? 'dist')
const mac = process.platform === 'darwin'
const undo = mac ? 'Meta+z' : 'Control+z'
const redo = mac ? 'Meta+Shift+z' : 'Control+y'

async function goToLine(app, page, line) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.focus()
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'G', modifiers: ['control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'G', modifiers: ['control'] })
  })
  const input = page.getByTestId('goto-line-input')
  await input.fill(String(line))
  await input.press('Enter')
  await page.getByText(`Ln ${line}, Col 1`, { exact: true }).waitFor()
}

async function shown(page, text) {
  await (await editorShows(page, text)).dispose()
}

await withScratch('editor-retention', async (scratch) => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 6 })
  const profile = join(scratch, 'profile')
  const source = project.files[0]
  const session = await launch(target, profile)
  const { app, page } = session
  let complete = false
  try {
    await stubDialogs(app, { folder: project.directory })
    await page.getByTestId('settings').click()
    const preferences = page.getByRole('dialog', { name: 'Preferences' })
    await preferences.getByRole('checkbox', { name: /Autosave/ }).uncheck()
    await preferences.getByRole('button', { name: 'Done' }).click()
    await openFolder(page, project)
    await openFromExplorer(page, source, basename(source))

    const editor = page.locator('.monaco-editor')
    const selection = editor.locator('.selected-text')
    const scroll = () => editor.evaluate((element) => {
      const slider = element.querySelector('.scrollbar.vertical .slider')
      return slider?.getBoundingClientRect().top - element.getBoundingClientRect().top
    })
    async function evict() {
      for (const path of project.files.slice(1)) await openFromExplorer(page, path, basename(path))
      await atPath(page, 'tab', source).locator('.tab-name').click()
    }
    async function selectWord() {
      await goToLine(app, page, 250)
      for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
      await page.getByText('Ln 250, Col 4', { exact: true }).waitFor()
      await selection.first().waitFor()
    }

    await selectWord()
    await page.keyboard.insertText('Replacement')
    await shown(page, 'Replacement 248')
    await evict()
    await shown(page, 'Replacement 248')
    await page.keyboard.press(undo)
    await shown(page, 'Row 248')

    await selectWord()
    const before = await scroll()
    assert.ok(before > 50, 'selected text is scrolled out of the initial viewport')
    await evict()
    await shown(page, 'Row 248')
    await page.getByText('Ln 250, Col 4', { exact: true }).waitFor()
    await selection.first().waitFor()
    assert.ok(Math.abs(await scroll() - before) <= 2, 'scroll position is preserved after model eviction')
    await page.keyboard.press(redo)
    await shown(page, 'Replacement 248')
    assert.equal(await editor.count(), 1)

    await page.getByRole('button', { name: 'Welcome', exact: true }).click()
    await editor.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Return to Workspace', exact: true }).click()
    await shown(page, 'Replacement 248')
    await page.keyboard.press(undo)
    await shown(page, 'Row 248')
    await page.keyboard.press(redo)
    await shown(page, 'Replacement 248')

    await page.getByTestId('save-file').click()
    await eventually(async () => (await readFile(source, 'utf8')).includes('Replacement 248'), 'edit saved before changing file externally')
    for (const path of project.files.slice(1)) await openFromExplorer(page, path, basename(path))
    await writeFile(source, 'Externally changed after eviction.\n')
    await atPath(page, 'tab', source).locator('.tab-name').click()
    await shown(page, 'Externally changed after eviction.')
    await page.keyboard.press(undo)
    await shown(page, 'Externally changed after eviction.')
    assert.equal(await atPath(page, 'tab', source).locator('.tab-dirty').count(), 0)
    console.log('PASS undo and redo after model eviction and Welcome, selection and scroll restoration, and stale-history rejection')
    complete = true
  } finally {
    await close(session).catch((error) => { if (complete) throw error })
  }
})
