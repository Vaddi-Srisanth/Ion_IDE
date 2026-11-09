import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { pdfFixture } from './viewer-fixtures.mjs'
import { artifact, atPath, close, createProject, launch, openFolder, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values: options } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, 'require-powerpoint': { type: 'boolean' },
  screenshots: { type: 'string' },
} })
const target = await artifact(options.target)
assert.ok(!target.path.endsWith('.app'), 'Use production build files for native dialog stubbing.')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
if (options.screenshots) await mkdir(options.screenshots, { recursive: true })
const capture = (page, name) => options.screenshots
  ? page.screenshot({ path: join(options.screenshots, `${name}.png`) }) : Promise.resolve()

async function coloredPixels(canvas, rgb, minimum = 10) {
  await canvas.waitFor({ timeout: 15_000 })
  const matches = await canvas.evaluate((element, color) => {
    const context = element.getContext('2d')
    const { data } = context.getImageData(0, 0, element.width, element.height)
    let count = 0
    for (let i = 0; i < data.length; i += 16) {
      if (Math.abs(data[i] - color[0]) < 18 && Math.abs(data[i + 1] - color[1]) < 18 && Math.abs(data[i + 2] - color[2]) < 18) count++
    }
    return count
  }, rgb)
  assert.ok(matches >= minimum, `Rendered preview contains expected pixels (${rgb.join(', ')})`)
}

const workerCount = (page) => page.workers().filter((worker) => worker.url().includes('pdf.worker')).length
async function expectWorkers(page, expected) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (workerCount(page) === expected) return
    await sleep(50)
  }
  assert.equal(workerCount(page), expected, 'PDF parser worker count')
}

async function openDocument(page, path) {
  await atPath(page, 'explorer-entry', path).click()
  await atPath(page, 'tab', path).waitFor()
}

async function closeDocument(page, path) {
  await atPath(page, 'close-tab', path).click()
  await atPath(page, 'tab', path).waitFor({ state: 'detached' })
}

