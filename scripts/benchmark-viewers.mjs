import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, launch, openFolder, resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { pdfFixture } from './viewer-fixtures.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' }, cycles: { type: 'string', default: '5' } } })
assert.equal(process.platform, 'darwin')
const cycles = Number(values.cycles)
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 20)
const target = await artifact(values.target)
const pages = 160
const timestamp = new Date().toISOString()
const out = resolve('performance-results', `viewer-pdf-${timestamp.replaceAll(':', '-')}.json`)
await mkdir(resolve('performance-results'), { recursive: true })

await withScratch('viewer-bench', async (scratch) => {
  const probe = join(scratch, 'footprint')
  execFileSync('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const pdf = join(project.directory, 'notes.pdf')
  const bytes = pdfFixture(pages)
  await writeFile(pdf, bytes)
  const session = await launch(target, join(scratch, 'profile'))
  const { app, page } = session
  const sample = async () => {
    const { rssMiB, members } = await resourceSnapshot(session, { details: true })
    const counters = execFileSync(probe, members.map(({ pid }) => String(pid)), { encoding: 'utf8' })
    const charges = new Map(counters.trim().split('\n').map((line) => {
      const [pid, bytes] = line.split(' ').map(Number)
      return [pid, bytes / 1024 ** 2]
    }))
    const processes = members.map(({ pid, kind, rssMiB }) => ({ pid, kind, rssMiB, footprintMiB: charges.get(pid) ?? null }))
    return {
      rssMiB,
      footprintMiB: processes.every(({ footprintMiB }) => footprintMiB !== null)
        ? processes.reduce((sum, item) => sum + item.footprintMiB, 0) : null,
      processes,
      workers: page.workers().filter((worker) => worker.url().includes('pdf.worker')).length,
      canvases: await page.getByTestId('pdf-page-canvas').count(),
      editorParked: await page.locator('[data-testid="editor"].editor-parked').count() === 1,
    }
  }
  try {
    await app.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await atPath(page, 'explorer-entry', project.program).click()
    await editorShows(page, '#include')
    await sleep(1500)
    const before = await sample()
    assert.equal(before.workers, 0)
    const runs = []
    for (let cycle = 0; cycle < cycles; cycle++) {
      const start = performance.now()
      await atPath(page, 'explorer-entry', pdf).click()
      const canvas = page.locator('[data-rendered="true"] [data-testid="pdf-page-canvas"]')
      await canvas.first().waitFor()
      const openMs = performance.now() - start
      await sleep(1500)
      const documentOnly = await sample()
      await page.getByTestId('viewer-split').click()
      await page.getByTestId('document-split').waitFor()
      const pageInput = page.getByTestId('pdf-page-number')
      const number = 90 + cycle
      await pageInput.fill(String(number))
      await pageInput.press('Enter')
      await page.locator(`[data-page="${number}"] [data-rendered="true"] canvas`).waitFor().catch(async (error) => {
        const state = await page.evaluate(() => ({
          selected: document.querySelector('[data-testid="pdf-page-number"]')?.value,
          scrollTop: document.querySelector('.pdf-stage')?.scrollTop,
          pages: [...document.querySelectorAll('[data-page]')].map((item) => [item.dataset.page, item.textContent]),
        }))
        throw new Error(`PDF page jump failed. ${JSON.stringify(state)}`, { cause: error })
      })
      await sleep(1200)
      const visible = await sample()
      assert.equal(visible.workers, 1)
      assert.ok(visible.canvases > 0 && visible.canvases <= 5)
      await atPath(page, 'close-tab', pdf).click()
      await page.getByTestId('document-viewer').waitFor({ state: 'detached' })
      await sleep(1500)
      const closed = await sample()
      assert.equal(closed.workers, 0)
      assert.equal(closed.canvases, 0)
      runs.push({ cycle: cycle + 1, openMs, documentOnly, visible, closed })
    }
    assert.deepEqual(session.requests, [])
    await sleep(5000)
    const settled = await sample()
    assert.equal(settled.workers, 0)
    assert.equal(settled.canvases, 0)
    await writeFile(out, JSON.stringify({ timestamp, target: values.target, pages, fixtureBytes: bytes.length, before, runs, settled }, null, 2) + '\n')
    console.table(runs.map(({ cycle, openMs, documentOnly, visible, closed }) => ({
      cycle, openMs, documentOnlyRssMiB: documentOnly.rssMiB, visibleRssMiB: visible.rssMiB, closedRssMiB: closed.rssMiB,
      documentOnlyFootprintMiB: documentOnly.footprintMiB,
      visibleFootprintMiB: visible.footprintMiB, closedFootprintMiB: closed.footprintMiB,
    })))
    console.log('Before preview:', before)
    console.log('After final close and five extra seconds:', settled)
    console.log(out)
  } finally {
    await close(session)
  }
})
