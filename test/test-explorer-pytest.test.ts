import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { WorkspaceFiles } from '../src/main/files'
import { TestExplorerService } from '../src/main/test-explorer/service'

// CI/local verification supplies an explicitly installed pytest environment.
// The application still resolves it through its real filtered PATH discovery.
const python = process.env.ION_TEST_PYTEST_PYTHON
test('real pytest production discovery, parameterized execution, failures and cancellation', { skip: !python, timeout: 60_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-pytest-live-')))
  const root = join(directory, 'workspace'), profile = join(directory, 'profile')
  await mkdir(root)
  const originalPath = process.env.PATH
  process.env.PATH = dirname(python!) + delimiter + (originalPath ?? '')
  t.after(async () => { process.env.PATH = originalPath; await rm(directory, { recursive: true, force: true }) })
  await writeFile(join(root, 'test_real.py'), [
    'import pytest', 'import time',
    '@pytest.mark.parametrize("value", [1, 2])', 'def test_parameter(value):', '    assert value > 0',
    'def test_failure():', '    assert 1 == 2',
    '@pytest.mark.skip(reason="fixture skip")', 'def test_skipped():', '    pass',
    'def test_slow():', '    print("started", flush=True)', '    time.sleep(30)',
  ].join('\n'))
  const files = new WorkspaceFiles(); await files.grant(root, 'folder', true)
  const approved: string[] = []
  const service = new TestExplorerService({ profile: () => profile, files: () => files,
    approve: async review => { approved.push(review.executable); return true } })
  t.after(() => service.close())
  const discovery = await service.discover(root)
  assert.equal(discovery.status, 'completed', discovery.message)
  assert.equal(discovery.snapshot!.nodes.filter(n => n.kind === 'test').length, 5)
  assert.equal(dirname(approved[0]), dirname(python!), 'Production discovery preserves the external venv launcher')
  let snapshot = discovery.snapshot!
  const selected = snapshot.nodes.filter(n => n.kind === 'test' && n.label !== 'test_slow').map(n => n.id)
  const run = await service.run(root, snapshot.revision, selected)
  assert.equal(run.status, 'completed', run.message)
  assert.deepEqual(run.snapshot!.history.at(-1)!.cases.map(c => c.outcome).sort(), ['failed', 'passed', 'passed', 'skipped'])
  assert.match(run.snapshot!.history.at(-1)!.cases.find(c => c.outcome === 'failed')!.message, /assert 1 == 2/)
  snapshot = run.snapshot!
  const slow = snapshot.nodes.find(n => n.label === 'test_slow')!
  const pending = service.run(root, snapshot.revision, [slow.id])
  const timer = setTimeout(() => service.cancel(), 700)
  try {
    const stopped = await pending
    assert.equal(stopped.status, 'cancelled', stopped.message)
    assert.equal(stopped.snapshot!.history.at(-1)!.cases[0].outcome, 'cancelled')
  } finally { clearTimeout(timer) }
  await service.drain()
  await service.close()
  assert.equal(service.busy, false)
})
