import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const maxRoots = 64
const maxBytes = 64 * 1024
const replaceDelays = [25, 50, 100, 200]
const unavailable = 'Run permissions could not be read safely. The existing permissions file was left in place. Clear remembered Run permissions to reset it.'

export interface TrustRoot {
  path: string
  // Strings retain Windows file IDs beyond Number.MAX_SAFE_INTEGER.
  dev: string
  ino: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validRoot(value: unknown): value is TrustRoot {
  return record(value) && Object.keys(value).length === 3
    && typeof value.path === 'string' && value.path.length <= 32768 && !value.path.includes('\0') && isAbsolute(value.path)
    && typeof value.dev === 'string' && /^(?:0|[1-9]\d{0,39})$/.test(value.dev)
    && typeof value.ino === 'string' && /^[1-9]\d{0,39}$/.test(value.ino)
}

function same(left: TrustRoot, right: TrustRoot): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino
}

async function replace(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, destination)
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      const wait = replaceDelays[attempt]
      if (process.platform !== 'win32' || wait === undefined
        || (code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY')) throw error
      // Retry only a short-lived Windows file lock, retaining atomic replacement.
      await delay(wait)
    }
  }
}

export class RunTrustStore {
  private mutations: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async snapshot(root: string): Promise<TrustRoot> {
    if (typeof root !== 'string' || root.length > 32768 || root.includes('\0') || !isAbsolute(root)) {
      throw new Error('Choose an existing local workspace folder before remembering Run permissions.')
    }
    const canonical = await realpath(root)
    const stats = await lstat(canonical, { bigint: true })
    const snapshot = { path: canonical, dev: stats.dev.toString(), ino: stats.ino.toString() }
    if (!stats.isDirectory() || stats.isSymbolicLink() || !validRoot(snapshot)) {
      throw new Error('Run permissions require a real workspace folder with a stable file identity.')
    }
    return snapshot
  }

  async trusted(root: TrustRoot): Promise<boolean> {
    await this.mutations
    if (!validRoot(root)) return false
    try {
      if (!same(root, await this.snapshot(root.path))) return false
      return (await this.read()).some((entry) => same(entry, root))
    } catch {
      // An unreadable database never grants permission. A normal Run can still
      // ask once; remember() reports the recovery action instead of overwriting.
      return false
    }
  }

  remember(root: TrustRoot): Promise<void> {
    // Copy the approval identity now so a caller cannot mutate it while queued.
    const approved = { ...root }
    return this.queue(async () => {
      if (!validRoot(approved) || !same(approved, await this.snapshot(approved.path))) {
        throw new Error('The workspace folder changed. Confirm Run permissions for the current folder again.')
      }
      const previous = await this.read()
      const roots = previous.filter((entry) => entry.path !== approved.path)
      roots.push(approved)
      while (roots.length > maxRoots) roots.shift()
      let text = JSON.stringify({ version: 1, roots }) + '\n'
      while (Buffer.byteLength(text) > maxBytes && roots.length > 1) {
        roots.shift()
        text = JSON.stringify({ version: 1, roots }) + '\n'
      }
      if (Buffer.byteLength(text) > maxBytes) throw new Error('The workspace path is too long to remember safely.')
      // Revalidate after reading the database, immediately before committing.
      if (!same(approved, await this.snapshot(approved.path))) {
        throw new Error('The workspace folder changed. Confirm Run permissions again.')
      }
      await this.write(text)
    })
  }

  clear(): Promise<void> {
    // An explicit reset is allowed even when the previous file is damaged.
    return this.queue(() => this.write('{"version":1,"roots":[]}\n'))
  }

  drain(): Promise<void> { return this.mutations }

  private queue(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutations.then(operation)
    this.mutations = pending.catch(() => {})
    return pending
  }

  private async read(): Promise<TrustRoot[]> {
    let existed = false
    try {
      // lstat also rejects links on Windows, where O_NOFOLLOW may be unavailable.
      const before = await lstat(this.path, { bigint: true })
      existed = true
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error(unavailable)
      const file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const stats = await file.stat({ bigint: true })
        if (!stats.isFile() || stats.dev !== before.dev || stats.ino !== before.ino
          || stats.size !== before.size || stats.mtimeNs !== before.mtimeNs) throw new Error(unavailable)
        const bytes = Buffer.alloc(Number(stats.size))
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
          if (!bytesRead) throw new Error(unavailable)
          offset += bytesRead
        }
        const after = await file.stat({ bigint: true })
        if (after.size !== stats.size || after.mtimeNs !== stats.mtimeNs) throw new Error(unavailable)
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!record(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Array.isArray(value.roots)
          || value.roots.length > maxRoots || !value.roots.every(validRoot)
          || new Set(value.roots.map((entry) => entry.path)).size !== value.roots.length) throw new Error(unavailable)
        return value.roots
      } finally { await file.close() }
    } catch (error) {
      if (!existed && error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw new Error(unavailable)
    }
  }

  private async write(text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(this.path), '.ion-run-trust-' + randomUUID() + '.tmp')
    let owned = false
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      owned = true
      try {
        await file.writeFile(text)
        await file.sync()
      } finally { await file.close() }
      await replace(temporary, this.path)
    } finally {
      if (owned) await rm(temporary, { force: true }).catch(() => {})
    }
  }
}
