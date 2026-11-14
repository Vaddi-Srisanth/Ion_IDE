import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { collectReleaseEvidence, sanitizeReleaseJson } from './collect-release-gate-evidence.mjs'

const secret = 'DO_NOT_EXPORT_PRIVATE_EXCEPTION_TOKEN_OR_PATH'
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-release-evidence-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'performance-results'), out = join(root, 'artifacts')
  await mkdir(input)
  return { root, input, out }
}
const run = f => collectReleaseEvidence({ out: f.out, rootperformance: f.input })
async function allText(root) { return (await Promise.all((await readdir(root)).map(name => readFile(join(root, name), 'utf8')))).join('\n') }

test('sanitizer preserves metrics and failed gates while excluding private data and unknown labels', () => {
  const raw = { complete: false, status: 'failure', timeoutCount: 1, startupMs: 123.4, samples: [{ workingSetMiB: 210.4, cleanupVerified: true }],
    environment: { SECRET: secret, PIN: 987654321 }, message: secret, stdout: secret, argv: [secret], path: '/Users/' + secret,
    username: secret, token: 987654321, secretSha256: 'a'.repeat(64), arbitrary: secret, [secret]: 12 }
  const result = sanitizeReleaseJson(raw)
  assert.equal(result.reportedFailure, true)
  assert.equal(result.value.complete, false); assert.equal(result.value.status, 'failure')
  assert.equal(result.value.startupMs, 123.4); assert.equal(result.value.samples[0].workingSetMiB, 210.4)
  assert.equal(result.value.timeoutCount, 1)
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('987654321'))
  assert.ok(!JSON.stringify(result).includes('/Users/'))
  assert.ok(!JSON.stringify(result).includes('a'.repeat(64)))
  assert.equal(sanitizeReleaseJson({ success: true, errors: [], failure: {} }).reportedFailure, false)
  assert.equal(sanitizeReleaseJson({ success: false }).reportedFailure, true)
  assert.equal(sanitizeReleaseJson({ status: 'failed-verification' }).reportedFailure, true)
})
test('actual collector publishes only top-level JSON and approved image receipts, never binaries or profiles', async t => {
  const f = await fixture(t), images = join(f.root, 'image-publication')
  await mkdir(images)
  await writeFile(join(f.input, 'windows-candidate.json'), JSON.stringify({ complete: true, startupMs: 12, status: 'success', output: secret }))
  await writeFile(join(f.input, 'installer.exe'), secret)
  await mkdir(join(f.input, 'profile'))
  await writeFile(join(f.input, 'profile/secret.json'), secret)
  await writeFile(join(images, 'commands.json'), JSON.stringify({ commands: [secret], count: 3 }))
  await writeFile(join(images, 'summary.json'), JSON.stringify({ success: false, failure: secret }))
  await writeFile(join(images, 'unapproved.json'), secret)
  await writeFile(join(images, 'image.dmg'), secret)
  const result = await collectReleaseEvidence({ out: f.out, rootperformance: f.input, imageReceipts: images })
  assert.equal(result.collectionStatus, 'complete')
  assert.equal(result.releaseDecision, 'not-evaluated')
  assert.equal(result.containsReportedFailures, true)
  assert.deepEqual((await readdir(f.out)).sort(), ['image-commands.json', 'image-summary.json', 'index.json', 'performance-windows-candidate.json'])
  assert.ok(!(await allText(f.out)).includes(secret))
})
test('existing output cannot be merged or overwritten', async t => {
  const f = await fixture(t)
  await mkdir(f.out); await writeFile(join(f.out, 'private.json'), secret)
  await assert.rejects(run(f), { code: 'EEXIST' })
  assert.equal(await readFile(join(f.out, 'private.json'), 'utf8'), secret)
})
test('malformed, oversized and redirected receipts create visible gaps and preserve failure state', async t => {
  const f = await fixture(t)
  await writeFile(join(f.input, 'broken.json'), '{broken' + secret)
  await writeFile(join(f.input, 'oversized.json'), 'x'.repeat(8 * 1024 ** 2 + 1))
  const outside = join(f.root, 'outside.json'); await writeFile(outside, JSON.stringify({ message: secret }))
  try { await symlink(outside, join(f.input, 'redirect.json')) }
  catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error }
  const result = await run(f)
  assert.equal(result.collectionStatus, 'incomplete')
  assert.ok(result.gaps.includes('receipt-invalid-redirected-or-over-budget'))
  assert.ok(result.gaps.includes('no-json-evidence-captured'))
  assert.ok(result.receipts.every(row => !row.captured))
  assert.deepEqual(await readdir(f.out), ['index.json'])
  assert.ok(!(await allText(f.out)).includes(secret))
})
test('missing performance folder still writes a failed collection index, not fake test passes', async t => {
  const f = await fixture(t)
  const result = await collectReleaseEvidence({ out: f.out, rootperformance: join(f.root, 'missing') })
  assert.equal(result.collectionStatus, 'incomplete')
  assert.equal(result.releaseDecision, 'not-evaluated')
  assert.ok(result.gaps.includes('performance-folder-missing-or-redirected'))
  assert.equal(result.receipts.length, 0)
})
test('depth and entry limits are visible; no unbounded traversal', async t => {
  let deep = { status: 'failed' }
  for (let i = 0; i < 30; i++) deep = { summary: deep }
  const sanitized = sanitizeReleaseJson(deep)
  assert.equal(sanitized.limited, true)
  const f = await fixture(t)
  for (let i = 0; i < 129; i++) await writeFile(join(f.input, `receipt-${i}.json`), '{}')
  const result = await run(f)
  assert.equal(result.collectionStatus, 'incomplete')
  assert.ok(result.gaps.includes('receipt-file-limit-exceeded'))
  assert.equal(result.receipts.length, 128)
})

test('output exhaustion still preserves a bounded failure index instead of silently losing the collection result', async t => {
  const f = await fixture(t)
  const value = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['unknown' + i, 'private fixture value']))
  const bytes = JSON.stringify(value)
  for (let i = 0; i < 12; i++) await writeFile(join(f.input, `expanding-${i}.json`), bytes)
  const result = await run(f)
  assert.equal(result.collectionStatus, 'incomplete')
  assert.ok(result.gaps.includes('receipt-invalid-redirected-or-over-budget'))
  assert.ok(result.receipts.some(row => !row.captured))
  const index = JSON.parse(await readFile(join(f.out, 'index.json'), 'utf8'))
  assert.equal(index.collectionStatus, 'incomplete')
  const { stat } = await import('node:fs/promises')
  const sizes = await Promise.all((await readdir(f.out)).map(name => stat(join(f.out, name))))
  assert.ok(sizes.reduce((total, info) => total + info.size, 0) <= 16 * 1024 ** 2)
})
