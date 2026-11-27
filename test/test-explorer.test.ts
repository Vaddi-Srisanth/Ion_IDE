import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceFiles } from '../src/main/files'
import { TestExplorerService, type TestExplorerOptions } from '../src/main/test-explorer/service'
import { TestRepository } from '../src/main/test-explorer/repository'
import { restoreStoredTests, testId, validateStoredTests } from '../src/main/test-explorer/model'
import { readPytestReport, type TestExecute, type TestPlan } from '../src/main/test-explorer/pytest'

const collected = ['test_one', 'test_two'].map((name, i) => ({ selector: 'test_sample.py::' + name, label: name, location: { path: 'test_sample.py', line: i * 2 + 1 } }))
const events = (run: boolean, partial = false) => [
  { kind: 'collection', nodes: collected },
  ...(run ? collected.slice(0, partial ? 1 : 2).map((node, i) => ({ kind: 'case', case: { selector: node.selector, outcome: i ? 'failed' : 'passed',
    durationMs: 3, message: i ? 'assert 1 == 2' : '', output: '', location: node.location, finished: true } })) : []),
  ...(partial ? [] : [{ kind: 'complete', version: 1, complete: true, exitCode: run ? 1 : 0, durationMs: 8, errors: [] }]),
]
const writeEvents = (path: string, rows: unknown[]) => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
const completed = (exitCode = 0) => ({ state: 'exited' as const, exitCode, output: '', outputComplete: true })

async function fixture(t: test.TestContext, changes: Partial<TestExplorerOptions> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-test-explorer-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'workspace'), profile = join(directory, 'profile')
  await mkdir(root)
  await writeFile(join(root, 'test_sample.py'), 'def test_one():\n    pass\ndef test_two():\n    assert False\n')
  const scope = new WorkspaceFiles(); await scope.grant(root, 'folder', true)
  let executions = 0, approvals = 0
  const execute: TestExecute = async (_executable, args) => {
    executions++
    const { readFile } = await import('node:fs/promises')
    const request = JSON.parse(await readFile(args.at(-2)!, 'utf8')) as { operation: string }
    await writeEvents(args.at(-1)!, events(request.operation === 'run'))
    return completed(request.operation === 'run' ? 1 : 0)
  }
  const service = new TestExplorerService({ profile: () => profile, files: () => scope, resolvePython: async () => process.execPath,
    approve: async () => { approvals++; return true }, execute, ...changes })
  t.after(() => service.close())
  return { directory, root, scope, profile, service, counts: () => ({ executions, approvals }), execute }
}

test('lazy lists never execute; real discovery records produce selected runs and bounded history', async t => {
  const f = await fixture(t)
  assert.equal(await f.service.list(f.root), null)
  assert.deepEqual(f.counts(), { executions: 0, approvals: 0 })
  const discovery = await f.service.discover(f.root)
  assert.equal(discovery.status, 'completed', discovery.message)
  let snapshot = discovery.snapshot!
  assert.equal(snapshot.nodes.filter(n => n.kind === 'test').length, 2)
  for (let i = 0; i < 12; i++) {
    const run = await f.service.run(f.root, snapshot.revision, [snapshot.nodes[0].id])
    assert.equal(run.status, 'completed', run.message)
    snapshot = run.snapshot!
  }
  assert.equal(snapshot.history.length, 10)
  assert.deepEqual(snapshot.history.at(-1)!.cases.map(c => c.outcome), ['passed', 'failed'])
  assert.equal(snapshot.history.at(-1)!.cases[0].label, 'test_one')
  const beforeList = f.counts()
  await f.service.list(f.root)
  assert.deepEqual(f.counts(), beforeList)
  await writeFile(join(f.root, 'test_sample.py'), '# changed\n')
  assert.equal((await f.service.list(f.root))?.stale, true)
  assert.equal((await f.service.run(f.root, snapshot.revision, [snapshot.nodes[0].id])).status, 'failed')
})

