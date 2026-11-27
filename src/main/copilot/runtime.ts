import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'

const execFile = promisify(execFileCallback)
const version = '1.575.0'
const archiveLimit = 128 * 1024 * 1024
const packages = {
  'darwin-arm64': {
    name: '@github/copilot-language-server-darwin-arm64',
    integrity: 'sha512-tL34Jav+uY4jYGNjX+9BuD8c8+3fhinMtSYaGIXZZcUasTNAZvMEN4XDQJbPit0Ad896sbuUOEbnMii69+IhZg==',
  },
  'win32-x64': {
    name: '@github/copilot-language-server-win32-x64',
    integrity: 'sha512-/fVvw60gZJoU2XCTddtIrkiern8NEp+MgxtZe1DlAdEVH4OrWRbquE68Iq3CLes0ZPhIEnCFp3Dfi/qJUwv1dQ==',
  },
} as const

export interface CopilotRuntimeOptions {
  directory: string
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof globalThis.fetch
  extract?: (archive: string, destination: string) => Promise<void>
  signal?: AbortSignal
}

export function copilotExecutableName(platform: NodeJS.Platform): string {
  return 'copilot-language-server' + (platform === 'win32' ? '.exe' : '')
}

/** Installs only the pinned official native server, on explicit user action, inside Ion's private profile. */
export async function installCopilotRuntime(options: CopilotRuntimeOptions): Promise<{ executable: string; version: string }> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const key = `${platform}-${arch}` as keyof typeof packages
  const selected = packages[key]
  if (!selected) throw new Error('GitHub Copilot is supported only on macOS Apple Silicon and Windows x64.')

  await mkdir(dirname(options.directory), { recursive: true, mode: 0o700 })
  const parent = await realpath(dirname(options.directory))
  const target = join(parent, 'copilot-runtime-' + version)
  const existing = await runtimeExecutable(target, platform)
  if (existing) return { executable: existing, version }
  if (await pathExists(target)) throw new Error('An incomplete GitHub Copilot runtime already exists. Remove it from Ion’s private profile before retrying.')

  const temp = join(parent, `.copilot-${randomUUID()}`)
  const archive = `${temp}.tgz`
  const stage = `${temp}-stage`
  await mkdir(stage, { mode: 0o700 })
  try {
    const url = `https://registry.npmjs.org/${selected.name}/-/${selected.name.split('/')[1]}-${version}.tgz`
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
    const response = await (options.fetch ?? globalThis.fetch)(url, { redirect: 'error', signal })
    if (!response.ok || !response.body) throw new Error(`GitHub Copilot runtime download failed (${response.status}).`)
    const digest = createHash('sha512')
    let bytes = 0
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > archiveLimit) return callback(new Error('GitHub Copilot runtime archive exceeds the size limit.'))
      digest.update(chunk)
      callback(null, chunk)
    } })
    await pipeline(response.body, meter, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
    const actual = `sha512-${digest.digest('base64')}`
    if (actual !== selected.integrity) throw new Error('GitHub Copilot runtime integrity check failed.')

    await (options.extract ?? ((file, destination) => extractPackage(file, destination, platform)))(archive, stage)
    const manifest = JSON.parse(await readFile(join(stage, 'package', 'package.json'), 'utf8')) as Record<string, unknown>
    if (manifest.name !== selected.name || manifest.version !== version || manifest.license !== 'MIT') {
      throw new Error('GitHub Copilot runtime package identity did not match the pinned release.')
    }
    const binary = join(stage, 'package', copilotExecutableName(platform))
    const binaryStat = await lstat(binary)
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw new Error('GitHub Copilot runtime executable is invalid.')
    await chmod(binary, 0o700)
    const finalDirectory = join(stage, 'package')
    if (await pathExists(target)) throw new Error('A GitHub Copilot runtime was installed concurrently. Reopen Copilot and retry.')
    await rename(finalDirectory, target)
    return { executable: join(target, copilotExecutableName(platform)), version }
  } finally {
    await Promise.all([rm(archive, { force: true }), rm(stage, { recursive: true, force: true })])
  }
}

async function runtimeExecutable(directory: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const executable = join(directory, copilotExecutableName(platform))
  try {
    const [directoryStat, fileStat, manifest] = await Promise.all([
      lstat(directory), lstat(executable), readFile(join(directory, 'package.json'), 'utf8'),
    ])
    const identity = JSON.parse(manifest) as Record<string, unknown>
    if (directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && fileStat.isFile() && !fileStat.isSymbolicLink()
      && identity.version === version && identity.name === packages[`${platform}-${process.arch}` as keyof typeof packages]?.name) return executable
  } catch { /* No complete runtime is available; a fresh verified install may proceed. */ }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function extractPackage(archive: string, destination: string, platform: NodeJS.Platform): Promise<void> {
  const executable = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  const flags = process.platform === 'win32' ? [] : ['--no-same-owner', '--no-same-permissions']
  await execFile(executable, ['-xzf', archive, '-C', destination, ...flags,
    `package/${copilotExecutableName(platform)}`, 'package/package.json'],
    { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
}
