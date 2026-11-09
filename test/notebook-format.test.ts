import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notebookText, parseNotebook } from '../src/shared/notebook-format'
import { maxNotebookBytes } from '../src/shared/notebook-path'

const code = { id: 'sample-code', cell_type: 'code', metadata: {}, source: ['count = 2\n', 'print(count)'], execution_count: 1, outputs: [] }
const raw = { cell_type: 'raw', metadata: {}, source: 'Original source.' }
const document = (cells: unknown[], nbformat_minor = 5) => ({ nbformat: 4, nbformat_minor, metadata: {}, cells })

test('reads Jupyter 4 text, saved MIME data, attachments and extension fields without normalizing the document', () => {
  const notebook = {
    ...document([
      { ...code, outputs: [
        { output_type: 'stream', name: 'stdout', text: ['2\n'] },
        { output_type: 'error', ename: 'NameError', evalue: 'missing', traceback: ['first frame'] },
        { output_type: 'execute_result', execution_count: 1, metadata: {}, data: {
          'text/plain': '2', 'text/html': ['<table><tr><td>2</td></tr></table>'], 'application/vnd.example+json': { arbitrary: [1, 2] },
        } },
        { output_type: 'future-output', payload: { bytes: 'opaque' } },
      ] },
      { id: 'sample-markdown', cell_type: 'markdown', metadata: { vendor: { language: 'text' } }, source: '![example](attachment:plot.png)',
        attachments: { 'plot.png': { 'image/png': 'AA==' } }, future_field: 42 },
      { ...raw, id: 'sample-raw' },
      { cell_type: 'future-cell', metadata: {}, payload: [true, null] },
    ], 20),
    metadata: { language_info: { name: 'python' }, custom: { nested: ['{}', 'escaped \\ and "quotes"'] } },
    future: ['kept'],
  }
  const result = parseNotebook('\ufeff' + JSON.stringify(notebook))
  assert.deepEqual(result, notebook)
  assert.equal(notebookText(result.cells[0].source), 'count = 2\nprint(count)')
  assert.equal(notebookText(result.cells[0].source, 12), 'count = 2\npr')
  assert.equal(notebookText(result.cells[3].source), undefined)
  assert.deepEqual(parseNotebook(JSON.stringify(document([raw], 0))).cells[0], raw)
})

test('explains malformed notebooks, unsupported versions and invalid common structures', () => {
  assert.throws(() => parseNotebook('{"nbformat": 4'), /invalid JSON/)
  assert.throws(() => parseNotebook(JSON.stringify({ ...document([]), nbformat: 3 })), /Unsupported notebook format/)
  assert.throws(() => parseNotebook(JSON.stringify({ ...document([]), metadata: [] })), /Invalid notebook structure/)
  assert.throws(() => parseNotebook(JSON.stringify(document([{ ...code, source: [false] }]))), /cell 1.*source text/)
  assert.throws(() => parseNotebook(JSON.stringify(document([{ ...code, id: 'sample-code\n' }]))), /Invalid cell ID/)
  assert.throws(() => parseNotebook(JSON.stringify(document([code, code]))), /Duplicate cell ID/)
  assert.throws(() => parseNotebook(JSON.stringify(document([{ ...code, outputs: [{ output_type: 'error' }] }]))), /Invalid saved outputs/)
})

test('bounds UTF-8 size, JSON structure and cell count before displaying data', () => {
  const oversized = '"' + '密'.repeat(Math.ceil(maxNotebookBytes / 3)) + '"'
  assert.throws(() => parseNotebook(oversized), /16 MiB file limit/)
  assert.throws(() => parseNotebook('['.repeat(80) + '0' + ']'.repeat(80)), /nested too deeply/)
  assert.throws(() => parseNotebook('[' + '0,'.repeat(500_000) + '0]'), /too many entries/)
  assert.throws(() => parseNotebook(JSON.stringify(document(Array.from({ length: 10_001 }, () => raw)))), /10,000 cells/)
})
