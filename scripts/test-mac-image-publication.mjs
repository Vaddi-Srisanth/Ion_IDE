import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { publishMacImage } from './mac-image-publication.mjs'

if (process.platform !== 'darwin') {
  console.log('SKIP native Mac image publication: hdiutil is macOS-only.')
  process.exit(0)
}
const execute = promisify(execFile)
const output = resolve(process.argv[2] ?? 'release-blockers/mac/publication-regression')
await mkdir(output, { recursive: false })
const results = []
async function command(name, binary, args) {
  const began = performance.now()
  let result
  try {
    const { stdout, stderr } = await execute(binary, args, { timeout: 60_000, maxBuffer: 128 * 1024 })
    result = { name, binary, args, status: 0, stdout, stderr }
  } catch (error) {
    result = { name, binary, args, status: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr }
  }
  result.elapsedMs = performance.now() - began
  results.push(result)
  await writeFile(join(output, 'commands.json'), JSON.stringify(results, null, 2) + '\n')
  return result
}
const hash = value => createHash('sha256').update(value).digest('hex')
const source = join(output, 'source')
await mkdir(source)
const payload = Buffer.alloc(1024 * 1024)
let state = 123456789
for (let i = 0; i < payload.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; payload[i] = state & 255 }
await writeFile(join(source, 'fixture.bin'), payload)
const authored = join(output, 'authored.dmg')
const destination = join(output, 'published.dmg')
assert.equal((await command('CI7-hdiutil-create', '/usr/bin/hdiutil', ['create', '-format', 'UDZO', '-fs', 'APFS',
  '-volname', 'Ion disposable publication fixture', '-srcfolder', source, authored])).status, 0)
const bytes = await readFile(authored)
const holder = spawn('/usr/bin/python3', ['-I', '-S', '-c',
  "import fcntl,sys\nf=open(sys.argv[1],'r+b')\nfcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('READY',flush=True)\nsys.stdin.read(1)\nf.close()\n", authored],
{ stdio: ['pipe', 'pipe', 'pipe'] })
const exited = once(holder, 'close')
holder.stderr.resume()
let originalFailure
let publicationMs
try {
  assert.equal(await Promise.race([once(holder.stdout, 'data').then(([chunk]) => chunk.toString().trim()),
    exited.then(([code]) => { throw Error('Lock holder exited prematurely: ' + code) })]), 'READY')
  await command('known-lock-owner', '/usr/sbin/lsof', ['-nP', authored])
  originalFailure = await command('old-order-verify-authored', '/usr/bin/hdiutil', ['verify', authored])
  assert.equal(originalFailure.status, 1)
  assert.match(originalFailure.stderr, /Resource temporarily unavailable/)
  const began = performance.now()
  await publishMacImage(authored, destination)
  publicationMs = performance.now() - began
  assert.equal(hash(await readFile(destination)), hash(bytes), 'Publish the exact verified snapshot.')
} finally {
  holder.stdin.end('x')
  assert.equal((await exited)[0], 0)
}
assert.equal((await command('published-valid', '/usr/bin/hdiutil', ['verify', destination])).status, 0)
// Retain the formerly misleading offset-4096 experiment separately. This
// mutation damages a substantial central compressed-data region instead.
const corrupted = Buffer.from(bytes)
const middle = Math.floor(corrupted.length / 2)
for (let offset = middle; offset < middle + 4096; offset++) corrupted[offset] ^= 0xff
const bad = join(output, 'damaged-payload.dmg')
await writeFile(bad, corrupted)
const destinationBefore = hash(await readFile(destination))
let rejected
try { await publishMacImage(bad, destination) } catch (error) { rejected = error }
assert.ok(rejected?.imageStage, 'Retain the actual rejected staged image for diagnosis.')
assert.equal(hash(await readFile(destination)), destinationBefore, 'Failed validation must preserve the previous release.')
assert.equal(hash(await readFile(rejected.imageStage.image)), hash(corrupted), 'Retain exact corrupt staging bytes.')
assert.notEqual((await command('damaged-snapshot-rejects', '/usr/bin/hdiutil', ['verify', '-nocache', rejected.imageStage.image])).status, 0)
const summary = { platform: process.platform, arch: process.arch, sourceImageBytes: bytes.length,
  sourceImageSha256: hash(bytes), oldOrder: { status: originalFailure.status, elapsedMs: originalFailure.elapsedMs },
  publicationMs, verifiedSnapshotMatches: true, authoringLockIndependent: true,
  corruptSnapshotRejected: true, existingReleasePreserved: true, failedStageRetained: rejected.imageStage,
  lockHolderExited: true, remainingStageDirectories: (await readdir(output)).filter(name => name.startsWith('.ion-dmg-')) }
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
