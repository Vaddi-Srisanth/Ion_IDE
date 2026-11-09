import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, readFile, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder,
  openFromExplorer, resourceSnapshot, stubDialogs, waitForFile, withScratch,
} from './desktop-harness.mjs'
import { cellNotebook, chooseNotebookPython, editableNotebook, encodeNotebook, interruptNotebook,
  kernelBenchmarkNotebook, kernelNotebook, notebookCell, plotNotebook, revealNotebookCell,
  smallNotebook, stubNotebookTrust } from './notebook-fixtures.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, edit: { type: 'boolean' }, 'kernel-python': { type: 'string' },
} })
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use the unpackaged production build for native dialog stubs.')

async function openNotebook(page, path) {
  await atPath(page, 'explorer-entry', path).click()
  await atPath(page, 'tab', path).waitFor()
  return page.getByTestId('notebook-view')
}

async function closeNotebook(page, path) {
  await atPath(page, 'close-tab', path).click()
  await atPath(page, 'tab', path).waitFor({ state: 'detached' })
  await page.getByTestId('notebook-view').waitFor({ state: 'detached' })
}

async function decodedWidths(locator, widths) {
  await eventually(async () => {
    const decoded = await locator.evaluateAll((images) => images.filter((image) => image.complete && image.naturalWidth > 0)
      .map((image) => image.naturalWidth).sort((a, b) => a - b))
    return JSON.stringify(decoded) === JSON.stringify(widths)
  }, `Expected decoded saved images with widths ${widths.join(', ')}.`)
}

async function revealRichPlot(view, index) {
  const cell = await revealNotebookCell(view, index)
  const holder = cell.locator('.notebook-image').first()
  await holder.waitFor({ state: 'attached' })
  await holder.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }))
  await decodedWidths(cell.locator('img'), [216])
}

