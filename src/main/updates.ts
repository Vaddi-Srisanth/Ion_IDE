import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateStatus } from '../shared/updates'

const repository = 'Vaddi-Srisanth/Ion_IDE'
const latestEndpoint = `https://api.github.com/repos/${repository}/releases/latest`
const assetHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
const versionPattern = /^(?:v)?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/
const maxMetadataBytes = 1024 * 1024
const maxInstallerBytes = 512 * 1024 * 1024
const run = promisify(execFile)

interface Installer {
  name: string
  url: string
  digest: string
  bytes: number
}

export interface DownloadedUpdate extends Installer { path: string; latest: string }
const cacheFolder = /^Ion Update [A-Za-z0-9]{6}$/

async function pruneCache(destination: string, keep?: string): Promise<void> {
  const folders = await readdir(destination, { withFileTypes: true })
  await Promise.all(folders.filter((entry) => entry.isDirectory() && cacheFolder.test(entry.name) && entry.name !== keep)
    .map((entry) => rm(join(destination, entry.name), { recursive: true, force: true }).catch(() => {})))
}

type Result = { status: UpdateStatus; installer?: Installer }

function platformSuffix(platform: string, arch: string): string | undefined {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `mac-${arch}.dmg`
  if (platform === 'win32' && arch === 'x64') return 'windows-x64-setup.exe'
}

function newer(latest: RegExpExecArray, current: RegExpExecArray): boolean {
  for (let part = 1; part <= 3; part++) {
    const delta = Number(latest[part]) - Number(current[part])
    if (delta) return delta > 0
  }
  return false
}

function selectInstaller(data: unknown, current: string, suffix: string): Result {
  const installed = versionPattern.exec(current)
  if (!installed) return { status: { current, state: 'unsupported' } }
  if (!data || typeof data !== 'object') throw new Error('GitHub returned invalid release information.')
  const release = data as Record<string, unknown>
  const tag = release.tag_name
  const match = typeof tag === 'string' ? versionPattern.exec(tag) : null
  if (!match || release.draft !== false || release.prerelease !== false) {
    throw new Error('GitHub returned an unsupported release version.')
  }
  const latest = match.slice(1).join('.')
  if (!newer(match, installed)) return { status: { current, state: 'current' } }
  const name = `Ion-IDE-${latest}-${suffix}`
  const url = `https://github.com/${repository}/releases/download/${tag}/${name}`
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => item && typeof item === 'object' && item.name === name) : undefined
  const digest = asset?.digest
  const bytes = asset?.size
  if (asset?.state !== 'uploaded' || asset.browser_download_url !== url || typeof digest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxInstallerBytes) {
    return { status: { current, latest, state: 'asset-missing' } }
  }
  return { status: { current, latest, state: 'available', name, bytes }, installer: { name, url, digest, bytes } }
}

