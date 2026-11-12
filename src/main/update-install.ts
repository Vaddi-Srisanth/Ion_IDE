// Loaded on an explicit Install and Restart request, never during editing.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import type { DownloadedUpdate } from './updates'

const run = promisify(execFile)
const bundleId = 'dev.ionide.desktop'
const limits = { timeout: 180_000, maxBuffer: 64 * 1024, windowsHide: true }

export interface PreparedUpdate {
  start(): Promise<void>
  dispose(): Promise<void>
}

export async function verifyUpdateBytes(update: DownloadedUpdate): Promise<void> {
  if (!/^sha256:[a-f0-9]{64}$/.test(update.digest) || !Number.isSafeInteger(update.bytes)
    || update.bytes <= 0 || update.bytes > 512 * 1024 ** 2) throw new Error('Invalid update integrity information.')
  const file = await open(update.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size !== update.bytes) throw new Error('The downloaded update changed. Download it again.')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    if ('sha256:' + hash.digest('hex') !== update.digest) throw new Error('The update failed its checksum check. Download it again.')
  } finally { await file.close() }
}

export function macInstallTarget(executable: string, home = homedir()): string {
  const suffix = '/Ion IDE.app/Contents/MacOS/Ion IDE'
  if (!posix.isAbsolute(executable) || !executable.endsWith(suffix)) throw new Error('Run the installed Ion IDE before updating.')
  const target = executable.slice(0, -'/Contents/MacOS/Ion IDE'.length)
  if (!['/Applications', posix.join(home, 'Applications')].includes(posix.dirname(target))) {
    throw new Error('Move Ion IDE to Applications before updating. Disk images and portable copies cannot update in place.')
  }
  return target
}

async function plist(bundle: string, key: string): Promise<string> {
  return (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, join(bundle, 'Contents/Info.plist')], limits)).stdout.trim()
}

async function verifyBundle(bundle: string, version: string, arch: string): Promise<void> {
  if (!(await lstat(bundle)).isDirectory() || await plist(bundle, 'CFBundleIdentifier') !== bundleId
    || await plist(bundle, 'CFBundleExecutable') !== 'Ion IDE'
    || await plist(bundle, 'CFBundleShortVersionString') !== version) throw new Error('The update is not the expected Ion IDE version.')
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=identifier "' + bundleId + '"', bundle], limits)
  const architectures = (await run('/usr/bin/lipo', ['-archs', join(bundle, 'Contents/MacOS/Ion IDE')], limits)).stdout.trim().split(/\s+/)
  if (!architectures.includes(arch === 'x64' ? 'x86_64' : arch)) throw new Error('The update does not support this Mac’s architecture.')
}

// The helper acknowledges validation while the old process is still alive.
// It waits for natural exit and never kills Ion or bypasses unsaved-work checks.
function launchHelper(helper: string, args: string[]): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const child = spawn(helper, args, { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined } })
    let output = ''
    let errors = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.removeAllListeners('data')
      child.stderr.removeAllListeners('data')
      child.stdout.destroy()
      child.stderr.destroy()
      if (error) { child.kill(); reject(error) }
      else { child.unref(); resolveReady() }
    }
    const timer = setTimeout(() => finish(new Error('The update helper did not become ready. Ion has not been replaced.')), 180_000)
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => finish(new Error(errors.trim() || `The update helper stopped (${code}). Ion has not been replaced.`)))
    child.stderr.on('data', (data: Buffer) => { if (errors.length < 2048) errors += data.toString() })
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
      if (output.length > 256) finish(new Error('Invalid update helper response.'))
      else if (output.includes('READY\n')) finish()
    })
  })
}

export async function prepareUpdate(options: {
  update: DownloadedUpdate; currentVersion: string; executable: string; helper: string;
  profile: string; arch: string; platform: string; packaged: boolean;
}): Promise<PreparedUpdate> {
  const { update, currentVersion, helper, profile, arch, platform } = options
  if (!options.packaged) throw new Error('Install and Restart is available in the installed desktop app.')
  if (!/^\d+\.\d+\.\d+$/.test(update.latest) || !/^\d+\.\d+\.\d+$/.test(currentVersion)
    || update.latest.localeCompare(currentVersion, undefined, { numeric: true }) <= 0) throw new Error('Choose a newer stable update.')
  await verifyUpdateBytes(update)
  const executable = await realpath(options.executable)
  let stage: string | undefined
  let mount: string | undefined
  let attached = false
  let handedOff = false
  try {
    let args: string[]
    if (platform === 'darwin') {
      const target = macInstallTarget(executable)
      await access(dirname(target), constants.W_OK)
      const original = await lstat(target)
      await verifyBundle(target, currentVersion, arch)
      stage = await mkdtemp(join(dirname(target), '.ion-update-'))
      // Hidden, private staging is transient and excluded from Spotlight.
      const hidden = stage + '.noindex'
      const { rename } = await import('node:fs/promises')
      await rename(stage, hidden)
      stage = hidden
      await chmod(stage, 0o700)
      mount = await mkdtemp(join(tmpdir(), 'ion-update-mount-'))
      await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, update.path], limits)
      attached = true
      const source = join(mount, 'Ion IDE.app')
      await verifyBundle(source, update.latest, arch)
      const size = Number((await run('/usr/bin/du', ['-sk', source], limits)).stdout.split(/\s+/)[0])
      if (!Number.isFinite(size) || size > 2 * 1024 ** 2) throw new Error('The update application exceeds the unpacked size limit.')
      const replacement = join(stage, 'Ion IDE.app')
      // Keep extended attributes, including quarantine; no Gatekeeper bypass.
      await run('/usr/bin/ditto', [source, replacement], limits)
      await verifyBundle(replacement, update.latest, arch)
      const quarantine = await run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', update.path], limits)
      await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine.stdout.trim(), replacement], limits)
      await run('/usr/bin/hdiutil', ['detach', mount], limits)
      attached = false
      args = ['--parent', String(process.pid), '--target', target, '--stage', stage,
        '--version', update.latest, '--profile', profile, '--device', String(original.dev), '--inode', String(original.ino), '--protocol', '1']
    } else if (platform === 'win32') {
      stage = dirname(update.path)
      args = ['--parent', String(process.pid), '--target', executable, '--installer', update.path,
        '--sha256', update.digest.slice(7), '--version', update.latest, '--profile', profile]
    } else throw new Error('Install and Restart is unavailable on this platform.')
    const stagedHelper = join(stage, platform === 'win32' ? 'ion-update.exe' : 'ion-update')
    await copyFile(helper, stagedHelper, constants.COPYFILE_EXCL)
    await chmod(stagedHelper, 0o700)
    const ownedStage = stage
    return {
      async start() { await launchHelper(stagedHelper, args); handedOff = true },
      async dispose() {
        if (!handedOff && platform === 'darwin') await rm(ownedStage, { recursive: true, force: true })
        else if (!handedOff) await rm(stagedHelper, { force: true })
      },
    }
  } catch (error) {
    if (stage && platform === 'darwin') await rm(stage, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    if (attached && mount) {
      await run('/usr/bin/hdiutil', ['detach', mount], limits).then(() => { attached = false }, () => {})
    }
    if (mount && !attached) await rm(mount, { recursive: true, force: true }).catch(() => {})
  }
}
