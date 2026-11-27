import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WorkspaceFiles } from '../src/main/files'
import { TestExplorerService, type TestReview } from '../src/main/test-explorer/service'

const installedProject = process.env.ION_TEST_VITEST_PROJECT

async function evidence(path: string) {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
}

test('Vitest rejects unopened roots, missing and unsupported packages, and configuration edited during review', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-vitest-review-')))
  const root = join(directory, 'workspace'), profile = join(directory, 'profile')
  const packageRoot = join(root, 'node_modules', 'vitest'), config = join(root, 'vitest.config.mjs')
  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  const files = new WorkspaceFiles(), reviews: TestReview[] = []
  const service = new TestExplorerService({ profile: () => profile, files: () => files,
    approve: async review => { reviews.push(review); await writeFile(config, 'export default { test: {} }'); return true },
    execute: async () => assert.fail('No execution until the reviewed workspace and sources are current') })
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal((await service.discover(root, 'vitest')).status, 'failed')
  await files.grant(root, 'folder', true)
  const missing = await service.discover(root, 'vitest')
  assert.equal(missing.status, 'failed')
  assert.match(missing.message, /Install Vitest 4\.1\.x/)
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'vitest', version: '3.2.4' }))
  const unsupported = await service.discover(root, 'vitest')
  assert.equal(unsupported.status, 'failed')
  assert.match(unsupported.message, /supports project-local Vitest 4\.1\.x/)
  assert.equal(reviews.length, 0)
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'vitest', version: '4.1.0' }))
  await writeFile(join(packageRoot, 'dist', 'node.js'), 'export {}')
  await writeFile(join(packageRoot, 'dist', 'index.js'), 'export {}')
  await writeFile(config, 'export default {}')
  const changed = await service.discover(root, 'vitest')
  assert.equal(changed.status, 'failed')
  assert.match(changed.message, /changed while awaiting approval/)
  assert.equal(reviews.length, 1)
  assert.match(reviews[0].warning, /vitest\.config\.mjs/)
})

