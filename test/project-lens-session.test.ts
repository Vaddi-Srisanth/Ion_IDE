import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { WorkspaceFiles } from '../src/main/files'
import { ProjectLensSession } from '../src/main/project-lens/session'

async function fixture(t: TestContext, scope = new WorkspaceFiles()) {
  const temporary = await mkdtemp(join(tmpdir(), 'ion-lens-session-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  await mkdir(join(temporary, 'src'))
  await writeFile(join(temporary, 'src/main.js'), 'console.log("fixture");\n')
  await writeFile(join(temporary, 'package.json'), '{"main":"src/main.js","module":"missing.js","dependencies":{"react":"19"}}\n')
  const root = (await scope.grant(temporary, 'folder')).path
  return { root, scope }
}

test('session opens only inspected evidence with the exact recorded range and revision', async t => {
  const { root, scope } = await fixture(t)
  const session = new ProjectLensSession(() => scope)
  t.after(() => session.close())
  const snapshot = await session.analyze(root)
  assert.equal(snapshot.status, 'complete')
  const source = snapshot.files.find(file => file.reference.path === 'src/main.js')!.reference
  const manifest = snapshot.manifests[0].reference
  const opened = await session.openReference(root, source)
  assert.deepEqual(opened, { entry: { name: 'main.js', kind: 'file', path: join(root, 'src/main.js') } })
  assert.deepEqual((await session.openReference(root, manifest)).range, manifest.range)
  const declaration = snapshot.entryPoints.find(entry => entry.kind === 'manifest-reference')!
  assert.equal(declaration.path, 'missing.js')
  assert.equal((await session.openReference(root, declaration.reference)).entry.path, join(root, 'package.json'))
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(source), true)
})

test('arbitrary references, forged ranges, new files, traversal and wrong roots are rejected', async t => {
  const { root, scope } = await fixture(t)
  const session = new ProjectLensSession(() => scope)
  const snapshot = await session.analyze(root)
  const manifest = snapshot.manifests[0].reference
  await writeFile(join(root, 'added.js'), '1')
  await assert.rejects(session.openReference(root, { ...manifest, path: 'added.js' }), /not part/)
  await assert.rejects(session.openReference(root, { ...manifest, path: 'missing.js' }), /not part/)
  await assert.rejects(session.openReference(root, { ...manifest, path: '../outside.js' }), /Invalid/)
  await assert.rejects(session.openReference(root, { ...manifest, path: '/absolute.js' }), /Invalid/)
  await assert.rejects(session.openReference(root, { ...manifest, path: 'src\\main.js' }), /Invalid/)
  await assert.rejects(session.openReference(root, { ...manifest, revision: 'forged' }), /not part/)
  await assert.rejects(session.openReference(root, { ...manifest, extra: 'unexpected' }), /Invalid/)
  await assert.rejects(session.openReference(root, { ...manifest, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 999 } }), /not part/)
  await assert.rejects(session.openReference(root, { ...manifest, range: { startLine: 0, startColumn: 1, endLine: 1, endColumn: 1 } }), /Invalid/)
  await assert.rejects(session.openReference(join(root, 'src'), manifest), /Analyze the current folder again/)
  await assert.rejects(session.analyze(join(root, 'src')), /exact currently open folder/)
  session.close()
})

