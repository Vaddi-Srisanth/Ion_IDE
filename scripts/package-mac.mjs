import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'
import { packager } from '@electron/packager'
import { macDocumentInfo } from './macos-document-types.mjs'

if (process.platform !== 'darwin') throw new Error('Package Ion IDE on a Mac')
const arch = process.env.ION_MAC_ARCH ?? process.arch
if (!['arm64', 'x64'].includes(arch)) throw new Error('ION_MAC_ARCH must be arm64 or x64')

const metadata = JSON.parse(await readFile('package.json', 'utf8'))
const { name, productName, version, main } = metadata
const manifest = { name, productName, version, main }
const release = resolve(process.env.ION_MAC_OUTPUT_DIR ?? 'release')
const app = join(release, `Ion IDE-${version}-darwin-${arch}`, 'Ion IDE.app')
const scratch = await mkdtemp(join(tmpdir(), 'ion-package-'))
const command = (binary, args) => execFileSync(binary, args, { stdio: 'inherit' })

try {
  await mkdir(release, { recursive: true })
  if (process.argv[2] === 'dmg') {
    const volume = join(scratch, 'volume')
    await mkdir(volume)
    const copy = join(volume, 'Ion IDE.app')
    command('/usr/bin/ditto', ['--norsrc', '--noextattr', app, copy])
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', copy])
    await symlink('/Applications', join(volume, 'Applications'))
    const filename = `Ion-IDE-${manifest.version}-mac-${arch}.dmg`
    const image = join(scratch, filename)
    const diskutil = '/usr/sbin/diskutil'
    const help = spawnSync(diskutil, ['image', 'create', 'from', '--help'], { encoding: 'utf8' })
    if (help.status === 0 && /--volumeName\b/.test(`${help.stdout}\n${help.stderr}`)) {
      command(diskutil, ['image', 'create', 'from', '--format', 'UDZO', '--volumeName', 'Ion IDE', volume, image])
    } else {
      command('/usr/bin/hdiutil', ['create', '-format', 'UDZO', '-fs', 'APFS',
        '-volname', 'Ion IDE', '-srcfolder', volume, image])
    }
    command('/usr/bin/hdiutil', ['verify', image])
    await cp(image, join(release, filename))
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
      extraResource: ['ion-pty', 'ion-rg', 'ion-rg-LICENSE.txt', 'ion-rg-NOTICES.txt'].map((name) => join(native, name)),
      asar: true,
      prune: false,
    })
    // File Provider can attach Finder metadata to bundles in synced folders.
    const signedApp = join(packageDirectory, 'Ion IDE.app')
    for (const name of ['ion-pty', 'ion-rg']) {
      const executable = join(signedApp, 'Contents/Resources', name)
      const architectures = execFileSync('/usr/bin/lipo', [executable, '-archs'], { encoding: 'utf8' }).trim().split(/\s+/)
      if (!architectures.includes(arch === 'x64' ? 'x86_64' : 'arm64')) {
        throw new Error(`${name} is missing the requested ${arch} architecture.`)
      }
      command('/usr/bin/codesign', ['--force', '--sign', '-', executable])
    }
    await flipFuses(signedApp, {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    })
    command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', signedApp])
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', signedApp])
    await rm(app, { recursive: true, force: true })
    command('/usr/bin/ditto', ['--norsrc', '--noextattr', signedApp, app])
    console.log(app)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
