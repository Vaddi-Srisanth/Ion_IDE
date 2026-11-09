import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer, stubDialogs, withScratch } from './desktop-harness.mjs'
import { encodeNotebook, smallNotebook } from './notebook-fixtures.mjs'
import { pdfFixture } from './viewer-fixtures.mjs'

const compiledFixtures = await build({
  stdin: { contents: `export * from './test/fixtures/viewer-tables'; export * from './test/fixtures/viewer-zip';`,
    resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
})
const { encodeFixtureZip, quotedCsv, workbookFixture } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiledFixtures.outputFiles[0].text).toString('base64')
)

function wordFixture() {
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  return encodeFixtureZip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    'word/document.xml': `<w:document xmlns:w="${word}"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Study guide</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Word table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`,
  })
}

async function openDocument(page, file) {
  await atPath(page, 'explorer-entry', file).click()
  await atPath(page, 'tab', file).waitFor()
}

async function workspace(page, mode) {
  await page.getByRole('button', { name: 'Welcome', exact: true }).click()
  await page.getByTestId('workspace-' + mode).click()
  await page.locator(`[data-testid="workspace"][data-mode="${mode}"]`).waitFor()
}

async function verifyFileDrop(page, path, marker) {
  const dropped = atPath(page, 'tab', path)
  const before = await page.evaluate(async ({ path, name, url }) => {
    const read = async () => {
      try { await window.ion.readFile(path); return true } catch { return false }
    }
    const priorGrant = await read()
    const transfer = new DataTransfer()
    transfer.items.add(new File(['forged content'], name, { type: 'text/plain' }))
    transfer.setData('text/uri-list', url)
    const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
    document.querySelector('[data-testid="explorer"]').dispatchEvent(event)
    return { priorGrant, syntheticTrusted: event.isTrusted, syntheticGrant: await read() }
  }, { path, name: basename(path), url: pathToFileURL(path).href })
  assert.deepEqual(before, { priorGrant: false, syntheticTrusted: false, syntheticGrant: false })
  assert.equal(await dropped.count(), 0, 'A page-created drag event cannot open external files.')

  const bounds = await page.getByTestId('explorer').boundingBox()
  assert.ok(bounds?.width && bounds?.height, 'File Explorer is visible.')
  const cdp = await page.context().newCDPSession(page)
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', {
        type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
        data: { items: [], files: [path], dragOperationsMask: 1 },
      })
    }
    await dropped.waitFor()
    await (await editorShows(page, marker)).dispose()
  } finally {
    await cdp.detach()
  }
  await atPath(page, 'close-tab', path).click()
  await dropped.waitFor({ state: 'detached' })
  console.log('PASS a trusted Chromium file drop opens a Unicode path outside the workspace, while page-created drag data cannot grant access.')
}

