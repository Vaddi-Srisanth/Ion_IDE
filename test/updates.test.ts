import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { GitHubUpdates } from '../src/main/updates'

const installer = Buffer.from('fixture installer')
const mac = 'Ion-IDE-0.10.0-mac-arm64.dmg'
const windows = 'Ion-IDE-0.10.0-windows-x64-setup.exe'
const asset = (name: string) => ({
  name, state: 'uploaded', size: installer.length,
  browser_download_url: `https://github.com/Vaddi-Srisanth/Ion_IDE/releases/download/v0.10.0/${name}`,
  digest: 'sha256:' + createHash('sha256').update(installer).digest('hex'),
})
const release = (assets = [asset(mac), asset(windows)]) => ({ tag_name: 'v0.10.0', draft: false, prerelease: false, assets })

test('update selection compares numeric versions and requires the exact checked platform asset', async () => {
  const fetcher: typeof fetch = async () => Response.json(release())
  const oldMac = new GitHubUpdates('0.9.4', 'darwin', 'arm64', fetcher)
  assert.deepEqual(await oldMac.check(), { current: '0.9.4', latest: '0.10.0', state: 'available', name: mac, bytes: installer.length })
  const oldWin = new GitHubUpdates('0.9.4', 'win32', 'x64', fetcher)
  assert.deepEqual(await oldWin.check(), { current: '0.9.4', latest: '0.10.0', state: 'available', name: windows, bytes: installer.length })
  assert.equal((await new GitHubUpdates('0.11.0', 'darwin', 'arm64', fetcher).check()).state, 'current')
  assert.equal((await new GitHubUpdates('0.9.4', 'darwin', 'x64', fetcher).check()).state, 'asset-missing')
  const tampered = new GitHubUpdates('0.9.4', 'darwin', 'arm64', async () =>
    Response.json(release([{ ...asset(mac), browser_download_url: 'https://unrelated.invalid/installer.dmg' }])))
  assert.equal((await tampered.check()).state, 'asset-missing')
})

test('downloads publish only a complete SHA-256-verified GitHub installer', async (t) => {
  const destination = await mkdtemp(join(tmpdir(), 'ion-update-test-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  let content = Buffer.from('fixture incorrect')
  let redirect = 'https://release-assets.githubusercontent.com/fixture'
  const visited: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input))
    visited.push(url.hostname)
    if (url.hostname === 'api.github.com') return Response.json(release())
    if (url.hostname === 'github.com') return Response.redirect(redirect)
    return new Response(content)
  }
  const updater = new GitHubUpdates('0.9.4', 'darwin', 'arm64', fetcher)
  await updater.check()
  await assert.rejects(updater.download(destination), /checksum/)
  assert.deepEqual(await readdir(destination), [])
  redirect = 'https://unrelated.invalid/fake'
  await assert.rejects(updater.download(destination), /unexpected installer download location/)
  assert.ok(!visited.includes('unrelated.invalid'))
  assert.deepEqual(await readdir(destination), [])
  redirect = 'https://release-assets.githubusercontent.com/fixture'
  content = installer
  const downloaded = await updater.download(destination)
  assert.equal(downloaded.name, mac)
  assert.equal(basename(downloaded.path), mac)
  assert.deepEqual(await readFile(downloaded.path), installer)
  if (process.platform === 'darwin') {
    const marker = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', downloaded.path], { encoding: 'utf8' })
    assert.match(marker, /^0081;[a-f0-9]+;Ion IDE;/)
  } else if (process.platform === 'win32') {
    assert.match(await readFile(`${downloaded.path}:Zone.Identifier`, 'utf8'), /ZoneId=3/)
  }
})

test('cancelling a download clears its staging directory', async (t) => {
  const destination = await mkdtemp(join(tmpdir(), 'ion-update-cancel-test-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).hostname === 'api.github.com') return Response.json(release())
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      start()
    })
  }
  const updater = new GitHubUpdates('0.9.4', 'darwin', 'arm64', fetcher)
  await updater.check()
  const downloading = updater.download(destination)
  await started
  updater.cancel()
  await assert.rejects(downloading, /download canceled/)
  assert.deepEqual(await readdir(destination), [])
})