async function observeImageUrls(page) {
  await page.evaluate(() => {
    const imageUrls = new Set()
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (value) => {
      const url = create(value)
      if (value.type?.startsWith('image/')) imageUrls.add(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      imageUrls.delete(url)
      revoke(url)
    }
    window.ionNotebookTestImageUrls = imageUrls
  })
}

async function expectImageCleanup(page) {
  await eventually(() => page.evaluate(() => window.ionNotebookTestImageUrls.size === 0),
    'All notebook image object URLs should be released after closing the tab.')
  assert.equal(await page.getByTestId('notebook-cell').count(), 0)
}

await withScratch('notebook-viewer', async (scratch) => {
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const markerPath = join(scratch, 'opened-code-ran.txt')
  const samplePath = join(project.directory, 'study.IPYNB')
  const manyPath = join(project.directory, '240 cells.ipynb')
  const largePath = join(project.directory, 'large plots.ipynb')
  const markdownLimitPath = join(project.directory, 'markdown complexity.ipynb')
  const corruptPath = join(project.directory, 'corrupt.ipynb')
  const oldPath = join(project.directory, 'old-v3.ipynb')
  const overLimit = join(project.directory, 'over-limit.ipynb')
  const excessiveMarkdown = cellNotebook(1)
  excessiveMarkdown.cells[0].source = '[x]('.repeat(8_000)
  const fixtures = new Map([
    [samplePath, encodeNotebook(smallNotebook({ markerPath }))],
    [manyPath, encodeNotebook(cellNotebook(240))],
    [largePath, encodeNotebook(plotNotebook())],
    [markdownLimitPath, encodeNotebook(excessiveMarkdown)],
    [corruptPath, '{"nbformat":4,"cells":[this is corrupt'],
    [oldPath, '{"nbformat":3,"worksheets":[],"metadata":{}}\n'],
  ])
  assert.ok(Buffer.byteLength(fixtures.get(largePath)) >= 4 * 1024 ** 2, 'Large plots fixture must contain several MiB.')
  await Promise.all([...fixtures].map(([path, contents]) => writeFile(path, contents)))
  await writeFile(overLimit, '{"nbformat":4,"cells":[]}')
  await truncate(overLimit, 16 * 1024 ** 2 + 1)

  const session = await launch(target, join(scratch, 'profile'))
  const { app, page } = session
  let chunkInspection
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await observeImageUrls(page)
    let notebookChunkLoaded = false
    chunkInspection = await page.context().newCDPSession(page)
    chunkInspection.on('Debugger.scriptParsed', ({ url }) => {
      if (/\/NotebookEditor(?:-[^/?]+)?\.js(?:\?|$)/.test(url)) notebookChunkLoaded = true
    })
    await chunkInspection.send('Debugger.enable')
    await openFolder(page, project)
    await openFromExplorer(page, project.program, '#include')
    assert.equal(await page.getByTestId('notebook-view').count(), 0)
    assert.equal(notebookChunkLoaded, false, 'A normal source tab must not load the NotebookEditor chunk.')

    const notebook = await openNotebook(page, samplePath)
    await notebook.getByRole('heading', { name: 'Notebook study fixture' }).waitFor()
    await eventually(() => notebookChunkLoaded, 'Opening a notebook should load its editor chunk.')
    await chunkInspection.detach()
    chunkInspection = undefined
    await notebook.getByText('saved Markdown', { exact: true }).waitFor()
    await notebook.getByText('inline code', { exact: true }).waitFor()
    assert.equal(await notebook.locator('.monaco-editor').count(), 0, 'Viewing cells should not create Monaco instances.')
    const metadata = notebook.getByRole('button', { name: 'Metadata', exact: true })
    await metadata.click()
    await notebook.getByText(/Jupyter notebook format 4\.5/).waitFor()
    await notebook.getByText(/ion-notebook-fixture-a/).waitFor()
    await metadata.click()

    await notebook.getByRole('button', { name: 'Next cell', exact: true }).click()
    assert.equal(await notebook.getByRole('button', { name: 'Previous cell', exact: true }).isDisabled(), false)
    const dataframe = await revealNotebookCell(notebook, 1)
    assert.equal(await dataframe.getAttribute('data-selected'), 'true')
    await dataframe.getByRole('table').waitFor()
    await dataframe.getByRole('columnheader', { name: 'Module' }).waitFor()
    await dataframe.getByRole('cell', { name: 'Ion notebooks' }).waitFor()
    await dataframe.getByRole('cell', { name: '98' }).waitFor()
    assert.match(await dataframe.textContent(), /\b7\b/)
    assert.match(await dataframe.textContent(), /pd\.DataFrame/)
    await dataframe.getByRole('button', { name: 'Hide outputs', exact: true }).click()
    await dataframe.getByRole('table').waitFor({ state: 'detached' })
    await dataframe.getByRole('button', { name: 'Show outputs', exact: true }).click()
    await dataframe.getByRole('table').waitFor()

    const plots = await revealNotebookCell(notebook, 2)
    await decodedWidths(plots.locator('img'), [80, 144, 160])
    const streams = await revealNotebookCell(notebook, 3)
    await streams.getByTestId('notebook-output').getByText('Visible standard output', { exact: true }).waitFor()
    await streams.getByTestId('notebook-output').getByText('Visible standard error', { exact: true }).waitFor()
    await streams.getByTestId('notebook-output').getByText(/ValueError: Visible Python traceback/).first().waitFor()
    const raw = await revealNotebookCell(notebook, 4)
    await raw.getByText('Raw cell <em>stays literal</em>', { exact: true }).waitFor()
    assert.equal(await raw.locator('em').count(), 0)
    const untrusted = await revealNotebookCell(notebook, 5)
    await untrusted.getByText('Inert HTML fixture', { exact: true }).waitFor()
    await untrusted.getByText('Unknown MIME text fallback', { exact: true }).waitFor()
    assert.equal(await untrusted.locator('script, iframe, object, embed, form, style, [onload], [onerror], [src^="https:"]').count(), 0)
    assert.equal(await page.evaluate(() => Boolean(window.ionNotebookActive)), false)
    await assert.rejects(access(markerPath), { code: 'ENOENT' })
    assert.equal((await resourceSnapshot(session)).childRssMiB, 0, 'Viewing should start no native kernel process.')

    await notebook.getByTestId('notebook-open-json').click()
    await notebook.waitFor({ state: 'detached' })
    await editorShows(page, 'ion-notebook-fixture-a')
    await page.getByRole('button', { name: 'Open Notebook', exact: true }).click()
    await notebook.getByRole('heading', { name: 'Notebook study fixture' }).waitFor()
    await closeNotebook(page, samplePath)
    await expectImageCleanup(page)
    await editorShows(page, '#include')
    console.log('PASS saved notebook Markdown, code, raw cells, counters, streams, tracebacks, tables, three image formats and JSON fallback offline')

    const many = await openNotebook(page, manyPath)
    await many.getByText('Notebook cell 001', { exact: true }).waitFor()
    const mounted = many.getByTestId('notebook-cell')
    assert.ok(await mounted.count() < 48, 'A 240-cell notebook should render only the viewport and a small buffer.')
    const scroll = many.getByTestId('notebook-scroll')
    for (let attempt = 0; attempt < 4 && !await notebookCell(many, 239).count(); attempt++) {
      await scroll.evaluate((node) => {
        node.scrollTop = node.scrollHeight
        return new Promise((resolve) => requestAnimationFrame(resolve))
      })
    }
    await notebookCell(many, 239).getByText(/Notebook cell 240/).waitFor()
    assert.ok(await mounted.count() < 48)
    assert.equal(await notebookCell(many, 0).count(), 0, 'Offscreen cells should leave the DOM.')
    await closeNotebook(page, manyPath)
    console.log('PASS 240-cell notebook scrolls to the end with bounded cell DOM')

    for (let cycle = 0; cycle < 3; cycle++) {
      const large = await openNotebook(page, largePath)
      const first = await revealNotebookCell(large, 0)
      await decodedWidths(first.locator('img'), [960])
      const last = await revealNotebookCell(large, 2)
      await decodedWidths(last.locator('img'), [960])
      if (cycle === 0) {
        await large.getByTestId('notebook-open-json').click()
        const rawJson = page.getByTestId('notebook-raw-large')
        await rawJson.getByText(/Raw JSON · Read only/).waitFor()
        await expectImageCleanup(page)
        const rawPage = rawJson.locator('pre')
        assert.match(await rawPage.textContent(), /"nbformat"/)
        await rawJson.getByRole('button', { name: 'Next page', exact: true }).click()
        assert.doesNotMatch(await rawPage.textContent(), /"nbformat"/)
        assert.equal(await rawJson.locator('.monaco-editor').count(), 0)
        await rawJson.getByRole('button', { name: 'Open Notebook', exact: true }).click()
        await large.waitFor()
      }
      await closeNotebook(page, largePath)
      await expectImageCleanup(page)
    }
    console.log('PASS repeated several-MiB plot notebooks release mounted cells and decoded image URLs after close')

    const boundedMarkdown = await openNotebook(page, markdownLimitPath)
    await boundedMarkdown.getByText('Showing source because this Markdown exceeds the preview limits.', { exact: true }).waitFor()
    await closeNotebook(page, markdownLimitPath)

    for (const [path, message] of [[corruptPath, /json|corrupt/i], [oldPath, /4|unsupported/i], [overLimit, /16\s*mib|too large/i]]) {
      await openNotebook(page, path)
      const error = page.getByTestId('notebook-error').or(page.getByRole('alert')).first()
      await error.waitFor()
      assert.match(await error.textContent(), message)
      await closeNotebook(page, path)
    }
    for (const [path, original] of fixtures) assert.equal(await readFile(path, 'utf8'), original, `Viewing must preserve ${path}.`)
    assert.deepEqual(session.errors, [], 'Notebook viewing should not produce an uncaught renderer error.')
    assert.deepEqual(session.requests, [], 'Notebook viewing should attempt no network requests, even from embedded output.')
    console.log('PASS unsupported and corrupt files fail gracefully, with no execution, requests or original-file writes')
  } finally {
    await chunkInspection?.detach().catch(() => {})
    await close(session)
  }
})

