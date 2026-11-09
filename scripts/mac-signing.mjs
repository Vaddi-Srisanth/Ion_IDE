import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const codesign = '/usr/bin/codesign'
const xcrun = '/usr/bin/xcrun'
const spctl = '/usr/sbin/spctl'
const hdiutil = '/usr/bin/hdiutil'
const nativeTools = ['ion-pty', 'ion-rg']
const digest = /^[a-f0-9]{40}$/i
const developerId = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
const read = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const keychainArguments = (keychain) => keychain ? ['--keychain', keychain] : []

export function macSigningSettings(env) {
  const identity = env.ION_MAC_SIGN_IDENTITY?.trim()
  const keychain = env.ION_MAC_SIGN_KEYCHAIN?.trim()
  const notaryProfile = env.ION_MAC_NOTARY_PROFILE?.trim()
  const required = env.ION_MAC_REQUIRE_NOTARIZATION?.trim()
  if (required && required !== '0' && required !== '1') {
    throw new Error('ION_MAC_REQUIRE_NOTARIZATION must be 0 or 1.')
  }
  if (required === '1' && (!identity || !notaryProfile)) {
    throw new Error('Set both ION_MAC_SIGN_IDENTITY and ION_MAC_NOTARY_PROFILE to require a notarized Mac disk image.')
  }
  if (!identity && (keychain || notaryProfile)) {
    throw new Error('Set ION_MAC_SIGN_IDENTITY when specifying a signing keychain or notary profile.')
  }
  if (!identity) return null
  if (!digest.test(identity) && !developerId.test(identity)) {
    throw new Error('Use an exact Developer ID Application certificate name or its SHA-1 fingerprint.')
  }
  return { identity, keychain, notaryProfile }
}

export function resolveDeveloperId(identity, listing) {
  const matches = new Map()
  for (const line of listing.split(/\r?\n/)) {
    const entry = /^\s*\d+\)\s+([a-f0-9]{40})\s+"([^"]+)"\s*$/i.exec(line)
    if (!entry) continue
    const [, hash, name] = entry
    const teamId = developerId.exec(name)?.[1]
    if (teamId && (name === identity || hash.toUpperCase() === identity.toUpperCase())) {
      matches.set(hash.toUpperCase(), { identity: hash.toUpperCase(), teamId })
    }
  }
  if (matches.size !== 1) {
    throw new Error('Expected one matching Developer ID Application identity with a private key. Use its exact SHA-1 fingerprint if the name is ambiguous.')
  }
  return matches.values().next().value
}

export function loadMacSigning(env = process.env) {
  const settings = macSigningSettings(env)
  if (!settings) return null
  const { identity, keychain } = settings
  const listing = read('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', ...(keychain ? [keychain] : [])])
  return { ...settings, ...resolveDeveloperId(identity, listing) }
}

export async function electronSigningOptions(signing, scratch) {
  const empty = join(scratch, 'no-entitlements.plist')
  const jit = join(scratch, 'jit-entitlements.plist')
  const plist = (body) => '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>' + body + '</dict></plist>\n'
  await Promise.all([
    writeFile(empty, plist('')),
    writeFile(jit, plist('<key>com.apple.security.cs.allow-jit</key><true/>')),
  ])
  return {
    identity: signing.identity,
    keychain: signing.keychain,
    continueOnError: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: (path) => ({
      hardenedRuntime: true,
      entitlements: /\.app(?:\/Contents\/MacOS\/[^/]+)?$/.test(path) ? jit : empty,
    }),
  }
}

function verifyDeveloperId(path, teamId, runtime) {
  const requirement = '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' +
    ' and certificate leaf[subject.OU] = "' + teamId + '"'
  run(codesign, ['--verify', '--strict', '-R', requirement, path])
  const metadata = spawnSync(codesign, ['--display', '--verbose=4', path], { encoding: 'utf8' })
  if (metadata.status !== 0 || !/^Timestamp=.+$/m.test(metadata.stderr) ||
      (runtime && !/\bflags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/i.test(metadata.stderr))) {
    throw new Error('Expected a Developer ID secure timestamp and the required runtime flags for ' + path)
  }
}

function parseNotaryResponse(output) {
  try {
    const response = JSON.parse(output)
    if (response && typeof response === 'object' && !Array.isArray(response)) return response
  } catch {
    // Apple tools may exit without producing a JSON response.
  }
  throw new Error('Apple returned no readable notarization status. Check the stored profile and service connectivity.')
}

export async function verifyMacApp(app, signing) {
  run(codesign, ['--verify', '--deep', '--strict', app])
  if (!signing) return
  const frameworks = join(app, 'Contents', 'Frameworks')
  const helpers = (await readdir(frameworks)).filter((name) => name.endsWith('.app'))
  for (const path of [app, ...helpers.map((name) => join(frameworks, name)),
    ...nativeTools.map((name) => join(app, 'Contents', 'Resources', name))]) {
    verifyDeveloperId(path, signing.teamId, true)
  }
}

export async function signMacImage(image, signing, scratch) {
  run(codesign, ['--sign', signing.identity, ...keychainArguments(signing.keychain), '--timestamp', image])
  verifyDeveloperId(image, signing.teamId, false)
  if (!signing.notaryProfile) return
  if (read(spctl, ['--status']).trim() !== 'assessments enabled') {
    throw new Error('Gatekeeper assessment must be enabled.')
  }

  const credentials = ['--keychain-profile', signing.notaryProfile, ...keychainArguments(signing.keychain)]
  const result = spawnSync(xcrun, ['notarytool', 'submit', image, ...credentials,
    '--wait', '--timeout', '20m', '--output-format', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25 * 60 * 1000,
  })
  const submission = parseNotaryResponse(result.stdout)
  const id = typeof submission.id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(submission.id)
    ? submission.id : null
  if (result.status !== 0 || submission.status !== 'Accepted' || !id) {
    throw new Error('Apple did not accept the disk image. ' + (id
      ? 'Inspect submission ' + id + ' with xcrun notarytool log.'
      : 'Check the stored notarytool profile and Apple service connectivity.'))
  }
  const log = parseNotaryResponse(read(xcrun, ['notarytool', 'log', id, ...credentials]))
  const warnings = log.issues?.filter(({ severity }) => severity === 'warning').length ?? 0
  console.log('Apple accepted submission ' + id + ' with ' + warnings + ' warning(s).')
  run(xcrun, ['stapler', 'staple', image])
  run(xcrun, ['stapler', 'validate', image])
  verifyDeveloperId(image, signing.teamId, false)
  run(spctl, ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', image])

  const mount = join(scratch, 'assess-disk-image')
  await mkdir(mount)
  run(hdiutil, ['attach', '-quiet', '-nobrowse', '-readonly', '-mountpoint', mount, image])
  try {
    const app = join(mount, 'Ion IDE.app')
    await verifyMacApp(app, signing)
    run(spctl, ['--assess', '--type', 'execute', '--verbose=2', app])
  } finally {
    run(hdiutil, ['detach', '-quiet', mount])
  }
}
