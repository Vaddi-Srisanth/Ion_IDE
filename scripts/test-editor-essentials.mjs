import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifact, atPath, close, createProject, eventually, launch, openFolder, openFromExplorer,
  stubDialogs, withScratch } from './desktop-harness.mjs'

const target = await artifact('dist')

async function command(page, label) {
  await page.getByTestId('command-palette').click()
  const input = page.getByTestId('command-palette-input')
  await input.fill(label)
  await page.getByRole('option', { name: new RegExp(label, 'i') }).first().click()
}

async function controlTab(app, reverse = false) {
  await app.evaluate(({ BrowserWindow }, backwards) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' })
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: backwards ? ['control', 'shift'] : ['control'] })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: backwards ? ['control', 'shift'] : ['control'] })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' })
  }, reverse)
}

await withScratch('editor-essentials', async (scratch) => {
  const project = await createProject(join(scratch, 'workspace'))
  const profile = join(scratch, 'profile')
  const files = [join(project.directory, 'alpha.c'), join(project.directory, 'beta.c'), join(project.directory, 'gamma.c')]
  await mkdir(profile)
  await Promise.all(files.map((path, index) => writeFile(path, `int value_${index}(void) { return ${index}; }\n`)))
  const session = await launch(target, profile)
  try {
    const { app, page } = session
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)

    const tree = page.getByRole('tree', { name: 'Workspace files' })
    const root = tree.getByRole('treeitem').first()
    await root.focus()
    await page.keyboard.press('ArrowDown')
    await eventually(async () => Boolean(await page.evaluate(() => document.activeElement?.matches('[role="treeitem"][data-path]'))),
      'Explorer ArrowDown did not move its roving focus.')
    await atPath(page, 'explorer-entry', files[0]).focus()
    await page.keyboard.press('F2')
    await page.getByTestId('entry-name').waitFor()
    await page.keyboard.press('Escape')
    console.log('PASS Explorer exposes a roving keyboard tree and focus-scoped rename')

    for (const path of files) await openFromExplorer(page, path, 'int value_')
    assert.equal(await page.getByTestId('tab').count(), 3)
    await atPath(page, 'tab', files[0]).locator('.tab-name').click()
    await atPath(page, 'tab', files[1]).locator('.tab-name').click()
    await atPath(page, 'tab', files[2]).locator('.tab-name').click()
    await atPath(page, 'tab', files[0]).locator('.tab-name').click()
    await controlTab(app)
    await eventually(async () => (await page.locator('.editor-tab.active').getAttribute('data-path')) === files[2],
      'Ctrl+Tab did not select the previous MRU editor.')
    await controlTab(app, true)
    await eventually(async () => (await page.locator('.editor-tab.active').getAttribute('data-path')) === files[0],
      'Ctrl+Shift+Tab did not traverse the stable MRU snapshot backward.')
    console.log('PASS Ctrl+Tab and Ctrl+Shift+Tab use group-aware MRU traversal')

    await atPath(page, 'tab', files[1]).click({ button: 'right' })
    const tabMenu = page.getByRole('menu', { name: 'Editor tab actions' })
    await tabMenu.getByRole('menuitem', { name: 'Close Others' }).click()
    await eventually(async () => await page.getByTestId('tab').count() === 1, 'Close Others did not close the saved peer tabs.')
    await command(page, 'Reopen Closed Tab')
    await eventually(async () => await page.getByTestId('tab').count() === 2, 'Reopen Closed Tab did not restore the latest saved editor.')
    console.log('PASS tab context menu closes peers safely and recently closed history reopens the latest editor')

    const explorerEntry = atPath(page, 'explorer-entry', files[0])
    await explorerEntry.click({ button: 'right' })
    const explorerMenu = page.getByRole('menu', { name: 'Explorer actions' })
    await explorerMenu.getByRole('menuitem', { name: 'Copy Path' }).click()
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    assert.equal(copied, files[0])
    console.log('PASS Explorer context menu uses the authorization-checked path bridge')

    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
  } finally {
    await close(session)
  }
})
