import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { pipeFixtureSources } from './pipe-fixture-source.mjs'

const source = await readFile(new URL('../../src/main/run-console/pty-windows.cpp', import.meta.url), 'utf8')
test('actual native source derives identical bounded controls from LF and Windows CRLF checkouts', () => {
  const lf = source.replaceAll('\r\n', '\n')
  const controls = pipeFixtureSources(lf)
  assert.deepEqual(pipeFixtureSources(lf.replaceAll('\n', '\r\n')), controls)
  assert.ok(controls.baseline.includes('CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT'))
  assert.ok(controls.detached.includes('CREATE_SUSPENDED | DETACHED_PROCESS | EXTENDED_STARTUPINFO_PRESENT'))
  assert.ok(!controls.baseline.includes('lpReserved2 = descriptors.data()'))
  assert.ok(!controls.detached.includes('lpReserved2 = descriptors.data()'))
})
test('missing, duplicated or altered control boundaries fail explicitly', () => {
  assert.throws(() => pipeFixtureSources(''), /launch flag/)
  assert.throws(() => pipeFixtureSources(source.replace('CRT_STDIO_INHERITANCE_BEGIN', 'missing')), /packet/)
  assert.throws(() => pipeFixtureSources(source + source), /launch flag/)
})