test('approval decline and cancellation are typed and do not erase earlier discovery', async t => {
  const f = await fixture(t)
  const saved = await f.service.discover(f.root)
  const declined = new TestExplorerService({ profile: () => f.profile, files: () => f.scope, resolvePython: async () => process.execPath,
    approve: async () => false, execute: async () => assert.fail('No execution after declined review') })
  t.after(() => declined.close())
  const result = await declined.discover(f.root)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.snapshot?.revision, saved.snapshot?.revision)
  let entered!: () => void
  const started = new Promise<void>(r => { entered = r })
  const pending = new TestExplorerService({ profile: () => f.profile, files: () => f.scope, resolvePython: async () => process.execPath,
    approve: (_review, signal) => { entered(); return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })) } })
  const job = pending.discover(f.root)
  await started; assert.equal(pending.busy, true); assert.equal(pending.cancel(), true)
  assert.equal((await job).status, 'cancelled'); await pending.close()
  assert.equal(pending.busy, false)
})

test('changed sources while awaiting consent cannot execute', async t => {
  const f = await fixture(t)
  const service = new TestExplorerService({ profile: () => f.profile, files: () => f.scope, resolvePython: async () => process.execPath,
    approve: async () => { await writeFile(join(f.root, 'test_sample.py'), '# edited'); return true },
    execute: async () => assert.fail('Changed sources must not execute') })
  const result = await service.discover(f.root)
  assert.equal(result.status, 'failed'); assert.match(result.message, /changed while awaiting/)
  await service.close()
})

test('completed run results become stale if saved code changes during execution', async t => {
  const f = await fixture(t)
  const discovered = await f.service.discover(f.root)
  const service = new TestExplorerService({ profile: () => f.profile, files: () => f.scope, resolvePython: async () => process.execPath,
    approve: async () => true, execute: async (executable, args, options) => {
      const result = await f.execute(executable, args, options)
      await writeFile(join(f.root, 'test_sample.py'), '# mutated during run\n')
      return result
    } })
  const result = await service.run(f.root, discovered.snapshot!.revision, [discovered.snapshot!.nodes[0].id])
  assert.equal(result.snapshot?.history.at(-1)?.stale, true)
  assert.match(result.message, /historical and stale/)
  await service.close()
})

test('cancel preserves complete earlier case events and marks unfinished cases cancelled', async t => {
  const f = await fixture(t), discovered = await f.service.discover(f.root)
  let entered!: () => void
  const started = new Promise<void>(r => { entered = r })
  const service = new TestExplorerService({ profile: () => f.profile, files: () => f.scope, resolvePython: async () => process.execPath, approve: async () => true,
    execute: async (_tool, args, options) => {
      await writeEvents(args.at(-1)!, events(true, true)); entered()
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { ...completed(), state: 'cancelled' }
    } })
  const job = service.run(f.root, discovered.snapshot!.revision, [discovered.snapshot!.nodes[0].id])
  await started; service.cancel()
  const result = await job
  assert.equal(result.status, 'cancelled', result.message)
  assert.deepEqual(result.snapshot?.history.at(-1)?.cases.map(c => c.outcome), ['passed', 'cancelled'])
  await service.close()
})

test('tools in a second root, stale revisions and unauthorized roots are rejected', async t => {
  const f = await fixture(t), second = join(f.directory, 'other-root')
  await mkdir(second); await f.scope.addRoot(second)
  const { copyFile, chmod } = await import('node:fs/promises')
  const tool = join(second, process.platform === 'win32' ? 'python.exe' : 'python')
  await copyFile(process.execPath, tool); await chmod(tool, 0o700)
  const unsafe = new TestExplorerService({ profile: () => f.profile, files: () => f.scope, resolvePython: async () => tool,
    approve: async () => assert.fail('Workspace executable must be rejected before approval') })
  assert.equal((await unsafe.discover(f.root)).status, 'failed')
  assert.equal((await f.service.discover(f.directory)).status, 'failed')
  const discovery = await f.service.discover(f.root)
  assert.equal((await f.service.run(f.root, 'old', [discovery.snapshot!.nodes[0].id])).status, 'failed')
  await unsafe.close()
})

