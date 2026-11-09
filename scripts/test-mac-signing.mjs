import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { electronSigningOptions, macSigningSettings, resolveDeveloperId } from './mac-signing.mjs'

const name = 'Developer ID Application: Test Fixture (TESTTEAM01)'
const fingerprint = 'A'.repeat(40)
const secondFingerprint = 'B'.repeat(40)
const listing = (hash, certificate) => '  1) ' + hash + ' "' + certificate + '"'

test('preview has no signing requirements, and strict distribution fails on missing credentials', () => {
  assert.equal(macSigningSettings({}), null)
  assert.throws(() => macSigningSettings({ ION_MAC_REQUIRE_NOTARIZATION: 'true' }), /must be 0 or 1/)
  assert.throws(() => macSigningSettings({ ION_MAC_NOTARY_PROFILE: 'test-profile' }), /Set ION_MAC_SIGN_IDENTITY/)
  assert.throws(() => macSigningSettings({ ION_MAC_SIGN_IDENTITY: name, ION_MAC_REQUIRE_NOTARIZATION: '1' }),
    /ION_MAC_NOTARY_PROFILE/)
  assert.throws(() => macSigningSettings({ ION_MAC_SIGN_IDENTITY: 'Apple Development' }), /Developer ID Application/)
  assert.equal(macSigningSettings({
    ION_MAC_SIGN_IDENTITY: name,
    ION_MAC_NOTARY_PROFILE: 'test-profile',
    ION_MAC_REQUIRE_NOTARIZATION: '1',
  }).notaryProfile, 'test-profile')
})

test('matches one exact Developer ID Application certificate, with fingerprint disambiguation', () => {
  const installed = [listing(fingerprint, name), listing(secondFingerprint, name)].join('\n')
  assert.throws(() => resolveDeveloperId(name, installed), /ambiguous/)
  assert.throws(() => resolveDeveloperId(fingerprint, listing(fingerprint, 'Developer ID Installer: Test Fixture (TESTTEAM01)')),
    /Expected one matching/)
  assert.throws(() => resolveDeveloperId(name, listing(fingerprint, name.replace('Test Fixture', 'Test Fixture II'))),
    /Expected one matching/)
  assert.deepEqual(resolveDeveloperId(fingerprint.toLowerCase(), installed), {
    identity: fingerprint, teamId: 'TESTTEAM01',
  })
})

test('packager requests hardened runtime and only gives Electron app executables JIT access', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-test-entitlements-'))
  try {
    const opts = await electronSigningOptions({ identity: fingerprint }, scratch)
    assert.equal(opts.continueOnError, false)
    assert.equal(opts.preAutoEntitlements, false)
    for (const item of ['Ion IDE.app', 'Ion IDE.app/Contents/Frameworks/Ion IDE Helper (Renderer).app']) {
      const options = opts.optionsForFile(item)
      assert.equal(options.hardenedRuntime, true)
      const entitlements = await readFile(options.entitlements, 'utf8')
      assert.match(entitlements, /<dict><key>com\.apple\.security\.cs\.allow-jit<\/key><true\/><\/dict>/)
    }
    const native = opts.optionsForFile('Ion IDE.app/Contents/Resources/ion-pty')
    assert.equal(native.hardenedRuntime, true)
    assert.match(await readFile(native.entitlements, 'utf8'), /<dict><\/dict>/)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
