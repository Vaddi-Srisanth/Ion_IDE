import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { artifact, atPath, close, createProject, editorShows, launch, openFolder, openFromExplorer, sleep,
  stubDialogs, withScratch } from './desktop-harness.mjs'

const target = await artifact(process.argv[2] ?? 'dist')
assert.ok(!target.path.endsWith('.app'), 'Use the unpackaged production build for native dialog stubs.')
const fixture = await build({
  entryPoints: ['test/fixtures/viewer-tables.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
})
const { quotedCsv, largeCsv, workbookFixture } = await import(
  'data:text/javascript;base64,' + Buffer.from(fixture.outputFiles[0].text).toString('base64')
)
const execute = promisify(execFile)

async function openDocument(page, path, format) {
  await atPath(page, 'explorer-entry', path).click()
  await atPath(page, 'tab', path).waitFor()
  const viewer = page.locator('[data-testid="document-viewer"][data-format="' + format + '"]')
  await viewer.waitFor()
  return viewer
}

async function workbookSnapshot(pid) {
  const { stdout } = await execute('/usr/sbin/lsof', ['-nP', '-p', String(pid), '-Fn'])
  return stdout.split('\n').find((line) => line.startsWith('n') && /\/ion-preview-[^/]+\/input\.xlsx$/.test(line))?.slice(1)
}

async function waitForCleanup(file) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await access(file)
    } catch (reason) {
      if (reason.code === 'ENOENT') return
      throw reason
    }
    await sleep(50)
  }
  assert.fail('The preview snapshot was not removed after closing the workbook.')
}