test('restore keeps readable history but removes active discovery and authority; roots are portable inert metadata', async t => {
  const f = await fixture(t), discovery = await f.service.discover(f.root)
  await f.service.run(f.root, discovery.snapshot!.revision, [discovery.snapshot!.nodes[0].id])
  const saved = await new TestRepository(join(f.profile, 'test-explorer-v1')).read(f.root)
  const restored = restoreStoredTests(saved)
  assert.deepEqual(restored.selectors, {}); assert.deepEqual(restored.sources, {}); assert.deepEqual(restored.snapshot.nodes, [])
  assert.equal(restored.snapshot.history[0].restored, true); assert.equal(restored.snapshot.history[0].cases[0].label, 'test_one')
  for (const root of ['C:\\Users\\Example\\Project', '/Users/example/project']) {
    assert.equal(validateStoredTests({ ...restored, snapshot: { ...restored.snapshot, root } }).snapshot.root, root)
  }
  assert.throws(() => validateStoredTests({ ...restored, approved: true }), /fields/)
  assert.throws(() => validateStoredTests({ ...saved, sources: { '../escape.py': 'x' } }), /relative/)
})

test('report parser rejects spoofed locations, traversal, duplicate IDs and missing completion', async t => {
  const f = await fixture(t), report = join(f.directory, 'report.json')
  const plan: TestPlan = { executable: process.execPath, args: [], cwd: f.root, environment: {}, timeoutMs: 100, report, operation: 'run' }
  const good = events(true)
  await writeEvents(report, good)
  assert.equal((await readPytestReport(plan)).cases.length, 2)
  const spoofed = JSON.parse(JSON.stringify(good)) as Array<Record<string, unknown>>
  const first = spoofed[1].case as Record<string, unknown>; first.location = { path: 'different.py', line: 1 }
  await writeEvents(report, spoofed); await assert.rejects(readPytestReport(plan), /outcome/)
  await writeEvents(report, [good[0], good[1], good[1], good.at(-1)])
  await assert.rejects(readPytestReport(plan), /Duplicate/)
  await writeEvents(report, [{ kind: 'collection', nodes: [{ ...collected[0], selector: '../escape.py::test' }] }, good.at(-1)])
  await assert.rejects(readPytestReport(plan), /relative/)
  await writeEvents(report, good.slice(0, -1)); await assert.rejects(readPytestReport(plan), /finish/)
  assert.equal((await readPytestReport(plan, true)).complete, false)
  assert.equal(testId('a').length, 64)
})

test('unverified process cleanup remains sticky and blocks close, drain and subsequent work', async t => {
  const f = await fixture(t)
  const service = new TestExplorerService({ profile: () => f.profile, files: () => f.scope, resolvePython: async () => process.execPath,
    approve: async () => true, execute: async () => ({ ...completed(), outputComplete: false }) })
  const result = await service.discover(f.root)
  assert.equal(result.status, 'failed'); assert.equal(result.stage, 'cleanup')
  await assert.rejects(service.drain(), /could not be verified/)
  await assert.rejects(service.close(), /could not be verified/)
  const second = await service.discover(f.root)
  assert.equal(second.stage, 'cleanup')
})

test('a nonzero exit and all-passing rows cannot present a successful test run', async t => {
  const f = await fixture(t)
  const discovery = await f.service.discover(f.root)
  const snapshot = discovery.snapshot!
  const service = new TestExplorerService({ profile: () => f.profile, files: () => f.scope,
    resolvePython: async () => process.execPath, approve: async () => true,
    execute: async (_tool, args) => {
      const rows = events(true).map(row => 'case' in row ? { ...row, case: { ...row.case, outcome: 'passed' } } : row)
      await writeEvents(args.at(-1)!, rows)
      return completed(1)
    } })
  t.after(() => service.close())
  const result = await service.run(f.root, snapshot.revision, [snapshot.nodes[0].id])
  assert.equal(result.status, 'failed')
  assert.equal(result.snapshot?.history.at(-1)?.status, 'failed')
})
