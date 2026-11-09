import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NotebookEdits } from '../src/shared/notebook-edits'
import { notebookText, parseNotebook } from '../src/shared/notebook-format'

const firstSource = String.raw`[ "print(1)\r\n", "print(2)" ]`
const firstCell = '{"id":"first", "metadata": {"big_integer":9007199254740993}, "cell_type":"code", '
  + '"source"  : ' + firstSource + ', "outputs" : [{"output_type":"future_output", "payload":1e999}], "execution_count" : 7}'
const secondCell = '{ "cell_type":"markdown", "source":"![plot](attachment:plot.png)", "metadata":{}, '
  + '"attachments":{"plot.png":{"image/png":"AAAA"}}, "id":"second" }'
const original = '\ufeff{\r\n "nbformat":4, "nbformat_minor":5, "metadata":{"future":-0},\r\n "\\u0063ells" : [\r\n  '
  + firstCell + ',\r\n  ' + secondCell + '\r\n ],\r\n "unknown":{"value":1.234567890123456789}\r\n}\r\n'

test('preserves original notebook bytes and patches only the edited member', () => {
  const edits = new NotebookEdits(original)
  const first = edits.cells[0].key
  assert.equal(edits.serialize(), original)
  assert.equal(edits.setSource(first, 'print(1)\r\nprint(2)'), false)
  assert.equal(edits.setSource(first, 'x\r\ny\u2028z'), true)
  const expected = original.replace(firstSource, JSON.stringify(['x\r\n', 'y\u2028z']))
  assert.equal(edits.serialize(), expected)
  assert.equal(notebookText(parseNotebook(expected).cells[0].source), 'x\r\ny\u2028z')
  assert.equal(edits.undo(), true)
  assert.equal(edits.serialize(), original)
  assert.equal(edits.redo(), true)
  assert.equal(edits.serialize(), expected)
})

test('moves raw cell text without rewriting it and restores stable keys after deletion', () => {
  const edits = new NotebookEdits(original)
  const [first, second] = edits.cells.map(({ key }) => key)
  assert.equal(edits.moveCell(first, 1), true)
  assert.deepEqual(edits.cells.map(({ key }) => key), [second, first])
  assert.equal(edits.serialize(), original.replace(firstCell + ',\r\n  ' + secondCell, secondCell + ',\r\n  ' + firstCell))
  assert.equal(edits.deleteCell(first), true)
  assert.equal(parseNotebook(edits.serialize()).cells.length, 1)
  assert.equal(edits.undo(), true)
  assert.deepEqual(edits.cells.map(({ key }) => key), [second, first])
  assert.equal(edits.undo(), true)
  assert.equal(edits.serialize(), original)

  const added = edits.addCell('code', first)
  const saved = parseNotebook(edits.serialize())
  assert.deepEqual(edits.cells.map(({ key }) => key), [first, added, second])
  assert.match(saved.cells[1].id ?? '', /^[A-Za-z0-9_-]+$/)
  assert.equal(saved.cells[1].execution_count, null)
  assert.deepEqual(saved.cells[1].outputs, [])
  assert.equal(edits.canRedo, false)
})

test('requires explicit permission to drop outputs or attachments during a cell type change', () => {
  const edits = new NotebookEdits(original)
  const [first, second] = edits.cells.map(({ key }) => key)
  assert.equal(edits.conversionDropsData(first, 'raw'), true)
  assert.equal(edits.setCellType(first, 'raw'), false)
  assert.equal(edits.setCellType(first, 'raw', true), true)
  const serialized = edits.serialize()
  const updated = parseNotebook(serialized).cells[0]
  assert.equal(updated.cell_type, 'raw')
  assert.equal(updated.id, 'first')
  assert.equal(Object.hasOwn(updated, 'outputs'), false)
  assert.equal(Object.hasOwn(updated, 'execution_count'), false)
  assert.match(serialized, /"big_integer":9007199254740993/)
  assert.equal(edits.undo(), true)
  assert.equal(edits.serialize(), original)

  assert.equal(edits.setCellType(second, 'raw'), true)
  assert.deepEqual(parseNotebook(edits.serialize()).cells[1].attachments, parseNotebook(original).cells[1].attachments)
  assert.equal(edits.conversionDropsData(second, 'code'), true)
  assert.equal(edits.setCellType(second, 'code'), false)
  assert.equal(edits.setCellType(second, 'code', true), true)
  const converted = parseNotebook(edits.serialize()).cells[1]
  assert.equal(converted.id, 'second')
  assert.equal(Object.hasOwn(converted, 'attachments'), false)
  assert.deepEqual(converted.outputs, [])
})

test('updates execution results while preserving unsupported output entries as raw JSON', () => {
  const edits = new NotebookEdits(original)
  const first = edits.cells[0].key
  const output = { output_type: 'stream', name: 'stdout', text: 'complete\n' }
  assert.equal(edits.setExecution(first, 8, [output]), true)
  const serialized = edits.serialize()
  const updated = parseNotebook(serialized).cells[0]
  assert.equal(updated.execution_count, 8)
  assert.equal(updated.outputs?.[0].output_type, 'future_output')
  assert.deepEqual(updated.outputs?.[1], output)
  assert.match(serialized, /\{"output_type":"future_output", "payload":1e999\}/)
  assert.equal(edits.undo(), true)
  assert.equal(edits.serialize(), original)
})

test('maintains legacy notebook format and keeps the editing history bounded', () => {
  const empty = '{"nbformat":4, "nbformat_minor":0, "metadata":{}, "cells":[\r\n ]}'
  const edits = new NotebookEdits(empty)
  const first = edits.addCell('raw')
  edits.addCell('code', first)
  const saved = parseNotebook(edits.serialize())
  assert.equal(saved.nbformat_minor, 0)
  assert.equal(saved.cells[1].id, undefined)
  for (let index = 0; index < 80; index++) edits.moveCell(first, index % 2 ? -1 : 1)
  let undone = 0
  while (edits.undo()) undone++
  assert.ok(undone > 0 && undone < 80)
  assert.equal(edits.cells.length, 2)
})
