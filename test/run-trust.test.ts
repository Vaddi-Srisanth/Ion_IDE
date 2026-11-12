import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { RunTrustStore } from '../src/main/run-trust'

async function setup(t: TestContext) {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-run-trust-'))
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 5 }))
  const root = join(scratch, 'workspace café 学习')
  const path = join(scratch, 'profile', 'run-trust.json')
  await mkdir(root)
  return { scratch, root, path, store: new RunTrustStore(path) }
}

test('Run permission is lazy, survives edits and relaunch, and uses private bounded local data', async (t) => {
  const { scratch, root, path, store } = await setup(t)
  assert.deepEqual(await readdir(scratch), ['workspace café 学习'])
  const approved = await store.snapshot(root)
  assert.equal(typeof approved.dev, 'string')
  assert.equal(typeof approved.ino, 'string')
  assert.equal(await store.trusted(approved), false)
  assert.deepEqual(await readdir(scratch), ['workspace café 学习'])
  await store.remember(approved)
  await writeFile(join(root, 'program.c'), 'int main(void) { return 0; }\n')
  assert.equal(await store.trusted(approved), true)
  await writeFile(join(root, 'program.c'), 'int main(void) { return 1; }\n')
  assert.equal(await new RunTrustStore(path).trusted(approved), true)
  assert.deepEqual(await readdir(join(scratch, 'profile')), ['run-trust.json'])
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(stored, { version: 1, roots: [approved] })
  if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600)
})

test('Replacing a root revokes its physical identity and stale approvals cannot be committed', async (t) => {
  const { scratch, root, path, store } = await setup(t)
  const approved = await store.snapshot(root)
  await store.remember(approved)
  const original = await readFile(path, 'utf8')
  // Keep the old directory alive so inode reuse cannot make this nondeterministic.
  await rename(root, join(scratch, 'previous-workspace'))
  await mkdir(root)
  const replacement = await store.snapshot(root)
  assert.notEqual(approved.ino, replacement.ino)
  assert.equal(await store.trusted(approved), false)
  assert.equal(await store.trusted(replacement), false)
  await assert.rejects(store.remember(approved), /workspace folder changed/)
  assert.equal(await readFile(path, 'utf8'), original)
  await store.remember(replacement)
  assert.equal(await store.trusted(replacement), true)
  assert.equal(await store.trusted(approved), false)
})

test('Permissions never inherit into nested or neighboring roots', async (t) => {
  const { scratch, root, store } = await setup(t)
  const nested = join(root, 'nested')
  const neighbor = join(scratch, 'workspace café 学习-neighbor')
  await mkdir(nested)
  await mkdir(neighbor)
  const approved = await store.snapshot(root)
  await store.remember(approved)
  assert.equal(await store.trusted(await store.snapshot(nested)), false)
  assert.equal(await store.trusted(await store.snapshot(neighbor)), false)
  await store.remember(await store.snapshot(nested))
  assert.equal(await store.trusted(await store.snapshot(nested)), true)
  await store.clear()
  assert.equal(await store.trusted(approved), false)
  assert.equal(await store.trusted(await store.snapshot(nested)), false)
})

test('Directory aliases canonicalize and retargeted aliases cannot reuse trust', async (t) => {
  const { scratch, root, store } = await setup(t)
  const alias = join(scratch, 'workspace alias')
  const second = join(scratch, 'another workspace')
  await mkdir(second)
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const approved = await store.snapshot(alias)
  assert.deepEqual(approved, await store.snapshot(root))
  await store.remember(approved)
  assert.equal(await store.trusted(await store.snapshot(alias)), true)
  await rm(alias)
  await symlink(second, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await store.trusted(await store.snapshot(alias)), false)
  assert.equal(await store.trusted(await store.snapshot(root)), true)
})

test('Files, missing roots and forged identities fail closed', async (t) => {
  const { root, store } = await setup(t)
  const file = join(root, 'file.txt')
  await writeFile(file, 'text')
  await assert.rejects(store.snapshot(file), /real workspace folder/)
  await assert.rejects(store.snapshot(join(root, 'missing')))
  await assert.rejects(store.snapshot('relative/path'), /existing local workspace/)
  const approved = await store.snapshot(root)
  await store.remember(approved)
  assert.equal(await store.trusted({ ...approved, ino: (BigInt(approved.ino) + 1n).toString() }), false)
  await assert.rejects(store.remember({ ...approved, dev: '90071992547409931234' }), /workspace folder changed/)
  assert.equal(await store.trusted(approved), true)
})

