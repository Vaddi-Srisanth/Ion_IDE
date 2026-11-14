import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./benchmark-integrated-terminal.mjs', import.meta.url))

test('real plan CLI preserves legacy modes and explicitly opts baseline into the matched terminal workload without opening an app', async t => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-terminal-benchmark-plan-')))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const target = join(scratch, 'missing-production-build'), output = join(scratch, 'must-not-be-created')
  for (const [args, expectedMode, expectedWorkload, expectedOptIn] of [
    [[], 'candidate', true, false],
    [['--mode', 'baseline'], 'baseline', false, false],
    [['--mode', 'baseline', '--matched-terminal-workload'], 'baseline', true, true],
    [['--mode', 'candidate', '--matched-terminal-workload'], 'candidate', true, true],
  ]) {
    const { stdout } = await execute(process.execPath, [script, '--plan', '--target', target, '--out', output, ...args], { timeout: 10000, maxBuffer: 8192 })
    const plan = JSON.parse(stdout)
    assert.equal(plan.mode, expectedMode)
    assert.equal(plan.terminalWorkload, expectedWorkload)
    assert.equal(plan.matchedTerminalWorkload, expectedOptIn)
    assert.equal(plan.measurementStatus, 'not-run')
    assert.equal(plan.trials, 3); assert.equal(plan.cycles, 8)
  }
  await assert.rejects(stat(target), { code: 'ENOENT' })
  await assert.rejects(stat(output), { code: 'ENOENT' })
})

test('plan validates workload limits and does not silently accept invalid comparison labels', async () => {
  for (const args of [['--mode', 'not-a-mode'], ['--trials', '0'], ['--cycles', '41']]) {
    await assert.rejects(execute(process.execPath, [script, '--plan', ...args], { timeout: 10000, maxBuffer: 8192 }), error => error.code === 1)
  }
})

test('a real preflight failure retains a bounded incomplete JSON receipt before any GUI launch', { skip: process.platform !== 'darwin' }, async t => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-terminal-benchmark-failure-')))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const target = join(scratch, 'missing-build'), output = join(scratch, 'receipts')
  await assert.rejects(execute(process.execPath, [script, '--target', target, '--out', output, '--trials', '1'],
    { timeout: 10000, maxBuffer: 8192 }), error => error.code === 1)
  const files = await readdir(output)
  assert.equal(files.length, 1)
  assert.match(files[0], /^terminal-candidate-.*\.json$/)
  const data = await readFile(join(output, files[0]))
  assert.ok(data.length <= 8 * 1024 ** 2)
  const report = JSON.parse(data)
  assert.equal(report.complete, false)
  assert.equal(report.phase, 'failed')
  assert.equal(report.failure.stage, 'preflight')
  assert.equal(report.failure.code, 'ENOENT')
  assert.match(report.failure.messageSha256, /^[a-f0-9]{64}$/)
  assert.equal(report.failure.message, undefined)
  assert.deepEqual(report.samples, [])
  await assert.rejects(stat(target), { code: 'ENOENT' })
})
