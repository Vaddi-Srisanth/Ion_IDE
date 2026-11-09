import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyReleaseEvidence } from './release-evidence.mjs'

test('release evidence binds both validated installer bytes to the same workflow attempt and tag commit', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-release-evidence-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const commit = 'a'.repeat(40)
  const bytes = Buffer.from('local test fixture')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const mac = 'Ion-IDE-0.9.4-mac-arm64.dmg'
  const win = 'Ion-IDE-0.9.4-windows-x64-setup.exe'
  const record = { schema: 1, version: '0.9.4', commit, run: '123', attempt: '1', sha256, bytes: bytes.length }
  const paths = [join(scratch, mac + '.json'), join(scratch, win + '.json')]
  await writeFile(join(scratch, mac), bytes)
  await writeFile(join(scratch, win), bytes)
  await writeFile(paths[0], JSON.stringify({ ...record, platform: 'mac-arm64', file: mac }))
  const writeWindows = (changes = {}) => writeFile(paths[1], JSON.stringify({
    ...record, platform: 'windows-x64', file: win, ...changes,
  }))
  await writeWindows()
  assert.equal(await verifyReleaseEvidence('v0.9.4', commit, paths), `${sha256}  ${mac}\n${sha256}  ${win}\n`)
  await assert.rejects(verifyReleaseEvidence('v0.9.4', 'b'.repeat(40), paths), /Invalid release evidence/)
  await writeWindows({ attempt: '2' })
  await assert.rejects(verifyReleaseEvidence('v0.9.4', commit, paths), /same verification run and attempt/)
  await writeWindows({ file: '../' + win })
  await assert.rejects(verifyReleaseEvidence('v0.9.4', commit, paths), /Invalid release evidence/)
  await writeWindows()
  await writeFile(join(scratch, win), Buffer.from('modified test data'))
  await assert.rejects(verifyReleaseEvidence('v0.9.4', commit, paths), /does not match/)
})
