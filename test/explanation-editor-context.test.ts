import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Documents } from '../src/renderer/documents'
import { captureEditorContext, diagnosticContext } from '../src/renderer/explanations/editor-context'
import { defaultSettings, type IonBridge } from '../src/shared/contracts'

function fixture() {
  let reads = 0, fullCopies = 0
  const documents = new Documents({ readFile: async () => { reads++; throw new Error('Context capture must not read files') },
    recovery: { write: async () => {}, remove: async () => {} } } as unknown as IonBridge,
  { ...defaultSettings, autoSave: false }, () => {}, () => {})
  let buffer = ''
  documents.attachModels({ getText: () => { fullCopies++; return buffer }, getTextPrefix: (_id, length) => buffer.slice(0, length), drop() {} })
  return { documents, set: (text: string) => { buffer = text }, calls: () => ({ reads, fullCopies }) }
}
test('explicit editor context uses the current unsaved prefix without disk reads or full model copies', async () => {
  const f = fixture(), entry = { kind: 'file' as const, name: 'Main.java', path: '/workspace/Main.java' }
  const id = f.documents.open(entry)!
  f.set('unsaved current code')
  const original = captureEditorContext(f.documents)!
  assert.equal(original.text, 'unsaved current code')
  f.set('edited while reviewing')
  f.documents.changed(id)
  const fresh = captureEditorContext(f.documents)!
  assert.equal(fresh.version, original.version + 1)
  assert.equal(fresh.text, 'edited while reviewing')
  assert.deepEqual(f.calls(), { reads: 0, fullCopies: 0 })
  await f.documents.finishWindowClose(false)
})
test('Unicode prefixes stay within UTF-8 limits without broken characters and never load an inactive file', async () => {
  const f = fixture()
  const first = f.documents.open({ kind: 'file', name: 'example.py', path: '/workspace/example.py' })!
  f.set('🙂'.repeat(5000))
  const context = captureEditorContext(f.documents)!
  assert.ok(Buffer.byteLength(context.text) <= 8192)
  assert.equal(context.text.includes('\ufffd'), false)
  assert.equal(context.text, '🙂'.repeat(2048))
  f.documents.open({ kind: 'file', name: 'second.py', path: '/workspace/second.py' })
  assert.equal(f.documents.activeTextPrefix(first, 8192), undefined)
  assert.equal(f.documents.activeTextPrefix(first, 9000), undefined)
  assert.deepEqual(f.calls(), { reads: 0, fullCopies: 0 })
  await f.documents.finishWindowClose(false)
})
test('read-only, conflicted and notebook documents cannot become editor context', async () => {
  const f = fixture()
  const id = f.documents.open({ kind: 'file', name: 'program.py', path: '/workspace/program.py' })!
  f.documents.markConflict(id, '/workspace/program.py')
  assert.equal(captureEditorContext(f.documents), undefined)
  f.documents.open({ kind: 'file', name: 'slides.pdf', path: '/workspace/slides.pdf' })
  assert.equal(captureEditorContext(f.documents), undefined)
  f.documents.open({ kind: 'file', name: 'notes.ipynb', path: '/workspace/notes.ipynb' })
  assert.equal(captureEditorContext(f.documents), undefined)
  assert.deepEqual(f.calls(), { reads: 0, fullCopies: 0 })
  await f.documents.finishWindowClose(false)
})

test('diagnostic review escapes terminal control bytes and bounds the disclosed UTF-8 text', () => {
  const raw = '\x1b[?25lNameError: missing\r\n' + '🙂'.repeat(2000)
  const excerpt = diagnosticContext(raw)
  assert.ok(excerpt.startsWith('\\u001b[?25lNameError: missing\r\n'))
  assert.equal(excerpt.includes('\x1b'), false)
  assert.ok(Buffer.byteLength(excerpt) <= 2048)
  assert.equal(excerpt.includes('\ufffd'), false)
  assert.ok(raw.startsWith('\x1b'))
})