await withScratch('table-viewers', async (scratch) => {
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const csv = join(project.directory, 'quoted.csv')
  const large = join(project.directory, 'large.csv')
  const xlsx = join(project.directory, 'workbook.xlsx')
  const corrupt = join(project.directory, 'corrupt.csv')
  const workbook = workbookFixture()
  await Promise.all([
    writeFile(csv, quotedCsv), writeFile(large, largeCsv(25_000)), writeFile(xlsx, workbook),
    writeFile(corrupt, 'Title,Value\n"broken,1'),
  ])
  const session = await launch(target, join(scratch, 'profile'))
  const { app, page } = session
  try {
    await app.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await app.evaluate(({ shell }) => {
      shell.openPath = async (path) => { globalThis.ionLastExternalDocument = path; return '' }
    })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, '#include')
    const editorHost = page.locator('[data-testid="editor"] .monaco-host')
    await editorHost.evaluate((node) => { node.dataset.ionTableOriginal = 'true' })

    const csvViewer = await openDocument(page, csv, 'csv')
    const csvGrid = csvViewer.getByTestId('table-grid')
    await csvGrid.getByText('Course, spring', { exact: true }).waitFor()
    await csvGrid.getByText('She said "hi"', { exact: true }).waitFor()
    assert.equal(await csvGrid.locator('td[title*="Line one"]').getAttribute('title'), 'Line one\nLine two')
    assert.equal(await csvGrid.getByText('=1+1', { exact: true }).textContent(), '=1+1')
    assert.equal(await page.getByTestId('save-file').isDisabled(), true)
    assert.match(await page.evaluate(async (path) => {
      try {
        await window.ion.saveFile(path, 'modified', 'invalid')
        return ''
      } catch (error) {
        return String(error)
      }
    }, csv), /read-only/i)
    await csvViewer.getByTestId('viewer-external').click()
    assert.equal(await app.evaluate(() => globalThis.ionLastExternalDocument), csv)
    assert.equal(await readFile(csv, 'utf8'), quotedCsv)
    await csvViewer.getByRole('button', { name: 'Zoom in' }).click()
    assert.equal(await csvViewer.getByRole('button', { name: 'Reset table zoom' }).textContent(), '125%')
    await csvViewer.getByRole('button', { name: 'Reset table zoom' }).click()

    await page.getByRole('button', { name: 'Find in File' }).click()
    const search = csvViewer.getByTestId('table-search')
    assert.equal(await search.evaluate((input) => document.activeElement === input), true)
    await search.fill('line two')
    await csvViewer.getByTestId('table-find-next').click()
    await csvViewer.getByText('Found B2.', { exact: true }).waitFor()
    await csvViewer.getByTestId('viewer-split').click()
    const split = page.getByTestId('document-split')
    await split.locator('.monaco-host[data-ion-table-original="true"] .monaco-editor').waitFor()
    await editorShows(page, '#include')
    await split.getByText('Course, spring', { exact: true }).waitFor()
    const divider = split.getByRole('separator', { name: 'Resize document split' })
    await divider.focus()
    await divider.press('ArrowRight')
    assert.equal(await divider.getAttribute('aria-valuenow'), '53')
    await atPath(page, 'close-tab', csv).click()
    await csvViewer.waitFor({ state: 'detached' })
    await editorShows(page, '#include')

    const largeViewer = await openDocument(page, large, 'csv')
    const largeGrid = largeViewer.getByTestId('table-grid')
    await largeGrid.getByText('Assignment 1', { exact: true }).waitFor()
    assert.equal(await largeGrid.locator('tbody tr').count(), 50)
    await largeViewer.getByTestId('table-next-rows').click()
    await largeGrid.getByText('Assignment 50', { exact: true }).waitFor()
    assert.equal(await largeGrid.locator('tbody tr').count(), 50)
    await largeViewer.getByTestId('table-search').fill('Final checkpoint')
    await largeViewer.getByTestId('table-find-next').click()
    await largeGrid.getByText('Final checkpoint', { exact: true }).waitFor()
    await largeViewer.getByText('Found C25001.', { exact: true }).waitFor()
    assert.equal(await largeGrid.locator('tbody tr').count(), 1)
    await atPath(page, 'close-tab', large).click()

    const workbookViewer = await openDocument(page, xlsx, 'xlsx')
    const workbookGrid = workbookViewer.getByTestId('table-grid')
    await workbookGrid.getByText('Operating Systems', { exact: true }).waitFor()
    await workbookGrid.getByText('30', { exact: true }).waitFor()
    await workbookGrid.getByText('[No cached formula value]', { exact: true }).waitFor()
    await workbookViewer.getByTestId('table-sheet-select').selectOption({ label: 'Assignments' })
    await workbookGrid.getByText('Project deadline', { exact: true }).waitFor()
    await workbookViewer.getByRole('textbox', { name: 'Go to cell address' }).fill('AC410')
    await workbookViewer.getByRole('button', { name: 'Go to cell' }).click()
    await workbookGrid.getByText('99', { exact: true }).waitFor()
    await workbookViewer.getByText('Showing AC410.', { exact: true }).waitFor()
    const snapshot = await workbookSnapshot(session.pid)
    assert.ok(snapshot, 'The workbook parser owns a private snapshot while the preview is visible.')
    await atPath(page, 'close-tab', xlsx).click()
    await workbookViewer.waitFor({ state: 'detached' })
    await waitForCleanup(snapshot)
    assert.deepEqual(await readFile(xlsx), workbook)

    const brokenViewer = await openDocument(page, corrupt, 'csv')
    await brokenViewer.getByTestId('viewer-error').waitFor()
    assert.match(await brokenViewer.getByTestId('viewer-error').textContent(), /could not be parsed/)
    await brokenViewer.getByTestId('viewer-external').waitFor()
    await atPath(page, 'close-tab', corrupt).click()
    await editorShows(page, '#include')
    assert.deepEqual(session.requests, [], 'Viewer never requested a remote resource.')
    assert.deepEqual(session.errors, [], 'Viewer kept errors out of the uncaught page channel.')
    console.log('PASS offline CSV and Excel tabs, quoted values, bounded paging, sheet selection, search, zoom, split view, read-only writes, errors and snapshot cleanup')
  } finally {
    await close(session)
  }
})
