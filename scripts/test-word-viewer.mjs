import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { crc32, deflateSync } from 'node:zlib'
import { artifact, atPath, close, createProject, editorShows, launch, openFolder, openFromExplorer, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values: { target: targetPath } } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(targetPath)
assert.ok(!target.path.endsWith('.app'), 'Use the production build directory for native dialog stubbing.')
const execute = promisify(execFile)
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const layout = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const pictureNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
const contentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types'
const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`

function pngChunk(name, data) {
  const id = Buffer.from(name)
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length)
  id.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([id, data])), 8 + data.length)
  return chunk
}

function sampleDiagram() {
  const width = 160
  const height = 64
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bar = y > 10 && y < 53 && (x > 22 && x < 57 || x > 95 && x < 130)
      const bridge = y > 28 && y < 35 && x >= 57 && x <= 95
      const color = bar ? [22, 127, 117] : bridge ? [59, 105, 173] : [240, 244, 248]
      rows.set(color, y * (1 + width * 3) + 1 + x * 3)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function createWordFile(directory, path) {
  const sections = Array.from({ length: 72 }, (_, index) => paragraph(`Study paragraph ${index + 1}`)).join('')
  const files = {
    '[Content_Types].xml': `<Types xmlns="${contentTypes}">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
    </Types>`,
    '_rels/.rels': `<Relationships xmlns="${relationships}">
      <Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/>
    </Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${relationships}">
      <Relationship Id="diagram" Type="${office}/image" Target="media/study-diagram.png"/>
      <Relationship Id="styles" Type="${office}/styles" Target="styles.xml"/>
    </Relationships>`,
    'word/styles.xml': `<w:styles xmlns:w="${word}">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
    </w:styles>`,
    'word/document.xml': `<w:document xmlns:w="${word}" xmlns:a="${drawing}" xmlns:wp="${layout}" xmlns:pic="${pictureNamespace}" xmlns:r="${office}">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Study notes</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Review flow</w:t></w:r></w:p>
        <w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>
          <w:tr><w:tc>${paragraph('Input')}</w:tc><w:tc>${paragraph('Output')}</w:tc></w:tr>
        </w:tbl>
        <w:p><w:r><w:drawing><wp:inline>
          <wp:extent cx="1524000" cy="609600"/>
          <wp:docPr id="1" name="Study diagram" descr="Input linked to output"/>
          <a:graphic><a:graphicData uri="${pictureNamespace}"><pic:pic>
            <pic:nvPicPr><pic:cNvPr id="1" name="Study diagram"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip r:embed="diagram"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
            <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1524000" cy="609600"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
          </pic:pic></a:graphicData></a:graphic>
        </wp:inline></w:drawing></w:r></w:p>
        ${sections}
      </w:body>
    </w:document>`,
    'word/media/study-diagram.png': sampleDiagram(),
  }
  await Promise.all(Object.entries(files).map(async ([name, data]) => {
    const file = join(directory, name)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, data)
  }))
  await execute('/usr/bin/zip', ['-q', path, ...Object.keys(files)], { cwd: directory })
}

await withScratch('word-viewer', async (scratch) => {
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const document = join(project.directory, 'Study notes.docx')
  const broken = join(project.directory, 'Damaged.docx')
  await createWordFile(join(scratch, 'office-parts'), document)
  await writeFile(project.program, '#include <stdio.h>\nint main(void) {\n    puts("viewer-fold-marker");\n    return 0;\n}\n')
  await writeFile(broken, 'this is not a ZIP package')
  const before = await readFile(document)
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { autoSave: false } }))
  const session = await launch(target, profile)
  try {
    const { app, page } = session
    await app.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, '#include')
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(({ name }) => /WordViewer/.test(name))), false)
    const editor = page.locator('.monaco-editor')
    await editor.locator('.codicon-folding-expanded').first().click()
    await editor.locator('.codicon-folding-collapsed').first().waitFor({ state: 'visible' })
    await editor.locator('.view-line').first().click({ position: { x: 80, y: 8 } })
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.insertText(' // preview-undo-marker')
    await editorShows(page, 'preview-undo-marker')
    for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+ArrowLeft')
    const selection = editor.locator('.view-overlays .selected-text').first()
    await selection.waitFor({ state: 'visible' })
    await page.evaluate(() => {
      const revoke = URL.revokeObjectURL.bind(URL)
      globalThis.revokedWordImages = []
      URL.revokeObjectURL = (url) => {
        globalThis.revokedWordImages.push(url)
        revoke(url)
      }
    })

    await atPath(page, 'explorer-entry', document).click()
    await atPath(page, 'tab', document).waitFor()
    const viewer = page.getByTestId('word-viewer')
    const section = viewer.getByTestId('word-page')
    await section.getByRole('heading', { name: 'Study notes', level: 1 }).waitFor()
    const parked = page.locator('.editor-surface.editor-parked')
    await parked.waitFor({ state: 'attached' })
    await parked.locator('.view-line').first().waitFor({ state: 'detached' })
    await section.getByRole('table').getByRole('cell', { name: 'Output' }).waitFor()
    assert.equal(await section.getByText('Review flow').evaluate((node) => getComputedStyle(node).fontWeight), '700')
    const image = section.getByTestId('word-image')
    await image.waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="word-image"]')?.naturalWidth === 160)
    const objectURL = await image.getAttribute('src')
    assert.match(objectURL, /^blob:/)
    assert.equal(await page.getByTestId('save-file').isDisabled(), true)
    await assert.rejects(page.evaluate((path) => window.ion.saveFile(path, 'forbidden write', ''), document), /read.only/i)
    await app.evaluate(({ shell }) => {
      globalThis.openedWordFile = new Promise((resolve) => {
        shell.openPath = async (path) => {
          resolve(path)
          return ''
        }
      })
    })
    await page.getByTestId('viewer-external').click()
    assert.equal(await app.evaluate(() => globalThis.openedWordFile), document)
    await viewer.getByTestId('word-find').fill('review')
    await section.locator('mark').getByText('Review', { exact: true }).waitFor()
    await viewer.getByTestId('word-zoom').selectOption('125')
    assert.equal(await section.evaluate((node) => getComputedStyle(node).fontSize), '20px')

    await viewer.getByTestId('word-next').click()
    await viewer.getByText('Section 2 of 3').waitFor()
    await section.getByText('Study paragraph 27', { exact: true }).waitFor()
    await page.waitForFunction((url) => globalThis.revokedWordImages.includes(url), objectURL)
    await page.getByTestId('viewer-split').click()
    await editorShows(page, '#include')
    await editor.waitFor({ state: 'visible' })
    await editor.locator('.codicon-folding-collapsed').first().waitFor({ state: 'visible' })
    await editorShows(page, 'preview-undo-marker')
    await selection.waitFor({ state: 'visible' })
    await editor.locator('.view-line').first().click({ position: { x: 80, y: 8 } })
    await page.keyboard.press('Meta+z')
    await page.waitForFunction(() => !document.querySelector('.monaco-editor .view-lines')?.textContent?.includes('preview-undo-marker'))
    await page.getByTestId('save-file').click()
    await page.getByRole('separator', { name: 'Resize document split' }).waitFor()
    await viewer.getByText('Section 2 of 3').waitFor()
    assert.equal(await viewer.getByTestId('word-zoom').inputValue(), '125', 'split retains preview state')
    assert.equal(await viewer.getByTestId('word-find').inputValue(), 'review')
    assert.equal(await viewer.locator('[contenteditable="true"], textarea').count(), 0)
    assert.deepEqual(await readFile(document), before)

    await atPath(page, 'close-tab', document).click()
    await viewer.waitFor({ state: 'detached' })
    await editorShows(page, '#include')
    await atPath(page, 'explorer-entry', broken).click()
    await atPath(page, 'tab', broken).waitFor()
    await page.getByTestId('document-viewer').getByRole('alert').waitFor()
    await atPath(page, 'close-tab', broken).click()
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    console.log('PASS offline DOCX headings, inline formatting, table and raster image')
    console.log('PASS section search, zoom, navigation, side-by-side code and image resource disposal')
    console.log('PASS original archive unchanged and malformed DOCX safely handled')
  } finally {
    await close(session)
  }
})
