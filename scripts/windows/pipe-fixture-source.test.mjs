import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { pipeFixtureSources } from './pipe-fixture-source.mjs'

const source = (await readFile(new URL('../../src/main/run-console/pty-windows.cpp', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
test('actual native source derives identical bounded controls from LF and Windows CRLF checkouts', () => {
  const lf = source.replaceAll('\r\n', '\n')
  const controls = pipeFixtureSources(lf)
  assert.deepEqual(pipeFixtureSources(lf.replaceAll('\n', '\r\n')), controls)
  assert.ok(controls.baseline.includes('CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT'))
  assert.ok(controls.detached.includes('CREATE_SUSPENDED | DETACHED_PROCESS | EXTENDED_STARTUPINFO_PRESENT'))
  assert.ok(!controls.baseline.includes('lpReserved2 = descriptors.data()'))
  assert.ok(!controls.detached.includes('lpReserved2 = descriptors.data()'))
  for (const control of Object.values(controls)) {
    const pipe = control.slice(control.indexOf('int pipeProcess('), control.indexOf('}  // namespace'))
    assert.equal(pipe.split('ResumeThread(').length, 2, 'Historical suspended controls must actually resume their initial thread.')
    assert.ok(pipe.includes('PROC_THREAD_ATTRIBUTE_HANDLE_LIST'))
    assert.ok(pipe.includes('jobListAttribute, jobs'))
  }
})
test('missing, duplicated or altered control boundaries fail explicitly', () => {
  assert.throws(() => pipeFixtureSources(''), /launch flag/)
  assert.throws(() => pipeFixtureSources(source.replace('if (!report(ready))', 'if (!report(missing))')), /readiness boundary/)
  assert.throws(() => pipeFixtureSources(source + source), /launch flag/)
  assert.throws(() => pipeFixtureSources(source.replace('  thread.reset();\n', '  ResumeThread(thread.get());\n  thread.reset();\n')), /manual ResumeThread/)
})
