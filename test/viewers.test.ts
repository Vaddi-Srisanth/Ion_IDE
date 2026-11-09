import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { WorkspaceFiles } from '../src/main/files'
import { ViewerService } from '../src/main/viewers'
import { verifyPresentation } from '../src/main/viewers/verify-presentation'
import { encodeFixtureZip } from './fixtures/viewer-zip'

test('PDF preview reads only authorized ranges and releases the closed session', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ion-viewer-test-'))
  const files = new WorkspaceFiles()
  const viewer = new ViewerService(files)
  t.after(async () => {
    await viewer.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const pdf = join(directory, 'reading.pdf')
  await writeFile(pdf, '%PDF-1.7\npreview bytes')
  const request = 'aff0a79d-2dc8-46c8-938e-389e04849bc8'
  await assert.rejects(viewer.open(pdf, request), /Open the file/)
  await files.grant(pdf)
  const preview = await viewer.open(pdf, request)
  assert.equal(preview.format, 'pdf')
  assert.equal(Buffer.from(await viewer.readPdf(preview.id, 0, 8)).toString(), '%PDF-1.7')
  await assert.rejects(viewer.readPdf(preview.id, 0, 256 * 1024 + 1), /range/)
  await assert.rejects(viewer.readPdf(preview.id, -1, 1), /range/)
  await writeFile(pdf, '%PDF-1.7\nreplacement bytes')
  await assert.rejects(viewer.readPdf(preview.id, 0, 8), /changed on disk/)
  await viewer.close(preview.id)
  await assert.rejects(viewer.readPdf(preview.id, 0, 8), /no longer open/)
})

test('PowerPoint preflight accepts chart data and rejects active or remote parts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-deck-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await verifyPresentation(resolve('test/fixtures/study-slides.pptx'))
  const deck = join(directory, 'study.pptx')
  const parts = { '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<presentation/>' }
  await writeFile(deck, encodeFixtureZip({ ...parts, 'ppt/vbaProject.bin': 'macro' }))
  await assert.rejects(verifyPresentation(deck), /active content/)
  await writeFile(deck, encodeFixtureZip({
    ...parts, 'ppt/slides/_rels/slide1.xml.rels':
      '<Relationships><Relationship Type="urn:office/image" TargetMode="External" Target="https://example.invalid/diagram.png"/></Relationships>',
  }))
  await assert.rejects(verifyPresentation(deck), /external resource/)
  await writeFile(deck, encodeFixtureZip({
    ...parts, 'ppt/slides/slide1.xml': '<!DOCTYPE slide SYSTEM "file:///etc/passwd"><slide/>',
  }))
  await assert.rejects(verifyPresentation(deck), /XML declarations/)
})