function notebookButton(view, name) {
  return view.getByRole('button', { name, exact: true })
}

async function replaceCellText(page, view, value) {
  const editor = view.getByTestId('notebook-cell-editor')
  await editor.locator('.view-line').first().click()
  assert.equal(await view.locator('.monaco-editor').count(), 1, 'Only the current cell owns a Monaco editor.')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.insertText(value)
  await eventually(async () => (await editor.textContent())?.replace(/\u00a0/g, ' ').includes(value.split('\n')[0]),
    'The active cell should display the newly entered source.')
  await notebookButton(view, 'Done editing').click()
  await editor.waitFor({ state: 'detached' })
}

async function editCell(page, view, index, kind, source) {
  const cell = await revealNotebookCell(view, index)
  await notebookButton(cell, `Select ${kind} cell ${index + 1}`).click()
  await notebookButton(view, 'Edit cell').click()
  await replaceCellText(page, view, source)
}

async function waitForCellSource(view, index, value) {
  const cell = await revealNotebookCell(view, index)
  await eventually(async () => (await cell.textContent())?.includes(value), `Expected cell ${index + 1} to show ${value}.`)
  return cell
}

if (values.edit) await withScratch('notebook-edit', async (scratch) => {
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const path = join(project.directory, 'editable.ipynb')
  const savedPath = join(project.directory, 'resolved notebook.ipynb')
  const recoveredPath = join(project.directory, 'recovered notebook.ipynb')
  const original = editableNotebook()
  const originalNotebook = JSON.parse(original)
  const codeSource = 'changed_value = 42\nprint(changed_value)'
  const markdownSource = '## Changed notebook note\n\n**Updated from Ion.**\n\n![Saved attachment](attachment:chart.png)'
  const conflictMarker = 'local_conflict_draft = 88'
  const recoveryMarker = 'recover_this_notebook = 99'
  await writeFile(path, original)

  const session = await launch(target, join(scratch, 'profile'))
  let completed = false
  try {
    const { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, save: savedPath })
    await page.getByTestId('settings').first().click()
    const settings = page.getByRole('dialog', { name: 'Preferences' })
    await settings.getByRole('checkbox', { name: /^Autosave/ }).uncheck()
    await settings.getByRole('button', { name: 'Done' }).click()
    await eventually(() => page.evaluate(async () => !(await window.ion.getPreferences()).settings.autoSave),
      'Autosave should be disabled in the disposable profile.')
    await openFolder(page, project)
    const view = await openNotebook(page, path)
    await waitForCellSource(view, 0, 'original_value = 7')
    await editCell(page, view, 0, 'code', codeSource)
    await waitForCellSource(view, 0, 'changed_value = 42')
    assert.match(await atPath(page, 'close-tab', path).getAttribute('class'), /\btab-dirty\b/)
    await notebookButton(view, 'Undo notebook edit').click()
    await waitForCellSource(view, 0, 'original_value = 7')
    await notebookButton(view, 'Redo notebook edit').click()
    await waitForCellSource(view, 0, 'changed_value = 42')
    await editCell(page, view, 1, 'markdown', markdownSource)
    await view.getByRole('heading', { name: 'Changed notebook note' }).waitFor()

    await notebookButton(view, 'Add cell').click()
    await replaceCellText(page, view, 'temporary_cell = 9')
    await waitForCellSource(view, 2, 'temporary_cell = 9')
    await notebookButton(view, 'Move cell up').click()
    await waitForCellSource(view, 1, 'temporary_cell = 9')
    await notebookButton(view, 'Move cell down').click()
    const inserted = await waitForCellSource(view, 2, 'temporary_cell = 9')
    await view.getByRole('combobox', { name: 'Cell type', exact: true }).selectOption('raw')
    assert.equal(await inserted.getAttribute('data-cell-type'), 'raw')
    await notebookButton(view, 'Delete cell').click()
    await view.getByText('Cell 3 of 3', { exact: true }).waitFor()
    await notebookButton(view, 'Undo notebook edit').click()
    await waitForCellSource(view, 2, 'temporary_cell = 9')
    await notebookButton(view, 'Redo notebook edit').click()
    await view.getByText('Cell 3 of 3', { exact: true }).waitFor()
    assert.equal(await readFile(path, 'utf8'), original, 'Unsaved cell edits must not change the file.')

    await page.getByTestId('save-file').click()
    await waitForFile(readFile, path, 'changed_value')
    const saved = await readFile(path, 'utf8')
    const actualNotebook = JSON.parse(saved)
    const sourceText = (source) => Array.isArray(source) ? source.join('') : source
    assert.equal(sourceText(actualNotebook.cells[0].source), codeSource)
    assert.equal(sourceText(actualNotebook.cells[1].source), markdownSource)
    const expectedNotebook = structuredClone(originalNotebook)
    expectedNotebook.cells[0].source = actualNotebook.cells[0].source
    expectedNotebook.cells[1].source = actualNotebook.cells[1].source
    assert.deepEqual(actualNotebook, expectedNotebook, 'IDs, attachments, unknown outputs, and notebook metadata must survive editing.')
    for (const originalBytes of ['"course" :  "preserve this"', '"calibration"  : 9007199254740993',
      '"ionFrozen" :  true', '"legacy-cell-marker" : true']) assert.ok(saved.includes(originalBytes))
    console.log('PASS one Monaco cell editor, structural edits and undo, exact untouched fields, and notebook save round-trip')

    await editCell(page, view, 0, 'code', conflictMarker)
    const external = original.replace('original_value = 7', 'external_value = 98')
    await writeFile(path, external)
    await page.getByTestId('save-file').click()
    const conflict = page.locator('.conflict-banner').filter({ hasText: 'changed on disk' })
    await conflict.waitFor()
    assert.equal(await readFile(path, 'utf8'), external)
    await conflict.getByRole('button', { name: 'Save As…', exact: true }).click()
    await waitForFile(readFile, savedPath, conflictMarker)
    await atPath(page, 'tab', savedPath).waitFor()
    assert.equal(await readFile(path, 'utf8'), external, 'Save As must leave the external revision intact.')
    await closeNotebook(page, savedPath)
    console.log('PASS notebook detects external conflicts and saves both versions safely')

    const beforeCrash = await openNotebook(page, path)
    await waitForCellSource(beforeCrash, 0, 'external_value = 98')
    await editCell(page, beforeCrash, 0, 'code', recoveryMarker)
    await eventually(() => page.evaluate(async (marker) => {
      const drafts = await window.ion.recovery.list()
      return drafts.length === 1 && (await window.ion.recovery.read(drafts[0].id)).includes(marker)
    }, recoveryMarker), 'Expected a published notebook recovery checkpoint before crashing.')
    assert.equal(await readFile(path, 'utf8'), external)
    const [restarted] = await Promise.all([
      app.waitForEvent('window', { timeout: 15_000 }),
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()),
    ])
    restarted.setDefaultTimeout(8_000)
    restarted.on('pageerror', (error) => session.errors.push(error.message))
    await restarted.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, save: recoveredPath })
    await restarted.getByTestId('welcome').waitFor()
    await restarted.getByTestId('recover-edits').click()
    const recovery = restarted.getByRole('dialog', { name: 'Recover unsaved edits' })
    await recovery.getByRole('button', { name: 'Restore Drafts', exact: true }).click()
    const recoveredView = restarted.getByTestId('notebook-view')
    await waitForCellSource(recoveredView, 0, recoveryMarker)
    const recoveredTab = restarted.getByTestId('tab').filter({ has: restarted.getByRole('button', { name: 'editable.ipynb', exact: true }) })
    assert.equal(await recoveredTab.getAttribute('data-path'), null)
    assert.match(await recoveredTab.getByTestId('close-tab').getAttribute('class'), /\btab-dirty\b/)
    await restarted.getByTestId('save-file').click()
    await waitForFile(readFile, recoveredPath, recoveryMarker)
    const savedRecovery = atPath(restarted, 'close-tab', recoveredPath)
    await savedRecovery.waitFor()
    await eventually(async () => !/\btab-dirty\b/.test(await savedRecovery.getAttribute('class') ?? ''),
      'The recovered notebook did not acknowledge its completed save.')
    assert.equal(await readFile(path, 'utf8'), external)
    assert.deepEqual(JSON.parse(await readFile(recoveredPath, 'utf8')).metadata, originalNotebook.metadata)
    await closeNotebook(restarted, recoveredPath)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    completed = true
    console.log('PASS unsaved notebook survives a renderer crash as a detached native notebook and saves safely')
  } finally {
    await close(session).catch((error) => { if (completed) throw error })
  }
})