test('Malformed, future and oversized stores cannot grant trust or be silently overwritten', async (t) => {
  const { scratch, root, path } = await setup(t)
  await mkdir(join(scratch, 'profile'))
  const probe = new RunTrustStore(path)
  const approved = await probe.snapshot(root)
  const fixtures = [
    '{broken',
    JSON.stringify({ version: 2, roots: [approved] }),
    JSON.stringify({ version: 1, roots: [{ ...approved, ino: Number(approved.ino) }] }),
    JSON.stringify({ version: 1, roots: [approved, approved] }),
    JSON.stringify({ version: 1, roots: Array.from({ length: 65 }, () => approved) }),
    JSON.stringify({ version: 1, roots: [approved], unexpected: 'property' }),
    ' '.repeat(64 * 1024 + 1),
    Buffer.from([0xff, 0xfe, 0x00]),
  ]
  for (const fixture of fixtures) {
    await writeFile(path, fixture)
    const store = new RunTrustStore(path)
    assert.equal(await store.trusted(approved), false)
    await assert.rejects(store.remember(approved), /could not be read safely/)
    assert.deepEqual(await readFile(path), Buffer.isBuffer(fixture) ? fixture : Buffer.from(fixture))
    assert.deepEqual(await readdir(join(scratch, 'profile')), ['run-trust.json'])
  }
  await probe.clear()
  assert.equal(await probe.trusted(approved), false)
  await probe.remember(approved)
  assert.equal(await probe.trusted(approved), true)
})

test('External corruption after a successful read is not replaced by a cached state', async (t) => {
  const { root, path, store } = await setup(t)
  const approved = await store.snapshot(root)
  await store.remember(approved)
  assert.equal(await store.trusted(approved), true)
  await writeFile(path, 'a future or corrupted file')
  assert.equal(await store.trusted(approved), false)
  await assert.rejects(store.remember(approved), /could not be read safely/)
  assert.equal(await readFile(path, 'utf8'), 'a future or corrupted file')
})

test('A permissions-file symbolic link is never read or overwritten through its target', async (t) => {
  const { scratch, root, path, store } = await setup(t)
  await mkdir(join(scratch, 'profile'))
  const protectedFile = join(scratch, 'protected.json')
  const approved = await store.snapshot(root)
  const original = JSON.stringify({ version: 1, roots: [approved] })
  await writeFile(protectedFile, original)
  // File symlinks require Windows Developer Mode; the directory-junction case
  // above remains mandatory on Windows without that optional permission.
  try { await symlink(protectedFile, path, 'file') } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
      t.skip('Windows file symbolic links need Developer Mode or explicit privilege.')
      return
    }
    throw error
  }
  assert.equal(await store.trusted(approved), false)
  await assert.rejects(store.remember(approved), /could not be read safely/)
  assert.equal(await readFile(protectedFile, 'utf8'), original)
  await store.clear()
  assert.equal((await lstat(path)).isSymbolicLink(), false)
  assert.equal(await readFile(protectedFile, 'utf8'), original)
})

test('Eviction and concurrent approvals remain bounded and deterministic', async (t) => {
  const { scratch, path, store } = await setup(t)
  const roots = await Promise.all(Array.from({ length: 66 }, async (_, index) => {
    const root = join(scratch, 'root-' + index)
    await mkdir(root)
    return store.snapshot(root)
  }))
  await Promise.all(roots.slice(0, 65).map((root) => store.remember(root)))
  await store.drain()
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(stored.roots.length, 64)
  assert.deepEqual(stored.roots, roots.slice(1, 65))
  assert.equal(await store.trusted(roots[0]), false)
  assert.equal(await store.trusted(roots[64]), true)
  await store.remember(roots[1])
  await store.remember(roots[65])
  assert.equal(await store.trusted(roots[1]), true)
  assert.equal(await store.trusted(roots[2]), false)
  assert.ok((await lstat(path)).size <= 64 * 1024)
  assert.deepEqual(await readdir(join(scratch, 'profile')), ['run-trust.json'])
})

test('A failed atomic replacement is bounded, leaves no temporary files and permits explicit recovery', async (t) => {
  const { scratch, root, path, store } = await setup(t)
  await mkdir(path, { recursive: true })
  const marker = join(path, 'preserve.txt')
  await writeFile(marker, 'leave this intact')
  const approved = await store.snapshot(root)
  assert.equal(await store.trusted(approved), false)
  await assert.rejects(store.remember(approved), /could not be read safely/)
  const start = performance.now()
  await assert.rejects(store.clear())
  assert.ok(performance.now() - start < 3000, 'A persistent write failure must not retry indefinitely.')
  await store.drain()
  assert.equal(await readFile(marker, 'utf8'), 'leave this intact')
  assert.deepEqual(await readdir(join(scratch, 'profile')), ['run-trust.json'])
  await rm(path, { recursive: true })
  await store.clear()
  await store.remember(approved)
  assert.equal(await store.trusted(approved), true)
})

test('Unreadable permissions stay intact until an explicit reset', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('POSIX file-mode denial is not enforceable on Windows or as root.')
    return
  }
  const { root, path, store } = await setup(t)
  const approved = await store.snapshot(root)
  await store.remember(approved)
  const original = await readFile(path, 'utf8')
  await chmod(path, 0o000)
  try {
    assert.equal(await store.trusted(approved), false)
    await assert.rejects(store.remember(approved), /could not be read safely/)
  } finally { await chmod(path, 0o600) }
  assert.equal(await readFile(path, 'utf8'), original)
})