async function readMetadata(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('GitHub returned empty release information.')
  let bytes = 0
  const parts: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxMetadataBytes) throw new Error('GitHub release information exceeded the size limit.')
      parts.push(value)
    }
    return JSON.parse(Buffer.concat(parts, bytes).toString('utf8')) as unknown
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function markDownloadedFile(path: string, origin: string): Promise<void> {
  if (process.platform === 'darwin') {
    const timestamp = Math.floor(Date.now() / 1000).toString(16)
    await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${timestamp};Ion IDE;`, path], { timeout: 5000 })
  } else if (process.platform === 'win32') {
    await writeFile(`${path}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${origin}\r\n`)
  }
}

export class GitHubUpdates {
  private result?: Result
  private checkPending?: Promise<UpdateStatus>
  private downloadController?: AbortController
  private downloaded?: DownloadedUpdate
  private notice?: string

  constructor(private readonly current: string, private readonly platform: string, private readonly arch: string,
    private readonly request: typeof fetch = fetch) {}

  status(): UpdateStatus {
    const status = this.result?.status ?? { current: this.current, state: 'unchecked' as const }
    return { ...status, ...(this.notice ? { notice: this.notice } : {}),
      ...(status.state === 'available' && this.downloaded?.name === status.name ? { ready: true } : {}) }
  }

  ready(): DownloadedUpdate {
    if (!this.downloaded || this.status().state !== 'available' || this.result?.installer?.name !== this.downloaded.name) {
      throw new Error('Download and verify the update before installing it.')
    }
    return { ...this.downloaded }
  }

  // Loaded only when Updates is requested. The receipt cannot nominate an
  // arbitrary path, URL, executable or command. Bytes are rehashed at install.
  async restore(destination: string): Promise<void> {
    try {
      const file = await open(join(destination, 'result.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await file.stat()
        if (info.isFile() && info.size <= 4096) {
          const buffer = Buffer.alloc(4097)
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
          if (bytesRead <= 4096) {
            const result = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as Record<string, unknown>
            if (result.schemaVersion === 1 && ['installed', 'failed'].includes(String(result.state))
              && typeof result.message === 'string' && result.message.length <= 512) {
              this.notice = result.message.replace(/[\u0000-\u001f\u007f]/g, ' ')
            }
          }
        }
      } finally { await file.close() }
    } catch { /* An absent receipt is normal before the first in-place update. */ }
    try {
      if (!(await lstat(destination)).isDirectory()) return
      const path = join(destination, 'ready.json')
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let saved: Record<string, unknown>
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > 4096) return
        const buffer = Buffer.alloc(4097)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 4096) return
        saved = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as Record<string, unknown>
      } finally { await file.close() }
      if (typeof saved.folder !== 'string' || !cacheFolder.test(saved.folder)) return
      const suffix = platformSuffix(this.platform, this.arch)
      if (!suffix) return
      const result = selectInstaller(saved.release, this.current, suffix)
      if (!result.installer || result.status.state !== 'available') { await pruneCache(destination); return }
      const directory = join(destination, saved.folder)
      if (!(await lstat(directory)).isDirectory()) return
      const payload = join(directory, result.installer.name)
      const stat = await lstat(payload)
      if (!stat.isFile() || stat.size !== result.installer.bytes) return
      this.result = result
      this.downloaded = { ...result.installer, latest: result.status.latest, path: payload }
      await pruneCache(destination, saved.folder)
    } catch { /* A missing or damaged receipt never blocks ordinary editing. */ }
  }

  check(): Promise<UpdateStatus> {
    if (this.checkPending) return this.checkPending
    this.checkPending = this.getLatest().then((result) => {
      this.result = result
      return this.status()
    }).finally(() => { this.checkPending = undefined })
    return this.checkPending
  }

  private async getLatest(): Promise<Result> {
    const suffix = platformSuffix(this.platform, this.arch)
    if (!suffix || !versionPattern.test(this.current)) return { status: { current: this.current, state: 'unsupported' } }
    let response: Response
    try {
      response = await this.request(latestEndpoint, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ion IDE updater' },
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new Error('Could not reach GitHub. Check your connection and try again.')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 404) return { status: { current: this.current, state: 'no-release' } }
      throw new Error(`GitHub could not check for updates (HTTP ${response.status}). Try again later.`)
    }
    return selectInstaller(await readMetadata(response), this.current, suffix)
  }

  cancel(): void { this.downloadController?.abort() }

  private async assetResponse(installer: Installer, signal: AbortSignal): Promise<Response> {
    let url = new URL(installer.url)
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== 'https:' || !assetHosts.has(url.hostname) || url.username || url.password || url.port) break
      const response = await this.request(url, { redirect: 'manual', signal, headers: { 'Accept-Encoding': 'identity' } })
      if (response.ok && response.body) return response
      await response.body?.cancel().catch(() => undefined)
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        throw new Error(`GitHub could not download the installer (HTTP ${response.status}).`)
      }
      const location = response.headers.get('location')
      if (!location) break
      url = new URL(location, url)
    }
    throw new Error('GitHub returned an unexpected installer download location.')
  }

  async download(destination: string, persist = false): Promise<{ name: string; path: string }> {
    const installer = this.result?.installer
    if (!installer) throw new Error('Check for an available update first.')
    if (this.downloaded?.name === installer.name) return this.downloaded
    if (this.downloadController) throw new Error('An update download is already running.')
    const controller = new AbortController()
    this.downloadController = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)])
    let directory: string | undefined
    let published = false
    try {
      await mkdir(destination, { recursive: true, mode: 0o700 })
      if (!(await lstat(destination)).isDirectory()) throw new Error('The update cache must be a regular directory.')
      directory = await mkdtemp(join(destination, 'Ion Update '))
      const temporary = join(directory, installer.name + '.part')
      const path = join(directory, installer.name)
      const response = await this.assetResponse(installer, signal)
      const reader = response.body!.getReader()
      const hash = createHash('sha256')
      let bytes = 0
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > installer.bytes) throw new Error('The installer exceeded its expected size.')
            hash.update(value)
            await file.writeFile(value)
          }
          await file.sync()
        } finally { await file.close() }
      } finally { await reader.cancel().catch(() => undefined) }
      signal.throwIfAborted()
      if (bytes !== installer.bytes || `sha256:${hash.digest('hex')}` !== installer.digest) {
        throw new Error('The installer failed the GitHub checksum check.')
      }
      try {
        await markDownloadedFile(temporary, installer.url)
      } catch {
        throw new Error('Could not mark the installer as an internet download. Download it from Ion’s GitHub Releases page instead.')
      }
      signal.throwIfAborted()
      await rename(temporary, path)
      const latest = this.result!.status.state === 'available' ? this.result!.status.latest : ''
      if (persist) {
        const receipt = { folder: basename(directory), release: {
          tag_name: 'v' + latest, draft: false, prerelease: false,
          assets: [{ ...installer, state: 'uploaded', size: installer.bytes, browser_download_url: installer.url }],
        } }
        const temporaryReceipt = join(destination, '.ready-' + randomUUID() + '.json')
        try {
          const file = await open(temporaryReceipt, 'wx', 0o600)
          try { await file.writeFile(JSON.stringify(receipt)); await file.sync() } finally { await file.close() }
          await rename(temporaryReceipt, join(destination, 'ready.json'))
        } finally { await rm(temporaryReceipt, { force: true }) }
        await pruneCache(destination, basename(directory))
      }
      const previous = this.downloaded
      this.downloaded = { ...installer, latest, path }
      if (previous && dirname(previous.path) !== directory) await rm(dirname(previous.path), { recursive: true, force: true })
      published = true
      return { name: installer.name, path }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Update download canceled.')
      if (signal.aborted) throw new Error('The update download timed out. Try again.')
      throw error
    } finally {
      if (!published && directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      this.downloadController = undefined
    }
  }
}
