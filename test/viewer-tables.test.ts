import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { openTable } from '../src/main/viewers/tables'
import { largeCsv, quotedCsv, workbookFixture } from './fixtures/viewer-tables'

async function scratch(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ion-table-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('CSV preserves quoted commas, line breaks, escaped quotes and formula-like text', async (t) => {
  const path = join(await scratch(t), 'quoted.csv')
  await writeFile(path, quotedCsv)
  const document = await openTable(path, 'csv')
  t.after(() => document.close())
  assert.deepEqual(document.sheets, [{ id: 'csv', name: 'CSV' }])
  const page = await document.page('csv', 0, 0, 20, 10)
  assert.deepEqual(page.cells, [
    ['Title', 'Notes', 'Value'],
    ['Course, spring', 'Line one\nLine two', '42'],
    ['She said "hi"', 'plain', '=1+1'],
  ])
  assert.deepEqual(await document.search('csv', 'LINE TWO'), { row: 1, column: 1 })
  assert.equal(await readFile(path, 'utf8'), quotedCsv)
  await assert.rejects(document.page('csv', 0, 0, 81, 1), /Invalid table page/)
  await assert.rejects(document.search('csv', '', { row: 0, column: 0 }), /1 and 160/)
  document.close()
  await assert.rejects(document.page('csv', 0, 0, 1, 1), /unavailable/)
})

test('CSV handles semicolon, tab and pipe delimiters and common encodings', async (t) => {
  const dir = await scratch(t)
  const semicolon = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name;Price\r\n"Café; créme";1,50\r\n', 'utf16le')])
  const windows = Buffer.from([0x54, 0x69, 0x74, 0x6c, 0x65, 0x09, 0x43, 0x6f, 0x73, 0x74, 0x0a,
    0x43, 0x61, 0x66, 0xe9, 0x09, 0x80, 0x31])
  const cases: [string, Buffer, string[][]][] = [
    ['utf16.csv', semicolon, [['Name', 'Price'], ['Café; créme', '1,50']]],
    ['windows.csv', windows, [['Title', 'Cost'], ['Café', '€1']]],
    ['pipe.csv', Buffer.from('Name|Value\n"A|B"|12'), [['Name', 'Value'], ['A|B', '12']]],
  ]
  for (const [name, bytes, cells] of cases) {
    const path = join(dir, name)
    await writeFile(path, bytes)
    const document = await openTable(path, 'csv')
    try {
      assert.deepEqual((await document.page('csv', 0, 0, 4, 4)).cells, cells)
    } finally {
      document.close()
    }
  }
})

test('CSV returns only requested pages and wraps the search over a large file', async (t) => {
  const path = join(await scratch(t), 'large.csv')
  await writeFile(path, largeCsv(25_000))
  const document = await openTable(path, 'csv')
  t.after(() => document.close())
  const page = await document.page('csv', 24_990, 1, 16, 2)
  assert.equal(page.rowCount, 25_001)
  assert.equal(page.columnCount, 3)
  assert.equal(page.cells.length, 11)
  assert.deepEqual(page.cells.at(-1), ['Assignment 25000', 'Final checkpoint'])
  assert.deepEqual(await document.search('csv', 'waiting', { row: 24_999, column: 2 }), { row: 1, column: 2 })
  assert.deepEqual(await document.search('csv', 'FINAL CHECKPOINT'), { row: 25_000, column: 2 })
})

test('CSV rejects malformed quotes, oversized files and unbounded field counts', async (t) => {
  const path = join(await scratch(t), 'corrupt.csv')
  await writeFile(path, 'Name,Value\n"Unclosed,1')
  await assert.rejects(openTable(path, 'csv'), /could not be parsed/)
  await writeFile(path, ','.repeat(2_000))
  await assert.rejects(openTable(path, 'csv'), /1,024 columns/)
  await truncate(path, 24 * 1024 * 1024 + 1)
  await assert.rejects(openTable(path, 'csv'), /24 MiB/)
})

test('XLSX pages multiple sparse worksheets and shows cached formulas and shared strings', async (t) => {
  const path = join(await scratch(t), 'workbook.xlsx')
  const bytes = workbookFixture()
  await writeFile(path, bytes)
  const document = await openTable(path, 'xlsx')
  t.after(() => document.close())
  assert.deepEqual(document.sheets, [{ id: 'sheet-1', name: 'Courses' }, { id: 'sheet-2', name: 'Assignments' }])
  const first = await document.page('sheet-1', 0, 0, 4, 4)
  assert.deepEqual(first.cells, [
    ['Operating Systems', '', 'TRUE'],
    ['', '', ''],
    ['Data Structures', '30', '[No cached formula value]'],
  ])
  assert.deepEqual(await document.search('sheet-1', 'DATA STRUCTURES'), { row: 2, column: 0 })
  const second = await document.page('sheet-2', 0, 0, 3, 3)
  assert.equal(second.rowCount, 410)
  assert.equal(second.columnCount, 29)
  assert.equal(second.cells[1][1], 'Project deadline')
  assert.deepEqual((await document.page('sheet-2', 409, 28, 2, 2)).cells, [['99']])
  assert.deepEqual((await document.page('sheet-1', 0, 0, 4, 4)).cells, first.cells)
  assert.deepEqual(await readFile(path), bytes)
})

test('XLSX opens healthy worksheets when another part is malformed and blocks DTDs', async (t) => {
  const path = join(await scratch(t), 'corrupt.xlsx')
  await writeFile(path, workbookFixture('<!DOCTYPE worksheet [<!ENTITY remote SYSTEM "https://example.invalid/">]><worksheet/>'))
  const document = await openTable(path, 'xlsx')
  t.after(() => document.close())
  assert.equal((await document.page('sheet-1', 0, 0, 1, 1)).cells[0][0], 'Operating Systems')
  await assert.rejects(document.page('sheet-2', 0, 0, 1, 1), /document type declaration/)
  assert.equal((await document.page('sheet-1', 0, 0, 1, 1)).cells[0][0], 'Operating Systems')
  document.close()
  await writeFile(path, 'Damaged archive')
  await assert.rejects(openTable(path, 'xlsx'))
})