test('real project-local Vitest discovery, case and file selection, errors and Stop', { skip: !installedProject, timeout: 90_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-vitest-live-')))
  const root = join(directory, 'workspace'), profile = join(directory, 'profile')
  await mkdir(root)
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(join(installedProject!, 'node_modules'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  const imports = join(root, 'collected.txt'), bodies = join(root, 'executed.txt')
  const moduleHeader = [
    "import { describe, expect, it } from 'vitest'",
    "import { appendFileSync } from 'node:fs'",
    `const mark = value => appendFileSync(${JSON.stringify(bodies)}, value + '\\n')`,
    `appendFileSync(${JSON.stringify(imports)}, 'collected\\n')`,
  ]
  await writeFile(join(root, 'arithmetic.test.js'), [...moduleHeader,
    "describe('arithmetic', () => {",
    "  it.each([1, 2])('value %i', value => { mark('value ' + value); console.log('observed ' + value); expect(value).toBeGreaterThan(0) })",
    "  it('fails', () => { mark('fails'); throw new Error('arithmetic fixture failure') })",
    "  it.skip('skipped', () => { mark('skipped') })",
    '})',
  ].join('\n'))
  await writeFile(join(root, 'other.test.js'), [...moduleHeader,
    "it('unselected', () => { mark('unselected') })",
    "it('before slow', () => { mark('before slow') })",
    "it('slow', async () => { mark('slow'); await new Promise(resolve => setTimeout(resolve, 30_000)); mark('finished') })",
  ].join('\n'))
  await writeFile(join(root, 'dynamic.test.js'), [...moduleHeader,
    "import { readFileSync } from 'node:fs'",
    `const visits = ${JSON.stringify(join(directory, 'visits.txt'))}`,
    "appendFileSync(visits, 'v')",
    "const name = readFileSync(visits, 'utf8').length > 2 ? 'replacement' : 'reviewed'",
    "it(name, () => { mark(name) })",
  ].join('\n'))
  await writeFile(join(root, 'vitest.config.mjs'), [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(imports)}, 'config\\n')`,
    'export default {}',
  ].join('\n'))
  const files = new WorkspaceFiles()
  await files.grant(root, 'folder', true)
  const reviews: TestReview[] = []
  let approve = false
  const service = new TestExplorerService({ profile: () => profile, files: () => files,
    approve: async review => { reviews.push(review); return approve } })
  t.after(() => service.close())
  assert.equal(await service.list(root), null)
  assert.equal(reviews.length, 0)
  const denied = await service.discover(root, 'vitest')
  assert.equal(denied.status, 'cancelled', denied.message)
  assert.equal(await evidence(imports), '', 'No project code before discovery approval')
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].adapter, 'vitest')
  assert.match(reviews[0].warning, /project-local .*Vitest 4\.1\./)
  approve = true
  const discovered = await service.discover(root, 'vitest')
  assert.equal(discovered.status, 'completed', discovered.message)
  const snapshot = discovered.snapshot!
  assert.equal(snapshot.adapter, 'vitest')
  assert.equal(snapshot.nodes.filter(n => n.kind === 'test').length, 8)
  assert.equal(snapshot.nodes.filter(n => n.kind === 'file').length, 3)
  const chosen = snapshot.nodes.find(n => n.label.endsWith('value 2'))!
  assert.equal(chosen.location?.path, 'arithmetic.test.js')
  assert.equal(chosen.location?.line, 6)
  const collection = await evidence(imports)
  assert.match(collection, /config/)
  assert.match(collection, /collected/)
  assert.equal(await evidence(bodies), '', 'Discovery must not call test bodies')
  approve = false
  const declinedRun = await service.run(root, snapshot.revision, [chosen.id])
  assert.equal(declinedRun.status, 'cancelled', declinedRun.message)
  assert.equal(await evidence(imports), collection, 'No collection on a declined run')
  assert.equal(await evidence(bodies), '')
  approve = true
  const one = await service.run(root, snapshot.revision, [chosen.id])
  assert.equal(one.status, 'completed', one.message)
  const [onlyCase] = one.snapshot!.history.at(-1)!.cases
  assert.deepEqual(one.snapshot!.history.at(-1)!.selectedIds, [chosen.id])
  assert.equal(onlyCase.outcome, 'passed')
  assert.match(onlyCase.output, /observed 2/)
  assert.equal(await evidence(bodies), 'value 2\n', 'Siblings, including a parameterized sibling, were not executed')
  const group = snapshot.nodes.find(n => n.kind === 'file' && n.label === 'arithmetic.test.js')!
  const mixed = await service.run(root, one.snapshot!.revision, [group.id])
  assert.equal(mixed.status, 'completed', mixed.message)
  const history = mixed.snapshot!.history.at(-1)!
  assert.equal(history.adapter, 'vitest')
  assert.deepEqual(history.cases.map(c => c.outcome).sort(), ['failed', 'passed', 'passed', 'skipped'])
  assert.match(history.cases.find(c => c.outcome === 'failed')!.message, /arithmetic fixture failure/)
  assert.equal(await evidence(bodies), 'value 2\nvalue 1\nvalue 2\nfails\n')
  const slow = snapshot.nodes.find(n => n.label === 'slow')!
  const beforeSlow = snapshot.nodes.find(n => n.label === 'before slow')!
  const pending = service.run(root, mixed.snapshot!.revision, [beforeSlow.id, slow.id])
  try {
    const deadline = Date.now() + 15_000
    while (!(await evidence(bodies)).includes('\nslow\n') || !(await evidence(reviews.at(-1)!.args.at(-1)!)).includes('"outcome":"passed"')) {
      assert.ok(Date.now() < deadline, 'The fast result and the running slow body did not appear together')
      await delay(30)
    }
    assert.equal(service.cancel(), true)
    const stopped = await pending
    assert.equal(stopped.status, 'cancelled', stopped.message)
    assert.equal(stopped.snapshot!.history.at(-1)!.cases.find(c => c.id === slow.id)!.outcome, 'cancelled')
    assert.equal(stopped.snapshot!.history.at(-1)!.cases.find(c => c.id === beforeSlow.id)!.outcome, 'passed')
  } finally {
    service.cancel()
    await pending
  }
  await service.drain()
  assert.equal(service.busy, false)
  assert.doesNotMatch(await evidence(bodies), /finished|unselected|skipped/)
  const dynamic = snapshot.nodes.find(n => n.label === 'reviewed')!
  const changed = await service.run(root, (await service.list(root))!.revision, [dynamic.id])
  assert.equal(changed.status, 'failed', changed.message)
  assert.match(changed.message, /identity changed before execution/)
  assert.doesNotMatch(await evidence(bodies), /reviewed|replacement/, 'A changed test at the selected ordinal must not run')
  const lastRevision = changed.snapshot!.revision
  await writeFile(join(root, 'broken.test.js'), "throw new Error('broken during collection')\n")
  const failed = await service.discover(root, 'vitest')
  assert.equal(failed.status, 'failed', failed.message)
  assert.match(failed.message, /broken during collection/)
  assert.equal(failed.snapshot?.revision, lastRevision, 'Collection errors retain the previous tree')
  assert.deepEqual(reviews.map(r => r.operation), ['discover', 'discover', 'run', 'run', 'run', 'run', 'run', 'discover'])
})
