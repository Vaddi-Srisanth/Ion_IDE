import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'
import { packager } from '@electron/packager'
import { macDocumentInfo } from './macos-document-types.mjs'
import { electronSigningOptions, loadMacSigning, signMacImage, verifyMacApp } from './mac-signing.mjs'
import { publishMacImage } from './mac-image-publication.mjs'

if (process.platform !== 'darwin') throw new Error('Package Ion IDE on a Mac')
const arch = process.env.ION_MAC_ARCH ?? process.arch
if (!['arm64', 'x64'].includes(arch)) throw new Error('ION_MAC_ARCH must be arm64 or x64')

const metadata = JSON.parse(await readFile('package.json', 'utf8'))
const { name, productName, version, main } = metadata
const manifest = { name, productName, version, main }
const release = resolve(process.env.ION_MAC_OUTPUT_DIR ?? 'release')
const app = join(release, `Ion IDE-${version}-darwin-${arch}`, 'Ion IDE.app')
const signing = loadMacSigning()
const scratch = await mkdtemp(join(tmpdir(), 'ion-package-'))
const command = (binary, args) => execFileSync(binary, args, { stdio: 'inherit' })
let image
let phase = 'staging'
let failed = false

try {
  await mkdir(release, { recursive: true })
  if (process.argv[2] === 'dmg') {
    const volume = join(scratch, 'volume')
    await mkdir(volume)
    const copy = join(volume, 'Ion IDE.app')
    command('/usr/bin/ditto', ['--norsrc', '--noextattr', app, copy])
    await verifyMacApp(copy, signing)
    await symlink('/Applications', join(volume, 'Applications'))
    const filename = `Ion-IDE-${manifest.version}-mac-${arch}.dmg`
    image = join(scratch, filename)
    const diskutil = '/usr/sbin/diskutil'
    const help = spawnSync(diskutil, ['image', 'create', 'from', '--help'], { encoding: 'utf8' })
    phase = 'image-creation'
    if (help.status === 0 && /--volumeName\b/.test(`${help.stdout}\n${help.stderr}`)) {
      command(diskutil, ['image', 'create', 'from', '--format', 'UDZO', '--volumeName', 'Ion IDE', volume, image])
    } else {
      command('/usr/bin/hdiutil', ['create', '-format', 'UDZO', '-fs', 'APFS',
        '-volname', 'Ion IDE', '-srcfolder', volume, image])
    }
    phase = 'image-signing'
    if (signing) await signMacImage(image, signing, scratch)
    phase = 'image-verification'
    await publishMacImage(image, join(release, filename), { verbose: process.env.ION_MAC_DIAGNOSTICS === '1' })
    console.log(join(release, filename))
  } else {
    // Use the pinned Electron package's checksums to verify cached runtimes offline.
    const require = createRequire(import.meta.url)
    const checksums = require('electron/checksums.json')
    const stage = join(scratch, 'app')
    const iconset = join(scratch, 'Ion.iconset')
    const icon = join(scratch, 'Ion.icns')
    await mkdir(stage)
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest))
    const native = resolve('dist/native')
    const nativeTools = ['ion-pty', 'ion-rg', 'ion-file-ops', 'ion-update']
    await cp('dist', join(stage, 'dist'), { recursive: true, filter: (path) => resolve(path) !== native })
    command('/usr/bin/swift', ['scripts/macos-icon.swift', iconset])
    command('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon])
    const [packageDirectory] = await packager({
      dir: stage,
      out: join(scratch, 'out'),
      tmpdir: scratch,
      name: 'Ion IDE',
      appBundleId: 'dev.ionide.desktop',
      appCategoryType: 'public.app-category.developer-tools',
      extendInfo: macDocumentInfo,
      electronVersion: metadata.devDependencies.electron,
      download: { checksums },
      platform: 'darwin',
      arch,
      icon,
      extraResource: [...nativeTools, 'ion-rg-LICENSE.txt', 'ion-rg-NOTICES.txt'].map((name) => join(native, name)),
      afterCopyExtraResources: [async ({ buildPath }) => {
        const bundle = join(buildPath, 'Ion IDE.app')
        for (const name of nativeTools) {
          const executable = join(bundle, 'Contents/Resources', name)
          const architectures = execFileSync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/)
          if (!architectures.includes(arch === 'x64' ? 'x86_64' : 'arm64')) {
            throw new Error(name + ' is missing the requested ' + arch + ' architecture.')
          }
          if (!signing) command('/usr/bin/codesign', ['--force', '--sign', '-', executable])
        }
        // The bundle has been named and its resources copied. Packager signs it after this hook.
        await flipFuses(bundle, {
          version: FuseVersion.V1,
          [FuseV1Options.RunAsNode]: false,
          [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
          [FuseV1Options.EnableNodeCliInspectArguments]: false,
          [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
          [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
          [FuseV1Options.OnlyLoadAppFromAsar]: true,
        })
      }],
      ...(signing && { osxSign: await electronSigningOptions(signing, scratch) }),
      asar: true,
      prune: false,
    })
    // File Provider can attach Finder metadata to bundles in synced folders.
    const signedApp = join(packageDirectory, 'Ion IDE.app')
    if (!signing) command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', signedApp])
    await verifyMacApp(signedApp, signing)
    await rm(app, { recursive: true, force: true })
    command('/usr/bin/ditto', ['--norsrc', '--noextattr', signedApp, app])
    await verifyMacApp(app, signing)
    console.log(app)
  }
} catch (error) {
  failed = true
  // Keep the failed bytes and lock evidence. Successful packaging still removes
  // every temporary resource; failures must never silently become a retry.
  const locks = image && spawnSync('/usr/sbin/lsof', ['-nP', image, ...(error.imageStage ? [error.imageStage.image] : [])], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
  })
  await writeFile(join(scratch, 'failure.json'), JSON.stringify({
    phase, platform: process.platform, arch, version, image, stage: error.imageStage,
    message: error instanceof Error ? error.message : String(error),
    status: error.status ?? null, signal: error.signal ?? null,
    locks: locks ? { status: locks.status, stdout: locks.stdout, stderr: locks.stderr,
      error: locks.error?.message } : null,
  }, null, 2) + '\n').catch(() => {})
  console.error('Packaging failed; private diagnostic work directory retained:', scratch)
  throw error
} finally {
  if (!failed) await rm(scratch, { recursive: true, force: true })
}
