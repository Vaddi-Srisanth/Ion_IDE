import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'
import { artifact, atPath, close, createProject, launch, openFolder, openFromExplorer, stubDialogs, withScratch } from './desktop-harness.mjs'
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

    step = 'PDF search and rendering'
    await openDocument(page, file('pdf'))
    const pdf = page.getByTestId('pdf-viewer')
    await pdf.locator('[data-page="1"] [data-rendered="true"] canvas').waitFor()
    await pdf.getByTestId('pdf-search').fill('process topology')
    await pdf.getByTestId('pdf-search').press('Enter')
    await pdf.getByTestId('pdf-search-results').filter({ hasText: 'Page 2' }).waitFor()
    await pdf.locator('[data-page="2"] [data-rendered="true"] canvas').waitFor()

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
      assert.match(message, /LibreOffice/i)
      if (process.platform === 'win32') assert.doesNotMatch(message, /for macOS/i)
      await page.getByRole('button', { name: 'Open in Default Application' }).waitFor()
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