await withScratch('paged-viewer', async (scratch) => {
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const pdfPath = join(project.directory, 'reading.pdf')
  const largePath = join(project.directory, 'lecture-notes.pdf')
  const corruptPath = join(project.directory, 'damaged.pdf')
  const oversizedPath = join(project.directory, 'oversized.pdf')
  const pptxPath = join(project.directory, 'slides.pptx')
  const documents = new Map([
    [pdfPath, pdfFixture(3)],
    [largePath, pdfFixture(160)],
    [corruptPath, Buffer.from('%PDF-1.4\nThis document is corrupted.\n')],
  ])
  await Promise.all([...Array.from(documents, ([path, bytes]) => writeFile(path, bytes)),
    copyFile(new URL('../test/fixtures/study-slides.pptx', import.meta.url), pptxPath)])
  await writeFile(oversizedPath, '%PDF-1.4\n')
  await truncate(oversizedPath, 96 * 1024 ** 2 + 1)
  documents.set(pptxPath, await readFile(pptxPath))
  const session = await launch(target, join(scratch, 'profile'))
  try {
    const { app, page } = session
    const rendererErrors = []
    page.on('pageerror', (error) => rendererErrors.push(error.stack ?? error.message))
    await app.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await expectWorkers(page, 0)
    await openDocument(page, pdfPath)
    const pdf = page.getByTestId('pdf-viewer')
    await pdf.waitFor()
    const pageCanvas = (number) => pdf.locator(`[data-page="${number}"] [data-rendered="true"] canvas`)
    await coloredPixels(pageCanvas(1), [209, 51, 61])
    await coloredPixels(pageCanvas(1), [41, 87, 199])
    await expectWorkers(page, 1)
    await pdf.getByRole('button', { name: 'Next page' }).click()
    assert.equal(await pdf.getByTestId('pdf-page-number').inputValue(), '2')
    await coloredPixels(pageCanvas(2), [209, 51, 61])
    await pdf.getByRole('button', { name: 'Fit to window' }).click()
    const zoom = pdf.getByRole('status', { name: 'Zoom level' })
    const fitted = await zoom.textContent()
    await pdf.getByRole('button', { name: 'Zoom in' }).click()
    assert.ok(Number.parseInt(await zoom.textContent(), 10) > Number.parseInt(fitted, 10))
    await pdf.locator('.pdf-stage').evaluate((element) => { element.scrollTop = 0 })
    await page.waitForFunction(() => document.querySelector('[data-testid="pdf-page-number"]')?.value === '1')
    await pdf.getByTestId('pdf-search').fill('process topology')
    await pdf.getByTestId('pdf-search').press('Enter')
    assert.match(await pdf.getByTestId('pdf-search-results').textContent(), /Page 2 · 1\/1/)
    assert.equal(await pdf.getByTestId('pdf-page-number').inputValue(), '2')
    await capture(page, 'pdf-search')
    await closeDocument(page, pdfPath)
    await expectWorkers(page, 0)
    assert.deepEqual(rendererErrors, [], 'No renderer errors after the PDF workflow')
    console.log('PASS offline PDF range rendering, page controls, zoom, search and worker cleanup')

    await openDocument(page, largePath)
    await pdf.waitFor()
    const number = pdf.getByTestId('pdf-page-number')
    await number.fill('145')
    await number.press('Enter')
    assert.equal(await number.inputValue(), '145')
    await coloredPixels(pageCanvas(145), [209, 51, 61])
    assert.ok(await pdf.getByTestId('pdf-page-canvas').count() <= 5, 'PDF only keeps a nearby canvas window')
    await closeDocument(page, largePath)
    await expectWorkers(page, 0)
    await openDocument(page, oversizedPath)
    assert.match(await page.getByTestId('viewer-error').textContent(), /up to 96 MiB/)
    await closeDocument(page, oversizedPath)
    await expectWorkers(page, 0)
    assert.deepEqual(rendererErrors, [], 'No renderer errors after the large PDF workflow')
    console.log('PASS 160-page PDF navigation and bounded canvas window')

    await openDocument(page, corruptPath)
    await page.getByTestId('pdf-error').waitFor({ timeout: 25_000 })
    assert.ok((await page.getByTestId('pdf-error').textContent())?.trim())
    await closeDocument(page, corruptPath)
    await expectWorkers(page, 0)
    assert.deepEqual(rendererErrors, [], 'No renderer errors after the corrupt PDF workflow')
    console.log('PASS corrupt PDF fails gracefully and releases its worker')

    await openDocument(page, pptxPath)
    const slides = page.getByTestId('powerpoint-viewer')
    const failure = page.getByTestId('viewer-error').or(page.getByTestId('pdf-error'))
    await slides.or(failure).waitFor({ timeout: 55_000 })
    if (await failure.isVisible()) {
      assert.match(await failure.textContent(), /Install a current LibreOffice for macOS/)
      assert.ok(!options['require-powerpoint'], 'LibreOffice was required but unavailable.')
      await page.getByRole('button', { name: 'Open in Default Application' }).waitFor()
      console.log('PASS missing LibreOffice displays setup and external-viewing fallback')
    } else {
      const slideCanvas = slides.locator('.pdf-slide-stage [data-rendered="true"] canvas')
      const thumb = (number) => slides.locator(`[data-testid="slide-thumbnail"][data-slide="${number}"]`)
      await coloredPixels(slideCanvas, [211, 50, 60])
      await coloredPixels(slideCanvas, [40, 86, 199])
      await coloredPixels(thumb(1).locator('[data-rendered="true"] canvas'), [211, 50, 60], 1)
      await thumb(2).click()
      assert.equal(await slides.getByTestId('pdf-page-number').inputValue(), '2')
      await coloredPixels(slideCanvas, [40, 86, 199])
      await coloredPixels(slideCanvas, [211, 50, 60])
      await capture(page, 'powerpoint-chart')
      await slides.getByRole('button', { name: 'Previous slide' }).click()
      assert.equal(await slides.getByTestId('pdf-page-number').inputValue(), '1')
      const slideZoom = slides.getByRole('status', { name: 'Zoom level' })
      const fitZoom = await slideZoom.textContent()
      await slides.getByRole('button', { name: 'Zoom in' }).click()
      assert.ok(Number.parseInt(await slideZoom.textContent(), 10) > Number.parseInt(fitZoom, 10))
      await slides.getByRole('button', { name: 'Fit to window' }).click()
      assert.equal(await slideZoom.textContent(), fitZoom)
      const presenting = page.locator('[data-testid="powerpoint-viewer"][data-fullscreen="true"]')
      const observeTransition = (event) => app.evaluate(({ BrowserWindow }, name) => {
        const win = BrowserWindow.getAllWindows()[0]
        globalThis.ionTestNativeTransition = new Promise((resolve) => {
          const complete = () => {
            clearTimeout(deadline)
            resolve(true)
          }
          const deadline = setTimeout(() => {
            win.off(name, complete)
            resolve(false)
          }, 5000)
          win.once(name, complete)
        })
      }, event)
      const awaitTransition = async () => assert.equal(await app.evaluate(() => globalThis.ionTestNativeTransition), true)
      await observeTransition('enter-full-screen')
      await slides.getByRole('button', { name: 'Present' }).click()
      await presenting.waitFor()
      await awaitTransition()
      await page.keyboard.press('ArrowRight')
      assert.equal(await slides.getByTestId('pdf-page-number').inputValue(), '2')
      await capture(page, 'powerpoint-presentation')
      await observeTransition('leave-full-screen')
      await presenting.getByRole('button', { name: 'Exit presentation' }).click()
      await presenting.waitFor({ state: 'detached' })
      await awaitTransition()
      await observeTransition('enter-full-screen')
      await slides.getByRole('button', { name: 'Present' }).click()
      await presenting.waitFor()
      await awaitTransition()
      await observeTransition('leave-full-screen')
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        win.focus()
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      })
      await presenting.waitFor({ state: 'detached' })
      await awaitTransition()
      console.log('PASS PowerPoint diagram and chart pixels, thumbnails, presentation mode and keyboard controls')
    }
    await closeDocument(page, pptxPath)
    await expectWorkers(page, 0)
    for (const [path, original] of documents) assert.equal(sha(await readFile(path)), sha(original), `Original file remains unchanged: ${path}`)
    assert.deepEqual(session.requests, [], 'Preview never attempted remote requests')
    assert.deepEqual(rendererErrors, [], 'No uncaught renderer errors')
    console.log('PASS viewers preserve originals and operate without network requests')
  } finally {
    await close(session)
  }
})
