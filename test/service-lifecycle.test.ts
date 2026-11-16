import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LearningService } from '../src/main/learning'
import { isSelfContainedC, maxAutomaticSourceBytes, SavedTestQueue } from '../src/main/projects/automatic'
import { CRunner, detectCompiler } from '../src/main/runner'

test('automatic C accepts standard headers and declines unreviewed preprocessing', () => {
  assert.equal(isSelfContainedC('#include <stdio.h>\nint main(void) { puts("ok"); }\n'), true)
  assert.equal(isSelfContainedC(' # include <math.h>\r\nint main(void) { return 0; }\r\n'), true)
  for (const source of [
    '#include "local.h"',
    '#include <local.h>',
    '#include_next <stdio.h>',
    '#define HEADER <stdio.h>\n#include HEADER',
    '#pragma GCC dependency "local.h"',
    '_Pragma("clang module import Local")',
    '__pragma(comment(lib, "local"))',
    '%:include "local.h"',
    '??=include "local.h"',
    '#inc\\\nlude "local.h"',
    '// continued \\ \n#include "local.h"',
    '__asm__(".incbin \\"local.bin\\"")',
    '#include <stdio.h>\n#if 0\n#include "local.h"\n#endif',
    'a'.repeat(maxAutomaticSourceBytes + 1),
  ]) assert.equal(isSelfContainedC(source), false, source.slice(0, 150))
})

const saved = (revision: string) => ({ revision, digest: 'fixture' })

test('automatic saves coalesce and closing removes pending work', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const runs: string[] = []
  const queue = new SavedTestQueue(async (source, value) => { runs.push(source + ':' + value.revision) }, 10)
  queue.push('main.c', saved('first'))
  context.mock.timers.tick(9)
  queue.push('main.c', saved('second'))
  context.mock.timers.tick(9)
  assert.deepEqual(runs, [])
  context.mock.timers.tick(1)
  await Promise.resolve()
  assert.deepEqual(runs, ['main.c:second'])
  queue.push('main.c', saved('third'))
  queue.clear()
  context.mock.timers.tick(10)
  assert.deepEqual(runs, ['main.c:second'])
})

test('new source revisions and closing abort active automatic tests', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: AbortSignal[] = []
  const revisions: string[] = []
  const queue = new SavedTestQueue(async (_source, value, signal) => {
    revisions.push(value.revision)
    signals.push(signal)
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  }, 10)
  queue.push('main.c', saved('first'))
  context.mock.timers.tick(10)
  assert.equal(signals[0].aborted, false)
  queue.push('main.c', saved('second'))
  assert.equal(signals[0].aborted, true)
  context.mock.timers.tick(10)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(revisions, ['first', 'second'])
  queue.clear()
  assert.equal(signals[1].aborted, true)
})

test('shutdown waits for an automatic test owner through its final evidence publication', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const directory = await mkdtemp(join(tmpdir(), 'ion-evidence-drain-'))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const queue = new SavedTestQueue(async () => { await held; await writeFile(join(directory, 'evidence.json'), '{"complete":true}') }, 10)
  try {
    queue.push('first.c', saved('one')); context.mock.timers.tick(10)
    assert.equal(queue.running, true)
    queue.push('second.c', saved('two')); context.mock.timers.tick(10)
    queue.clear()
    let settled = false
    const drain = queue.settle().then(() => { settled = true })
    await Promise.resolve(); assert.equal(settled, false)
    release(); await drain
    assert.equal(await readFile(join(directory, 'evidence.json'), 'utf8'), '{"complete":true}')
    assert.equal(queue.running, false)
  } finally { release(); queue.clear(); await queue.settle(); await rm(directory, { recursive: true, force: true }) }
})

test('saved-snapshot compilation uses checked bytes and revalidates before process launch', async context => {
  const signal = new AbortController().signal
  const compiler = await detectCompiler(signal)
  if (!compiler) return context.skip('No installed C compiler.')
  const directory = await mkdtemp(join(tmpdir(), 'ion-snapshot-test-'))
  try {
    const path = join(directory, 'sample??.c')
    await writeFile(path, 'this disk content must not be compiled')
    const runner = new CRunner(undefined, async () => compiler)
    const snapshot = '#include <stdio.h>\nint main(void) { puts(__FILE__); return 0; }'
    let checks = 0
    const result = await runner.runSavedSnapshot(path, snapshot, '', async () => ++checks < 3, signal)
    assert.equal(result.status, 'success')
    assert.equal(result.programStdout, path + '\n')
    assert.equal(checks, 2)
    const rejected = await runner.runSavedSnapshot(path, snapshot, '', async () => false, signal)
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.compileMs, undefined)
    assert.equal(runner.busy, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('closing learning releases the history cache after pending writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-learning-lifecycle-'))
  try {
    const file = join(directory, 'history.json')
    const service = new LearningService(file)
    const write = service.recordTopic('statements', 'selected')
    await service.release()
    await write
    const other = new LearningService(file)
    assert.equal((await other.getHistory()).topics[0].selected, 1)
    await other.clearHistory()
    assert.deepEqual(await service.getHistory(), { categories: [], topics: [] })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