test('external edits and symlink replacement invalidate evidence rather than opening a different file', async t => {
  const { root, scope } = await fixture(t)
  const session = new ProjectLensSession(() => scope)
  t.after(() => session.close())
  const first = await session.analyze(root)
  const source = first.files.find(file => file.reference.path === 'src/main.js')!.reference
  await writeFile(join(root, 'src/main.js'), 'console.log("changed after snapshot");\n')
  await assert.rejects(session.openReference(root, source), /changed on disk/)
  const second = await session.analyze(root)
  const fresh = second.files.find(file => file.reference.path === 'src/main.js')!.reference
  const outside = await mkdtemp(join(tmpdir(), 'ion-lens-outside-ref-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'private.js'), 'PRIVATE')
  await rm(join(root, 'src/main.js'))
  try { await symlink(join(outside, 'private.js'), join(root, 'src/main.js')) }
  catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') { t.skip('Windows symlink permission unavailable.'); return }
    throw error
  }
  await assert.rejects(session.openReference(root, fresh), /Symbolic links|regular file|changed/)
  assert.equal(scope.authorizes(join(outside, 'private.js')), false)
})

test('cancel and close abort active analysis and release last-snapshot membership', async t => {
  const { root, scope } = await fixture(t)
  const session = new ProjectLensSession(() => scope)
  const pending = session.analyze(root)
  session.cancel()
  assert.equal((await pending).status, 'cancelled')
  const snapshot = await session.analyze(root)
  const reference = snapshot.files[0].reference
  session.cancel()
  await assert.rejects(session.openReference(root, reference), /Analyze the current folder again/)
  await session.analyze(root)
  session.close()
  await assert.rejects(session.openReference(root, reference), /Analyze the current folder again/)
})

test('newer request cancels older work and explicitly reports busy until cleanup completes', async t => {
  const { root, scope } = await fixture(t)
  const session = new ProjectLensSession(() => scope)
  t.after(() => session.close())
  const first = session.analyze(root)
  await assert.rejects(session.analyze(root), /still stopping/)
  assert.equal((await first).status, 'cancelled')
  const current = await session.analyze(root)
  assert.equal(current.status, 'complete')
  assert.equal((await session.openReference(root, current.files[0].reference)).entry.kind, 'file')
})

test('replacing the WorkspaceFiles authority invalidates pending and retained results', async t => {
  const { root, scope } = await fixture(t)
  const other = await fixture(t)
  let authority = scope
  const session = new ProjectLensSession(() => authority)
  t.after(() => session.close())
  const pending = session.analyze(root)
  authority = other.scope
  assert.equal((await pending).status, 'invalidated')
  authority = scope
  const snapshot = await session.analyze(root)
  authority = other.scope
  await assert.rejects(session.openReference(root, snapshot.files[0].reference), /Analyze the current folder again/)
  assert.equal(scope.authorizes(join(other.root, 'package.json')), false)
})

test('opening evidence rechecks ownership after asynchronous inspection and captures request data before awaiting', async t => {
  let gate: (() => Promise<void>) | undefined
  class GatedFiles extends WorkspaceFiles {
    override async inspect(value: unknown, kind?: 'file' | 'folder') {
      const inspected = await super.inspect(value, kind)
      if (gate) await gate()
      return inspected
    }
  }
  const { root, scope } = await fixture(t, new GatedFiles())
  const session = new ProjectLensSession(() => scope)
  t.after(() => session.close())
  const snapshot = await session.analyze(root)
  const reference = { ...snapshot.files.find(file => file.reference.path === 'src/main.js')!.reference }
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  gate = () => blocked
  const opened = session.openReference(root, reference)
  reference.path = 'not-the-requested-file.js'
  release()
  assert.equal((await opened).entry.name, 'main.js')
  const invalidated = session.openReference(root, snapshot.files[0].reference)
  session.cancel()
  await assert.rejects(invalidated, /workspace changed/)
})

test('a replacement root is rejected even when moving its source subtree preserves file revision', async t => {
  const { root, scope } = await fixture(t)
  const session = new ProjectLensSession(() => scope)
  t.after(() => session.close())
  const snapshot = await session.analyze(root)
  const reference = snapshot.files.find(file => file.reference.path === 'src/main.js')!.reference
  const old = root + '-original'
  t.after(() => rm(old, { recursive: true, force: true }))
  await rename(root, old)
  await mkdir(root)
  await rename(join(old, 'src'), join(root, 'src'))
  await assert.rejects(session.openReference(root, reference), /folder changed|workspace changed/)
})

test('cancelled analysis retains its single operation slot until delayed real filesystem inspection unwinds', async t => {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let hold = true, inspections = 0, active = 0, maximum = 0
  class HeldFiles extends WorkspaceFiles {
    override async inspect(value: unknown, kind?: 'file' | 'folder') {
      if (!hold) return super.inspect(value, kind)
      inspections++; active++; maximum = Math.max(maximum, active)
      try {
        const actual = await super.inspect(value, kind)
        entered()
        await gate
        return actual
      } finally { active-- }
    }
  }
  const { root, scope } = await fixture(t, new HeldFiles())
  const session = new ProjectLensSession(() => scope)
  t.after(() => session.close())
  const first = session.analyze(root)
  await started
  session.cancel()
  const additional = Array.from({ length: 9 }, () => session.analyze(root))
  const all = Promise.allSettled([first, ...additional])
  session.cancel()
  release()
  const results = await all
  assert.equal(maximum, 1, 'Cancelled requests overlapped delayed real filesystem inspections.')
  assert.equal(inspections, 1, 'Rejected new requests must not start additional filesystem work.')
  assert.equal(active, 0)
  assert.equal(results[0].status, 'fulfilled')
  if (results[0].status === 'fulfilled') assert.equal(results[0].value.status, 'cancelled')
  for (const result of results.slice(1)) {
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.match(result.reason.message, /still stopping|busy/)
  }
  hold = false
  assert.equal((await session.analyze(root)).status, 'complete', 'A later explicit request works after cleanup; no automatic retry is needed.')
})
