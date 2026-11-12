import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { macInstallTarget, prepareUpdate, verifyUpdateBytes } from '../src/main/update-install'
import { GitHubUpdates, type DownloadedUpdate } from '../src/main/updates'

test('in-place updates target an installed Mac bundle, never Downloads, images or arbitrary paths', () => {
  assert.equal(macInstallTarget('/Applications/Ion IDE.app/Contents/MacOS/Ion IDE'), '/Applications/Ion IDE.app')
  assert.equal(macInstallTarget('/home/student/Applications/Ion IDE.app/Contents/MacOS/Ion IDE', '/home/student'),
    '/home/student/Applications/Ion IDE.app')
  for (const path of ['/Volumes/Ion IDE/Ion IDE.app/Contents/MacOS/Ion IDE', '/tmp/Ion IDE.app/Contents/MacOS/Ion IDE',
    '/Applications/Another.app/Contents/MacOS/Ion IDE', '../Applications/Ion IDE.app/Contents/MacOS/Ion IDE']) {
    assert.throws(() => macInstallTarget(path), /Applications|installed/)
  }
})

test('install-time rehash rejects altered, truncated and symlinked installers without executing anything', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ion-install-hash-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'update.dmg')
  const content = Buffer.alloc(1024 * 1024, 49)
  await writeFile(path, content)
  const update: DownloadedUpdate = { path, name: 'update.dmg', latest: '0.10.0', bytes: content.length,
    url: 'https://github.com/Vaddi-Srisanth/Ion_IDE/releases/download/v0.10.0/update.dmg',
    digest: 'sha256:' + createHash('sha256').update(content).digest('hex') }
  await verifyUpdateBytes(update)
  await writeFile(path, Buffer.alloc(content.length, 50))
  await assert.rejects(verifyUpdateBytes(update), /checksum/)
  await writeFile(path, 'short')
  await assert.rejects(verifyUpdateBytes(update), /changed/)
  if (process.platform !== 'win32') {
    const link = join(root, 'link.dmg')
    await symlink(path, link)
    await assert.rejects(verifyUpdateBytes({ ...update, path: link }))
  }
  await assert.rejects(prepareUpdate({ update, currentVersion: '0.9.6', executable: process.execPath,
    helper: path, profile: root, arch: process.arch, platform: process.platform, packaged: false }), /installed desktop/)
})

test('verified update receipts resume offline, reuse one payload and report post-quit outcomes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ion-update-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const content = Buffer.from('local test installer')
  const name = 'Ion-IDE-0.10.0-mac-arm64.dmg'
  const url = 'https://github.com/Vaddi-Srisanth/Ion_IDE/releases/download/v0.10.0/' + name
  let calls = 0
  const request: typeof fetch = async (input) => {
    calls++
    return String(input).includes('/releases/latest') ? Response.json({ tag_name: 'v0.10.0', draft: false, prerelease: false,
      assets: [{ name, state: 'uploaded', size: content.length, browser_download_url: url,
        digest: 'sha256:' + createHash('sha256').update(content).digest('hex') }] }) : new Response(content)
  }
  const service = new GitHubUpdates('0.9.6', 'darwin', 'arm64', request)
  await service.check()
  const first = await service.download(root, true)
  assert.deepEqual(await service.download(root, true), service.ready())
  assert.equal(calls, 2)
  assert.equal(await readFile(first.path, 'utf8'), content.toString())
  await mkdir(join(root, 'Ion Update abc123'))
  await writeFile(join(root, 'result.json'), JSON.stringify({ schemaVersion: 1, state: 'failed',
    message: 'Setup failed. The previous application was restored.' }))
  const offline = new GitHubUpdates('0.9.6', 'darwin', 'arm64', async () => { throw new Error('offline') })
  await offline.restore(root)
  assert.equal(offline.status().state, 'available')
  assert.equal(offline.ready().path, first.path)
  assert.match(offline.status().notice!, /restored/)
  assert.equal((await readdir(root)).filter(name => name.startsWith('Ion Update ')).length, 1)
  const current = new GitHubUpdates('0.10.0', 'darwin', 'arm64', request)
  await current.restore(root)
  assert.throws(() => current.ready(), /Download/)
  assert.equal((await readdir(root)).filter(name => name.startsWith('Ion Update ')).length, 0)
})

test('corrupt or path-escaping receipts do not grant an install capability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ion-update-receipt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const value of ['not-json', JSON.stringify({ folder: '../../Applications', release: {} }), 'x'.repeat(4097)]) {
    await writeFile(join(root, 'ready.json'), value)
    const service = new GitHubUpdates('0.9.6', 'darwin', 'arm64')
    await service.restore(root)
    assert.equal(service.status().state, 'unchecked')
    assert.throws(() => service.ready())
  }
})