await withScratch('windows-native', async (scratch) => {
  const project = await createProject(join(scratch, 'Café & study workspace'), { fileCount: 0 })
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({
    version: 1, settings: { autoSave: false, openFullScreen: false, checkUpdatesOnLaunch: false },
  }))
  const file = (extension) => join(project.directory, 'Study notes.' + extension)
  const documents = new Map([
    [file('pdf'), pdfFixture(3)], [file('docx'), wordFixture()], [file('csv'), quotedCsv],
    [file('xlsx'), workbookFixture()], [file('markdown'), '# Ion study notes\n\n| Field | Value |\n| --- | --- |\n| Mode | Offline |\n'],
    [file('ipynb'), encodeNotebook(smallNotebook())],
    [file('pptx'), await readFile(new URL('../test/fixtures/study-slides.pptx', import.meta.url))],
  ])
  await Promise.all([...documents].map(([path, contents]) => writeFile(path, contents)))
  const session = await launch(await artifact(process.argv[2] ?? 'dist'), profile)
  const { app, page } = session
  let step = 'workspace open'
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, '#include')

    if (process.platform === 'win32') {
      step = 'external file drop'
      const external = join(scratch, 'Café outside the workspace.txt')
      const marker = 'ION-WINDOWS-EXTERNAL-DROP'
      await writeFile(external, marker)
      await verifyFileDrop(page, external, marker)
    }

    step = 'PDF search and rendering'
    await openDocument(page, file('pdf'))
    const pdf = page.getByTestId('pdf-viewer')
    await pdf.locator('[data-page="1"] [data-rendered="true"] canvas').waitFor()
    await pdf.getByTestId('pdf-search').fill('process topology')
    await pdf.getByTestId('pdf-search').press('Enter')
    await pdf.getByTestId('pdf-search-results').filter({ hasText: 'Page 2' }).waitFor()
    await pdf.locator('[data-page="2"] [data-rendered="true"] canvas').waitFor()
    await page.getByTestId('viewer-split').click()
    await page.getByTestId('document-split').waitFor()
    await (await editorShows(page, '#include')).dispose()
    await atPath(page, 'close-tab', file('pdf')).click()
    await eventually(() => !page.workers().length, 'Closing the PDF did not release its renderer worker.')

    step = 'DOCX and tabular previews'
    await openDocument(page, file('docx'))
    await page.getByTestId('word-viewer').getByRole('cell', { name: 'Word table cell' }).waitFor()
    await openDocument(page, file('csv'))
    const grid = page.getByTestId('table-grid')
    await grid.getByText('Course, spring', { exact: true }).waitFor()
    assert.equal(await grid.locator('td[title*="Line one"]').getAttribute('title'), 'Line one\nLine two')
    assert.ok(await page.getByTestId('save-file').isDisabled(), 'CSV opens read only')
    await openDocument(page, file('xlsx'))
    await grid.getByText('Operating Systems', { exact: true }).waitFor()
    await page.getByTestId('table-sheet-select').selectOption({ label: 'Assignments' })
    await grid.getByText('Project deadline', { exact: true }).waitFor()

    step = 'Markdown and notebook previews'
    await openDocument(page, file('markdown'))
    await page.getByTestId('markdown-preview-toggle').click()
    const markdown = page.getByTestId('markdown-preview')
    await markdown.getByRole('heading', { name: 'Ion study notes' }).waitFor()
    await markdown.getByRole('cell', { name: 'Offline' }).waitFor()
    await openDocument(page, file('ipynb'))
    const notebook = page.getByTestId('notebook-view')
    await notebook.getByRole('heading', { name: 'Notebook study fixture' }).waitFor()
    await notebook.getByText('saved Markdown', { exact: true }).waitFor()

    step = 'PowerPoint rendering or explicit external-viewer fallback'
    await openDocument(page, file('pptx'))
    const slides = page.getByTestId('powerpoint-viewer')
    const unavailable = page.getByTestId('viewer-error').or(page.getByTestId('pdf-error'))
    await slides.or(unavailable).waitFor({ timeout: 55_000 })
    if (await unavailable.isVisible()) {
      const message = await unavailable.textContent()
      assert.match(message, process.platform === 'win32' ? /PowerPoint conversion.*Open in Default Application/i : /LibreOffice/i)
      await app.evaluate(({ shell }) => {
        shell.openPath = async (path) => {
          globalThis.ionNativeExternalDocument = path
          return ''
        }
      })
      await page.getByRole('button', { name: 'Open in Default Application' }).click()
      await eventually(async () => await app.evaluate(() => globalThis.ionNativeExternalDocument) === file('pptx'),
        'PowerPoint fallback did not pass the original presentation to the OS.')
      console.log('PASS PowerPoint explicitly offers an external viewer when offline conversion is unavailable.')
    } else {
      await slides.locator('.pdf-slide-stage [data-rendered="true"] canvas').waitFor()
      await slides.locator('[data-testid="slide-thumbnail"][data-slide="2"]').click()
      assert.equal(await slides.getByTestId('pdf-page-number').inputValue(), '2')
      await slides.locator('.pdf-slide-stage [data-rendered="true"] canvas').waitFor()
      console.log('PASS PowerPoint renders local slides and navigates by thumbnail.')
    }

    step = 'Learn and Projects workspace switching'
    await workspace(page, 'learn')
    const learn = page.getByTestId('learning-pane')
    await learn.getByTestId('learning-open-marketplace').click()
    const marketplace = page.getByTestId('marketplace-pane')
    await marketplace.getByTestId('marketplace-search').fill('javascript')
    await marketplace.locator('[data-testid="marketplace-install"][data-pack="javascript"]').click()
    await marketplace.locator('[data-testid="marketplace-use"][data-pack="javascript"]').click()
    await learn.getByRole('combobox', { name: 'Language' }).locator('option:checked').filter({ hasText: 'JavaScript' }).waitFor({ state: 'attached' })
    await learn.getByTestId('learning-topic').first().click()
    await learn.getByTestId('learning-pack-lesson').waitFor()
    await workspace(page, 'projects')
    const roadmap = page.getByTestId('projects-panel')
    await roadmap.waitFor()
    if (!await roadmap.getByTestId('project-title').count()) {
      await page.locator('.titlebar').getByTestId('open-folder').click()
    }
    await roadmap.getByTestId('project-title').fill('Study project')
    await roadmap.getByTestId('project-description').fill('Save the plan locally.')
    await roadmap.getByTestId('project-create').click()
    await roadmap.getByRole('heading', { name: 'Study project' }).waitFor()
    await workspace(page, 'learn')
    await learn.getByTestId('learning-topic').first().waitFor()
    await workspace(page, 'projects')
    await roadmap.getByRole('heading', { name: 'Study project' }).waitFor()

    for (const [path, bytes] of documents) assert.deepEqual(await readFile(path), Buffer.from(bytes), path)
    assert.deepEqual(session.requests, [], 'The workbench made no outbound renderer requests.')
    assert.deepEqual(session.errors, [])
    console.log(`PASS ${process.platform} production renderer previews PDF, DOCX, CSV, XLSX, Markdown and Jupyter offline and retains Learn and Projects state.`)
  } catch (error) {
    throw new Error(`Native desktop smoke failed during ${step}.`, { cause: error })
  } finally {
    await close(session)
  }
})
