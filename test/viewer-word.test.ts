import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { openWord } from '../src/main/viewers/word'
import { encodeFixtureZip } from './fixtures/viewer-zip'

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const layout = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const packages = 'http://schemas.openxmlformats.org/package/2006/relationships'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/UqkAAAAASUVORK5CYII=', 'base64')

function wordXml(body: string) {
  return `<w:document xmlns:w="${word}" xmlns:a="${drawing}" xmlns:wp="${layout}" xmlns:r="${office}"><w:body>${body}</w:body></w:document>`
}

function picture(id: string) {
  return `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Image" descr="Study diagram"/><a:graphic><a:graphicData><a:blip r:embed="${id}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}

function paragraph(text: string) {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
}

async function fixture(t: TestContext, contents: Record<string, string | Uint8Array>) {
  const directory = await mkdtemp(join(tmpdir(), 'ion-word-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'Study notes.docx')
  const bytes = encodeFixtureZip(contents)
  await writeFile(path, bytes)
  return { path, bytes }
}

test('Word preview preserves formatting, tables, reading order and deferred images', async (t) => {
  const { path, bytes } = await fixture(t, {
    'word/document.xml': wordXml(
      '<w:p><w:pPr><w:pStyle w:val="CourseTitle"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Module &amp; Review</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc>' + paragraph('Concept') + '</w:tc><w:tc>' + paragraph('Example') + '</w:tc></w:tr></w:tbl>'
      + '<w:p><w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr><w:t>Before</w:t></w:r>'
      + picture('image1') + '<w:r><w:t>After</w:t></w:r></w:p>',
    ),
    'word/styles.xml': `<w:styles xmlns:w="${word}"><w:style w:type="paragraph" w:styleId="CourseTitle"><w:basedOn w:val="Heading2"/></w:style></w:styles>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${packages}"><Relationship Id="image1" Type="${office}/image" Target="media/diagram.png"/></Relationships>`,
    'word/media/diagram.png': png,
  })
  const doc = await openWord(path)
  try {
    assert.deepEqual(doc.page(0), {
      pageCount: 1,
      unsupported: false,
      blocks: [
        { kind: 'paragraph', heading: 2, runs: [{ text: 'Module & Review', bold: true }] },
        {
          kind: 'table',
          rows: [[
            [{ kind: 'paragraph', runs: [{ text: 'Concept' }] }],
            [{ kind: 'paragraph', runs: [{ text: 'Example' }] }],
          ]],
        },
        { kind: 'paragraph', runs: [{ text: 'Before', italic: true, underline: true }] },
        { kind: 'image', id: 'image1', alt: 'Study diagram', width: 100, height: 50 },
        { kind: 'paragraph', runs: [{ text: 'After' }] },
      ],
    })
    const raster = await doc.image('image1')
    assert.equal(raster.mime, 'image/png')
    assert.deepEqual(raster.bytes, png)
    assert.deepEqual(await readFile(path), bytes, 'preview leaves the original archive byte-for-byte unchanged')
  } finally {
    doc.close()
  }
  assert.throws(() => doc.page(0), /unavailable/)
  await assert.rejects(doc.image('image1'), /not part/)
})

test('Word preview caps section payloads for large documents and omits external or active content', async (t) => {
  const content = Array.from({ length: 700 }, (_, index) => paragraph(`Study paragraph ${index}`)).join('')
  const { path } = await fixture(t, {
    'word/document.xml': wordXml(content + '<w:p>' + picture('external') + '</w:p>'
      + '<w:altChunk r:id="html"/><w:p><w:object><w:r><w:t>Embedded object payload</w:t></w:r></w:object></w:p>'),
    'word/_rels/document.xml.rels': `<Relationships xmlns="${packages}">
      <Relationship Id="external" Type="${office}/image" Target="https://example.invalid/picture.png" TargetMode="External"/>
      <Relationship Id="html" Type="${office}/aFChunk" Target="malicious.html"/>
    </Relationships>`,
    'word/malicious.html': '<script>fetch("https://example.invalid")</script>',
    'word/vbaProject.bin': 'unused macro part',
  })
  const doc = await openWord(path)
  try {
    const first = doc.page(0)
    assert.equal(first.unsupported, true)
    assert.equal(first.blocks.length, 30)
    assert.ok(first.pageCount > 20)
    const last = doc.page(first.pageCount - 1)
    assert.match(JSON.stringify(last.blocks), /Study paragraph 699/)
    assert.doesNotMatch(JSON.stringify(last), /https:|Embedded object payload/)
    assert.throws(() => doc.page(first.pageCount), /unavailable/)
    await assert.rejects(doc.image('external'), /not part/)
    await assert.rejects(doc.image('../malicious.html'), /not part/)
  } finally {
    doc.close()
  }
})

test('Word preview fails clearly on malformed XML and rejects document type declarations', async (t) => {
  const { path } = await fixture(t, { 'word/document.xml': wordXml('<w:p>unterminated') })
  await assert.rejects(openWord(path), /malformed XML/)
  await writeFile(path, encodeFixtureZip({
    'word/document.xml': '<!DOCTYPE test [<!ENTITY exploit SYSTEM "file:///etc/passwd">]>'
      + wordXml(paragraph('&exploit;')),
  }))
  await assert.rejects(openWord(path), /document types or entities/)
})
