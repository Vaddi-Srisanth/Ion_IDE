import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, rename, rm, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { RecoveryDraft } from '../shared/contracts'
import { isNotebookName, maxNotebookBytes } from '../shared/notebook-path'
import { maxTextCopyBytes } from '../shared/large-text'

const draftLimit = 64
const headerLimit = 32 * 1024
const prefixSize = 8
const draftId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const temporaryName = /^\.ion-recovery-[0-9a-f-]{36}\.tmp$/
const suffix = '.draft'
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function draftTextLimit(name: string): number {
  return isNotebookName(name) ? maxNotebookBytes : maxTextCopyBytes
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function validateId(value: unknown): string {
  if (typeof value !== 'string' || !draftId.test(value)) throw new Error('Invalid recovery draft ID.')
  return value
}

function boundedString(value: unknown, maxLength: number, maxBytes: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && Buffer.byteLength(value) <= maxBytes
    && !/[\uD800-\uDFFF]/u.test(value)
}

function draftMetadata(value: Record<string, unknown>): RecoveryDraft {
  const id = validateId(value.id)
  const { name, originalPath } = value
  if (!boundedString(name, 1024, 1024) || !name || /[/\0]/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid recovery draft name.')
  }
  if (originalPath === undefined) return { id, name }
  if (!boundedString(originalPath, 4096, 16 * 1024) || !isAbsolute(originalPath) || originalPath.includes('\0')) {
    throw new Error('Invalid recovery draft original path.')
  }
  return { id, name, originalPath }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid recovery draft.')
  return value as Record<string, unknown>
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const data = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(data, offset, length - offset, position + offset)
    if (!bytesRead) throw new Error('Incomplete recovery draft.')
    offset += bytesRead
  }
  return data
}

async function readHeader(handle: FileHandle, id: string) {
  const stats = await handle.stat()
  if (!stats.isFile() || stats.size > prefixSize + headerLimit + maxNotebookBytes) throw new Error('Invalid recovery draft size.')
  const prefix = await readExact(handle, prefixSize, 0)
  const headerBytes = prefix.readUInt32BE(0)
  const textBytes = prefix.readUInt32BE(4)
  const textOffset = prefixSize + headerBytes
  if (headerBytes > headerLimit || textOffset + textBytes !== stats.size) {
    throw new Error('Invalid recovery draft size.')
  }
  const header = asRecord(JSON.parse(textDecoder.decode(await readExact(handle, headerBytes, prefixSize))))
  const metadata = draftMetadata(header)
  if (header.version !== 1 || metadata.id !== id || textBytes > draftTextLimit(metadata.name)) throw new Error('Invalid recovery draft header.')
  return { metadata, textBytes, textOffset }
}

export class RecoveryStore {
  private operations: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string) {}

  // Wait for accepted requests to settle. Individual request failures still go
  // to their callers; they must not strand later checkpoints or shutdown.
  drain(): Promise<void> { return this.operations }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  private async hasDirectory(): Promise<boolean> {
    try {
      if (!(await lstat(this.directory)).isDirectory()) throw new Error('The recovery storage path must be a directory.')
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }

  private path(id: string): string {
    return join(this.directory, id + suffix)
  }

  private open(id: string): Promise<FileHandle> {
    return open(this.path(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  }

  private async *ids(cleanTemporary = false): AsyncGenerator<string> {
    const directory = await opendir(this.directory)
    for await (const entry of directory) {
      if (!entry.isFile()) continue
      if (cleanTemporary && temporaryName.test(entry.name)) {
        // A prior process may have stopped before publishing the draft.
        await rm(join(this.directory, entry.name), { force: true }).catch(() => undefined)
      } else if (entry.name.endsWith(suffix)) {
        const id = entry.name.slice(0, -suffix.length)
        if (draftId.test(id)) yield id
      }
    }
  }

  list(): Promise<RecoveryDraft[]> {
    return this.serialize(async () => {
      const drafts: RecoveryDraft[] = []
      if (!await this.hasDirectory()) return drafts
      let seen = 0
      for await (const id of this.ids(true)) {
        if (++seen > draftLimit) break
        try {
          const handle = await this.open(id)
          try {
            drafts.push((await readHeader(handle, id)).metadata)
          } finally {
            await handle.close()
          }
        } catch {
          // A damaged snapshot must not prevent other drafts from being recovered.
        }
      }
      return drafts
    })
  }

  async read(value: unknown): Promise<string> {
    const id = validateId(value)
    return this.serialize(async () => {
      if (!await this.hasDirectory()) throw new Error('Recovery draft is unavailable.')
      try {
        const handle = await this.open(id)
        try {
          const { textBytes, textOffset } = await readHeader(handle, id)
          return textDecoder.decode(await readExact(handle, textBytes, textOffset))
        } finally {
          await handle.close()
        }
      } catch {
        throw new Error('Recovery draft is unavailable or damaged.')
      }
    })
  }

  async write(value: unknown): Promise<void> {
    const draft = asRecord(value)
    const metadata = draftMetadata(draft)
    const { text } = draft
    const limit = draftTextLimit(metadata.name)
    if (!boundedString(text, limit, limit)) throw new Error(`Recovery drafts support UTF-8 text up to ${limit / (1024 * 1024)} MiB for this file type.`)

    return this.serialize(async () => {
      if (!await this.hasDirectory()) await mkdir(this.directory, { mode: 0o700, recursive: true })
      const path = this.path(metadata.id)
      try {
        if (!(await lstat(path)).isFile()) throw new Error('Invalid recovery draft destination.')
      } catch (error) {
        if (!isMissing(error)) throw error
        let count = 0
        for await (const _id of this.ids()) {
          if (++count >= draftLimit) throw new Error('Recovery storage has reached its 64-draft limit.')
        }
      }

      const header = Buffer.from(JSON.stringify({ version: 1, ...metadata }))
      if (header.length > headerLimit) throw new Error('Invalid recovery draft header.')
      const prefix = Buffer.alloc(prefixSize)
      prefix.writeUInt32BE(header.length, 0)
      prefix.writeUInt32BE(Buffer.byteLength(text), 4)
      const temporary = join(this.directory, '.ion-recovery-' + randomUUID() + '.tmp')
      const handle = await open(temporary, 'wx', 0o600)
      try {
        try {
          await handle.writeFile(prefix)
          await handle.writeFile(header)
          await handle.writeFile(text, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    })
  }

  async remove(value: unknown): Promise<void> {
    if (!Array.isArray(value) || value.length > draftLimit) throw new Error('Invalid recovery draft IDs.')
    const ids = new Set(Array.from(value, validateId))
    return this.serialize(async () => {
      if (!ids.size || !await this.hasDirectory()) return
      for (const id of ids) await rm(this.path(id), { force: true })
    })
  }
}
