import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

if (process.platform !== 'darwin') throw new Error('Install Ion IDE on a Mac.')
const { values } = parseArgs({ options: { source: { type: 'string' } } })
const project = fileURLToPath(new URL('..', import.meta.url))
const applications = join(homedir(), 'Applications')
const installed = join(applications, 'Ion IDE.app')
const rollback = join(homedir(), 'Library', 'Application Support', 'Ion IDE Rollback')
const bundleId = 'dev.ionide.desktop'
const command = (binary, args) => execFileSync(binary, args, { encoding: 'utf8' }).trim()

function bundleInfo(bundle, key) {
  return command('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, join(bundle, 'Contents', 'Info.plist')])
}

async function optionalStat(path) {
  return lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

function assertNotRunning() {
  const processes = command('/bin/ps', ['-axww', '-o', 'comm=']).split('\n')
  if (processes.some((path) => path.trimStart().startsWith(installed + '/'))) {
    throw new Error('Quit the installed Ion IDE before updating it.')
  }
}

async function verify(bundle) {
  if (!(await lstat(bundle)).isDirectory() || bundleInfo(bundle, 'CFBundleIdentifier') !== bundleId) {
    throw new Error('Expected a regular Ion IDE application bundle.')
  }
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=identifier "' + bundleId + '"', bundle])
  const executable = bundleInfo(bundle, 'CFBundleExecutable')
  if (executable !== 'Ion IDE' || !command('/usr/bin/lipo', ['-archs', join(bundle, 'Contents', 'MacOS', executable)])
    .split(/\s+/).includes(process.arch)) throw new Error('The Ion IDE bundle does not match this Mac’s architecture.')
}

await mkdir(applications, { recursive: true })
if (!(await lstat(applications)).isDirectory()) throw new Error('Expected a regular ~/Applications directory.')
assertNotRunning()
const lock = join(applications, '.ion-update-lock')
await mkdir(lock)
let output
let stage
let archiveStage
let retainStage = false
try {
  let source = values.source && resolve(values.source)
  if (!source) {
    const { version } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
    output = await mkdtemp(join(tmpdir(), 'ion-install-build-'))
    execFileSync(process.execPath, [join(project, 'scripts', 'package-mac.mjs')], {
      cwd: project, stdio: 'inherit', env: { ...process.env, ION_MAC_ARCH: process.arch, ION_MAC_OUTPUT_DIR: output },
    })
    source = join(output, `Ion IDE-${version}-darwin-${process.arch}`, 'Ion IDE.app')
  }
  await verify(source)
  if (await realpath(source) === installed) throw new Error('This is already the installed Ion IDE.')

  const previous = await optionalStat(installed)
  if (previous && (!previous.isDirectory() || bundleInfo(installed, 'CFBundleIdentifier') !== bundleId)) {
    throw new Error('The Applications destination contains a different item.')
  }

  stage = await mkdtemp(join(applications, '.ion-update-'))
  const replacement = join(stage, 'Ion IDE.app')
  const original = join(stage, 'previous')
  command('/usr/bin/ditto', ['--norsrc', '--noextattr', source, replacement])
  await verify(replacement)
  const version = bundleInfo(replacement, 'CFBundleShortVersionString')

  if (previous) {
    await mkdir(rollback, { recursive: true, mode: 0o700 })
    if (!(await lstat(rollback)).isDirectory()) throw new Error('Expected a regular Ion IDE rollback directory.')
    archiveStage = await mkdtemp(join(rollback, '.ion-archive-'))
    const zip = join(archiveStage, 'Ion IDE.zip')
    command('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', installed, zip])
    command('/usr/bin/unzip', ['-tq', zip])
    await rename(zip, join(rollback, 'Ion IDE.zip'))
  }

  const current = await optionalStat(installed)
  if (current?.ino !== previous?.ino || current?.dev !== previous?.dev) {
    throw new Error('The installed Ion IDE changed during the update. Run the installer again.')
  }
  assertNotRunning()
  if (previous) await rename(installed, original)
  try {
    await rename(replacement, installed)
  } catch (error) {
    if (previous) {
      try {
        await rename(original, installed)
      } catch (rollbackError) {
        retainStage = true
        throw new AggregateError([error, rollbackError], 'Restore the previous Ion IDE bundle from ' + original)
      }
    }
    throw error
  }
  console.log('Installed Ion IDE ' + version + ' at ' + installed)
} finally {
  await Promise.all([
    stage && !retainStage && rm(stage, { recursive: true, force: true }),
    archiveStage && rm(archiveStage, { recursive: true, force: true }),
    output && rm(output, { recursive: true, force: true }),
    rmdir(lock),
  ])
}