function notebookOutput(view, text) {
  return view.getByTestId('notebook-output').getByText(text).first()
}

async function selectNotebookCodeCell(view, index) {
  const cell = await revealNotebookCell(view, index)
  await notebookButton(cell, `Select code cell ${index + 1}`).click()
  return cell
}

async function kernelPids(session) {
  const { members } = await resourceSnapshot(session, { details: true })
  return members.filter(({ kind }) => kind === 'child').map(({ pid }) => pid)
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

const execute = promisify(execFile)
if (values['kernel-python']) await withScratch('notebook-kernel', async (scratch) => {
  const python = values['kernel-python']
  await execute(python, ['-I', '-c', 'import ipykernel, jupyter_client, pandas, matplotlib'], { timeout: 20_000 })
  const environment = join(scratch, 'no-jupyter')
  const systemPython = process.platform === 'darwin' ? '/usr/bin/python3' : python
  await execute(systemPython, ['-I', '-m', 'venv', '--without-pip', environment], { timeout: 20_000 })
  const barePython = process.platform === 'win32' ? join(environment, 'Scripts', 'python.exe') : join(environment, 'bin', 'python3')
  await execute(barePython, ['-I', '-c', 'import importlib.util as u; assert not u.find_spec("ipykernel") and not u.find_spec("jupyter_client")'])

  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const noKernelPath = join(project.directory, 'no kernel.ipynb')
  const notebookPath = join(project.directory, 'live Python.ipynb')
  const busyPath = join(project.directory, 'interrupt.ipynb')
  const switchPath = join(project.directory, 'background completion.ipynb')
  const quitPath = join(project.directory, 'window lifetime.ipynb')
  const trustedMarker = join(scratch, 'trusted-code-ran')
  const busyMarker = join(scratch, 'busy-code-started')
  const switchMarker = join(scratch, 'tab-switch-code-started')
  const switchRelease = join(scratch, 'tab-switch-can-finish')
  const original = encodeNotebook(kernelNotebook({ markerPath: trustedMarker }))
  const switchingNotebook = kernelBenchmarkNotebook()
  switchingNotebook.cells[0].source = [
    'import time', 'from pathlib import Path', `Path(${JSON.stringify(switchMarker)}).write_text('started')`,
    'for _ in range(400):', `    if Path(${JSON.stringify(switchRelease)}).exists():`, '        break', '    time.sleep(0.05)',
    'else:', '    raise TimeoutError("The source tab was not opened in time")', 'print("Ion finished in the background")',
  ].join('\n')
  await Promise.all([
    writeFile(noKernelPath, encodeNotebook(cellNotebook(2))),
    writeFile(notebookPath, original),
    writeFile(busyPath, encodeNotebook(interruptNotebook(busyMarker))),
    writeFile(switchPath, encodeNotebook(switchingNotebook)),
    writeFile(quitPath, encodeNotebook(kernelBenchmarkNotebook())),
  ])

  const session = await launch(target, join(scratch, 'profile'))
  let completed = false
  try {
    const { app, page } = session
    const nativeDialogs = async (file, approved) => {
      await stubDialogs(app, { folder: project.directory, file })
      await stubNotebookTrust(app, approved)
    }
    await page.context().setOffline(true)
    await nativeDialogs(barePython, false)
    await page.getByTestId('settings').first().click()
    const settings = page.getByRole('dialog', { name: 'Preferences' })
    await settings.getByRole('checkbox', { name: /^Autosave/ }).uncheck()
    await settings.getByRole('button', { name: 'Done' }).click()
    await eventually(() => page.evaluate(async () => !(await window.ion.getPreferences()).settings.autoSave),
      'Autosave should be disabled in the disposable profile.')
    await openFolder(page, project)
    const missing = await openNotebook(page, noKernelPath)
    await missing.getByText('Notebook cell 001', { exact: true }).waitFor()
    await chooseNotebookPython(missing)
    await missing.getByRole('alert').filter({ hasText: /ipykernel|jupyter_client|jupyter dependencies/i }).waitFor()
    assert.equal(await notebookButton(missing, 'Edit cell').isDisabled(), false)
    await eventually(async () => (await kernelPids(session)).length === 0, 'The unavailable environment probe should exit.')
    await closeNotebook(page, noKernelPath)
    console.log('PASS missing Jupyter dependencies explain setup and leave local notebook viewing and editing available')

    await nativeDialogs(python, false)
    const view = await openNotebook(page, notebookPath)
    await waitForCellSource(view, 0, 'ion_value = 41')
    assert.deepEqual(await kernelPids(session), [])
    await chooseNotebookPython(view)
    const run = view.getByTestId('notebook-run-cell')
    await run.click()
    await eventually(() => app.evaluate(() => globalThis.ionTestKernelTrustPrompts === 1), 'Expected notebook execution trust prompt.')
    await eventually(async () => !await run.isDisabled(), 'Run control should return after canceling trust.')
    await assert.rejects(access(trustedMarker), { code: 'ENOENT' })
    assert.deepEqual(await kernelPids(session), [])

    await nativeDialogs(python, true)
    await run.click()
    await notebookOutput(view, 'Ion kernel started').waitFor({ timeout: 30_000 })
    const pidText = notebookOutput(view, /Ion kernel PID \d+/)
    const pid = Number((await pidText.textContent())?.match(/Ion kernel PID (\d+)/)?.[1])
    assert.equal(await readFile(trustedMarker, 'utf8'), 'executed')
    assert.ok((await kernelPids(session)).includes(pid), 'The actual Python kernel must belong to Ion’s process tree.')
    await selectNotebookCodeCell(view, 1)
    await run.click()
    await notebookOutput(view, 'Ion shared state 42').waitFor()
    assert.equal(await app.evaluate(() => globalThis.ionTestKernelTrustPrompts), 2)

    const rich = await selectNotebookCodeCell(view, 2)
    await view.getByTestId('notebook-run-above').click()
    await eventually(async () => !await run.isDisabled(), 'Run above did not return to idle.', 30_000)
    assert.equal(await rich.getByRole('table').count(), 0, 'Run above should stop before the selected cell.')
    await view.getByTestId('notebook-run-all').click()
    await revealNotebookCell(view, 2)
    await rich.getByRole('cell', { name: 'Live Pandas table' }).waitFor({ timeout: 30_000 })
    await rich.getByRole('cell', { name: '42', exact: true }).waitFor()
    await eventually(async () => !await run.isDisabled(), 'The rich-output batch should finish before checking its lazy image.', 30_000)
    await revealRichPlot(view, 2)
    await revealNotebookCell(view, 3)
    await notebookOutput(view, /ValueError: Ion live traceback/).waitFor()
    assert.equal(await readFile(notebookPath, 'utf8'), original)
    await page.getByTestId('save-file').click()
    await waitForFile(readFile, notebookPath, 'image/png')
    const saved = JSON.parse(await readFile(notebookPath, 'utf8'))
    assert.ok(saved.cells.every((cell) => Number.isInteger(cell.execution_count)))
    assert.ok(saved.cells[2].outputs.some(({ data }) => String(data?.['text/html']).includes('Live Pandas table')))
    assert.ok(saved.cells[2].outputs.some(({ data }) => data?.['image/png']))
    assert.equal(saved.cells[3].outputs.at(-1).ename, 'ValueError')
    console.log('PASS explicit trust, persistent Python state, Run Above/All, live Pandas and Matplotlib outputs, traceback and saved counts')

    const retainedPids = await kernelPids(session)
    await view.getByTestId('notebook-kernel-lifetime').selectOption('window')
    await closeNotebook(page, notebookPath)
    assert.ok(retainedPids.every(alive), 'Window lifetime should retain the idle kernel after tab close.')
    const reopened = await openNotebook(page, notebookPath)
    const savedRich = await revealNotebookCell(reopened, 2)
    await savedRich.getByRole('cell', { name: 'Live Pandas table' }).waitFor()
    await revealRichPlot(reopened, 2)
    const dependent = await selectNotebookCodeCell(reopened, 1)
    const counter = dependent.locator('.notebook-execution')
    const before = await counter.textContent()
    await reopened.getByTestId('notebook-run-cell').click()
    await eventually(async () => await counter.textContent() !== before, 'Reopening did not reuse the retained kernel.')
    await notebookOutput(reopened, 'Ion shared state 42').waitFor()

    await reopened.getByTestId('notebook-kernel-restart').click()
    await eventually(() => !alive(pid), 'Restart did not reap the previous kernel.', 20_000)
    await reopened.getByTestId('notebook-run-cell').click()
    await notebookOutput(reopened, /NameError/).waitFor({ timeout: 30_000 })
    const restartedPids = await kernelPids(session)
    await reopened.getByTestId('notebook-kernel-stop').click()
    await eventually(() => restartedPids.every((pid) => !alive(pid)), 'Stop did not reap the notebook kernel.')
    await page.getByTestId('save-file').click()
    await waitForFile(readFile, notebookPath, 'NameError')
    await closeNotebook(page, notebookPath)
    console.log('PASS explicit kernel lifetime reuses notebook state, restart clears state and Stop reaps processes')

    const busy = await openNotebook(page, busyPath)
    await waitForCellSource(busy, 0, 'time.sleep(90)')
    await chooseNotebookPython(busy)
    await busy.getByTestId('notebook-kernel-lifetime').selectOption('tab')
    await busy.getByTestId('notebook-run-cell').click()
    await eventually(async () => (await readFile(busyMarker, 'utf8').catch(() => '')) === 'busy', 'Busy cell never started.', 30_000)
    const interruptPids = await kernelPids(session)
    assert.ok(interruptPids.length > 0)
    await busy.getByTestId('notebook-kernel-interrupt').click()
    await notebookOutput(busy, /KeyboardInterrupt/).waitFor({ timeout: 20_000 })
    await page.getByTestId('save-file').click()
    await waitForFile(readFile, busyPath, 'KeyboardInterrupt')
    await closeNotebook(page, busyPath)
    await eventually(() => interruptPids.every((pid) => !alive(pid)), 'Default close did not stop the kernel.')
    console.log('PASS actual Python interrupt and default tab-close cleanup operate offline')

    const switching = await openNotebook(page, switchPath)
    await waitForCellSource(switching, 0, 'Ion finished in the background')
    await chooseNotebookPython(switching)
    await switching.getByTestId('notebook-run-cell').click()
    await eventually(async () => (await readFile(switchMarker, 'utf8').catch(() => '')) === 'started',
      'The tab-switch cell never entered the kernel.', 30_000)
    await openFromExplorer(page, project.program, '#include')
    await switching.waitFor({ state: 'hidden' })
    await writeFile(switchRelease, 'finished')
    await eventually(() => page.evaluate(async (path) => (await window.ion.notebooks.status(path)).state === 'idle', switchPath),
      'The Python cell did not finish while the normal source tab was selected.', 15_000)
    await atPath(page, 'tab', switchPath).locator('.tab-name').click()
    await notebookOutput(switching, 'Ion finished in the background').waitFor()
    await page.getByTestId('save-file').click()
    await eventually(async () => JSON.parse(await readFile(switchPath, 'utf8')).cells[0].outputs.some(({ output_type }) => output_type === 'stream'),
      'The background cell output should persist when saved.')
    await closeNotebook(page, switchPath)
    console.log('PASS a running notebook cell finishes while a normal source tab is active and keeps its output')

    const quit = await openNotebook(page, quitPath)
    await waitForCellSource(quit, 0, 'ion_benchmark_state = 42')
    await chooseNotebookPython(quit)
    await quit.getByTestId('notebook-kernel-lifetime').selectOption('window')
    await quit.getByTestId('notebook-run-cell').click()
    await notebookOutput(quit, 'Ion benchmark kernel is live').waitFor({ timeout: 30_000 })
    const quitPids = await kernelPids(session)
    await page.getByTestId('save-file').click()
    await eventually(async () => JSON.parse(await readFile(quitPath, 'utf8')).cells[0].outputs.some(({ output_type }) => output_type === 'stream'),
      'The final cell output should save before closing its tab.')
    await closeNotebook(page, quitPath)
    assert.ok(quitPids.length > 0 && quitPids.every(alive))
    await close(session)
    await eventually(() => quitPids.every((pid) => !alive(pid)), 'Quitting Ion did not stop the retained kernel.')
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    completed = true
    console.log('PASS quitting Ion reaps a retained window-lifetime kernel')
  } finally {
    await close(session).catch((error) => { if (completed) throw error })
  }
})
