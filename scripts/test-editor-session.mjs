import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function quit(session, keep = false) {
  if (!keep) return close(session)
  const quitting = close(session)
  try {
    const prompt = session.page.getByRole('dialog', { name: 'Unsaved changes' })
    await prompt.getByRole('button', { name: 'Keep Drafts and Quit', exact: true }).click()
    await quitting
  } finally {
    await quitting.catch(() => undefined)
  }
}

async function closeIfRunning(session, process) {
  if (process.exitCode === null && process.signalCode === null) await close(session)
}

async function goToLine(session, line) {
  await session.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.focus()
    for (const type of ['keyDown', 'keyUp']) {
      window.webContents.sendInputEvent({ type, keyCode: 'G', modifiers: ['control'] })
    }
  })
  await session.page.getByTestId('goto-line-input').fill(String(line))
  await session.page.getByTestId('goto-line-input').press('Enter')
  await session.page.getByText(`Ln ${line}, Col 1`, { exact: true }).waitFor()
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

  const first = await launch(target, profile)
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
    await goToLine(first, 140)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.getByText('Ln 140, Col 4', { exact: true }).waitFor()
    assert.deepEqual(first.errors, [])
    await quit(first, true)
  } finally {
    await closeIfRunning(first, firstProcess)
  }

  assert.equal(await readFile(named, 'utf8'), 'initial named version')
  await writeFile(named, 'new disk content')
  await rm(missing)
  await symlink(external, missing)
  const snapshotPath = join(profile, 'editor-session.json')
  const kept = JSON.parse(await readFile(snapshotPath, 'utf8'))
  assert.equal(kept.rootPath, project.directory)
  assert.equal(kept.tabs[kept.activeIndex].path, anchor)
  assert.ok(kept.tabs[kept.activeIndex].view.scrollTop > 0)
  assert.ok(kept.tabs.find(({ path }) => path === named).draftId)

  const second = await launch(target, profile)
  const secondProcess = second.app.process()
  try {
    const { page } = second
    await page.context().setOffline(true)
    await page.getByTestId('resume-session').click()
    await page.getByTestId('workspace').waitFor()
    assert.deepEqual(await page.getByTestId('tab').locator('.tab-name').allTextContents(), ['anchor.txt', 'notes.ipynb', 'named.txt'])
    assert.equal(await atPath(page, 'tab', anchor).locator('.tab-name').getAttribute('aria-current'), 'true')
    await page.getByText('Ln 140, Col 4', { exact: true }).waitFor()
    await editorShows(page, 'alpha-140')
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
    const exited = once(secondProcess, 'exit')
    secondProcess.kill('SIGKILL')
    await exited
  } finally {
    await closeIfRunning(second, secondProcess)
  }

  const third = await launch(target, profile)
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
    const quitting = close(third)
    await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Discard', exact: true }).click()
    await quitting
    console.log('PASS clean relaunch and abrupt exit restore ordered tabs, active tab, cursor, selection, scroll, workspace, and detached unsaved drafts.')
  } finally {
    await closeIfRunning(third, thirdProcess)
  }
})
