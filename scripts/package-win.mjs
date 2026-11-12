import { execFile } from 'node:child_process'
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'
import { packager } from '@electron/packager'
import { signWindowsBinary, windowsSigningOptions } from './windows/signing.mjs'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const { name, productName, version, main, devDependencies } = JSON.parse(await readFile('package.json', 'utf8'))
const signing = windowsSigningOptions()
const author = signing?.publisher ?? 'Vaddi Srisanth'
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Windows packaging requires a numeric release version.')

const makensis = process.env.ION_MAKENSIS ?? 'makensis'
const option = process.platform === 'win32' ? '/' : '-'
try {
  await run(makensis, [option + 'VERSION'])
} catch {
  throw new Error('Install NSIS 3 and add makensis to PATH, or set ION_MAKENSIS to its full path.')
}

const release = resolve(process.env.ION_WIN_OUTPUT_DIR ?? 'release')
const scratch = await mkdtemp(join(tmpdir(), 'ion-package-win-'))
const icon = resolve('scripts/windows/ion.ico')
const output = join(scratch, 'dist')
const searchPackage = '@vscode/ripgrep-win32-x64'

async function ripgrepDirectory() {
  if (process.env.ION_RIPGREP_PACKAGE_DIR) return resolve(process.env.ION_RIPGREP_PACKAGE_DIR)
  const installed = resolve('node_modules', searchPackage)
  if (await access(join(installed, 'bin', 'rg.exe')).then(() => true, () => false)) return installed

  // npm omits the Windows optional dependency when this script is run from macOS.
  const args = ['pack', `${searchPackage}@${devDependencies['@vscode/ripgrep']}`, '--json', '--ignore-scripts', '--pack-destination', scratch]
  const npm = process.env.npm_execpath
  const { stdout } = npm ? await run(process.execPath, [npm, ...args]) : await run('npm', args)
  const [archive] = JSON.parse(stdout)
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
  if (archive.integrity !== lock.packages[`node_modules/${searchPackage}`]?.integrity) {
    throw new Error('The Windows search tool did not match its npm lockfile integrity.')
  }
  await run('tar', ['-xf', join(scratch, archive.filename), '-C', scratch])
  return join(scratch, 'package')
}

async function uninstallCommands(directory, windowsPath = '$INSTDIR\\App') {
  const children = await readdir(directory, { withFileTypes: true })
  const commands = await Promise.all(children.map(async (entry) => {
    const path = windowsPath + '\\' + entry.name.replaceAll('$', () => '$$').replaceAll('"', () => '$\\"')
    if (entry.isDirectory()) return uninstallCommands(join(directory, entry.name), path)
    return `Delete "${path}"`
  }))
  return [...commands, `RMDir "${windowsPath}"`].join('\n')
}

try {
  const search = await ripgrepDirectory()
  console.log('Building the Windows x64 application…')
  await run(process.execPath, ['scripts/build.mjs'], { env: {
    ...process.env,
    ION_TARGET_PLATFORM: 'win32',
    ION_TARGET_ARCH: 'x64',
    ION_BUILD_OUTPUT_DIR: output,
    ION_RIPGREP_PACKAGE_DIR: search,
  } })

  const stage = join(scratch, 'app')
  const native = join(output, 'native')
  const resources = ['ion-rg.exe', 'ion-file-ops.exe', 'ion-update.exe', 'ion-rg-LICENSE.txt', 'ion-rg-NOTICES.txt']
  if (await access(join(native, 'ion-pty.exe')).then(() => true, () => false)) resources.push('ion-pty.exe')
  await mkdir(stage)
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name, productName, version, main, author }))
  await cp(output, join(stage, 'dist'), { recursive: true, filter: (path) => path !== native })

  console.log('Packaging Electron and applying the release security settings…')
  const [payload] = await packager({
    dir: stage,
    out: join(scratch, 'out'),
    tmpdir: scratch,
    name: productName,
    appVersion: version,
    buildVersion: version,
    electronVersion: devDependencies.electron,
    download: { checksums: require('electron/checksums.json') },
    platform: 'win32',
    arch: 'x64',
    icon,
    win32metadata: {
      CompanyName: author,
      FileDescription: productName,
      OriginalFilename: 'Ion IDE.exe',
      'requested-execution-level': 'asInvoker',
    },
    extraResource: resources.map((name) => join(native, name)),
    asar: true,
    prune: false,
  })
  const executable = join(payload, 'Ion IDE.exe')
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  })
  if (signing) {
    console.log('Signing and verifying the application executable…')
    await signWindowsBinary(executable, signing)
    await signWindowsBinary(join(payload, 'resources', 'ion-file-ops.exe'), signing)
    await signWindowsBinary(join(payload, 'resources', 'ion-update.exe'), signing)
    if (resources.includes('ion-pty.exe')) {
      await signWindowsBinary(join(payload, 'resources', 'ion-pty.exe'), signing)
    }
  }

  console.log('Creating the per-user Windows installer…')
  await Promise.all([
    copyFile('scripts/windows/installer.nsi', join(scratch, 'installer.nsi')),
    copyFile(icon, join(scratch, 'ion.ico')),
    uninstallCommands(payload).then((commands) => writeFile(join(scratch, 'uninstall-files.nsh'), commands + '\n')),
  ])
  await run(makensis, [option + 'WX', `${option}DION_VERSION=${version}`, `${option}DION_PAYLOAD=${payload}`,
    `${option}DION_PUBLISHER=${author}`, 'installer.nsi'], {
    cwd: scratch,
    windowsHide: true,
  })
  const filename = `Ion-IDE-${version}-windows-x64-setup.exe`
  const installer = join(scratch, filename)
  if (signing) {
    console.log('Signing and verifying the installer…')
    await signWindowsBinary(installer, signing)
  }
  await mkdir(release, { recursive: true })
  await copyFile(installer, join(release, filename))
  console.log(join(release, filename))
} catch (error) {
  if (error?.stdout) console.error(error.stdout.trim())
  if (error?.stderr) console.error(error.stderr.trim())
  throw error
} finally {
  await rm(scratch, { recursive: true, force: true })
}
