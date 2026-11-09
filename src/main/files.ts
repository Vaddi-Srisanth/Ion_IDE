import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { access, copyFile, lstat, link, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Entry, EntryKind, FileContents, FileRevision } from '../shared/contracts'
import { isNotebookName, maxNotebookBytes } from '../shared/notebook-path'
import { documentFormat } from '../shared/viewers'
import { largeTextError, maxEditableTextBytes, maxTextCopyBytes, maxTextPreviewBytes, textPageBytes, type TextPage } from '../shared/large-text'

export const maxFileBytes = maxEditableTextBytes
const maxDirectoryEntries = 4000
const noFollow = constants.O_NOFOLLOW ?? 0
const nonBlock = constants.O_NONBLOCK ?? 0
const windows = process.platform === 'win32'
const windowsDeviceName = /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i
const windowsReplaceDelays = [25, 50, 100, 200, 400]
const fileChanged = 'FILE_CHANGED: This file changed on disk. Reopen it or use Save As to keep your edits.'

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
}

export function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) return false
  // Windows path.relative folds case even for separate directories on case-sensitive NTFS.
  return !windows || path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function invalidWindowsName(name: string): boolean {
  return /[<>:"|?*\x01-\x1f]|[ .]$/.test(name) || windowsDeviceName.test(name)
}

function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value !== resolve(value) || value.includes('\0') || value.length > 4096) {
    throw new Error('Invalid file path.')
  }
  if (windows && (/^\\\\[?.]\\/.test(value) || value.replace(/^[a-z]:/i, '').includes(':')
    || value.slice(parse(value).root.length).split(sep).some(invalidWindowsName))) {
    throw new Error('Choose a regular Windows file or folder.')
  }
  return value
}

export function entryName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..'
    || (windows ? value.length : Buffer.byteLength(value)) > 255 || /[/\\\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Enter a valid file or folder name.')
  }
  if (windows && invalidWindowsName(value)) {
    throw new Error('Enter a valid Windows file or folder name.')
  }
  return value
}

export function fileText(value: unknown, limit = maxFileBytes): string {
  if (typeof value !== 'string' || value.length > limit
    || Buffer.byteLength(value) > limit || /[\0\uD800-\uDFFF]/u.test(value)) {
    throw new Error(`Only UTF-8 text up to ${limit / (1024 * 1024)} MiB is supported.`)
  }
  return value
}

function toEntry(path: string, kind: EntryKind): Entry {
  return { path, kind, name: basename(path) || path }
}

async function resolveEntry(value: unknown, expected?: EntryKind, requireCanonical = false): Promise<Entry> {
  const requested = absolutePath(value)
  const path = await realpath(requested)
  if (requireCanonical && path !== requested) throw new Error('The local source path changed.')
  const stats = await getStats(path)
  const kind = stats.isFile() ? 'file' : 'folder'
  if (expected && expected !== kind) throw new Error('The selected item is no longer a ' + expected + '.')
  return toEntry(path, kind)
}

export function revision(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join(':')
}

function contentHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function getStats(path: string): Promise<BigIntStats> {
  const stats = await lstat(path, { bigint: true })
  if ((!stats.isFile() && !stats.isDirectory()) || await realpath(path) !== path) {
    throw new Error('Open a regular file or folder. Symbolic links within the explorer are unsupported.')
  }
  return stats
}

async function existingStats(path: string): Promise<BigIntStats | null> {
  try {
    return await getStats(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

async function saveAsTarget(path: string): Promise<{ path: string; before: BigIntStats | null }> {
  if (!windows) return { path, before: await existingStats(path) }
  try {
    const before = await lstat(path, { bigint: true })
    if (!before.isFile()) throw new Error('Choose a regular file as the destination.')
    const canonical = await realpath(path)
    // The native picker can return the user's case spelling. Accept only that alias in its chosen folder.
    if (dirname(canonical) !== dirname(path) || relative(path, canonical) !== '') {
      throw new Error('Choose a regular file as the destination.')
    }
    return { path: canonical, before }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { path, before: null }
    throw error
  }
}

async function readStableBytes(path: string, limit: number): Promise<{ data: Buffer; stats: BigIntStats }> {
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(limit)) {
      throw new Error(limit === maxNotebookBytes ? 'Ion opens UTF-8 notebooks up to 16 MiB.' : 'Only UTF-8 text files up to 2 MiB are supported.')
    }
    const data = Buffer.allocUnsafe(Number(before.size))
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const stats = await getStats(path)
    if (offset !== data.length || revision(before) !== revision(stats)) {
      throw new Error('FILE_CHANGED: The file changed while opening. Try again.')
    }
    return { data, stats }
  } finally {
    await handle.close()
  }
}

async function replaceSource(temporary: string, path: string, parent: string, expected: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      // A program that blocked the previous attempt may have changed the file before releasing it.
      if (await realpath(parent) !== parent) throw new Error('The destination folder changed.')
      const current = await existingStats(path)
      if (!current || revision(current) !== expected) throw new Error(fileChanged)
      await rename(temporary, path)
      return
    } catch (error) {
      const code = errorCode(error)
      if (!windows || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw error
      const wait = windowsReplaceDelays[attempt]
      if (wait === undefined) {
        throw new Error('Windows could not replace this file. Close any program using it, check write permissions, or use Save As.', { cause: error })
      }
      await delay(wait)
    }
  }
}

async function writeAtomically(path: string, text: string, previous: BigIntStats | null): Promise<string> {
  const parent = dirname(path)
  if (await realpath(parent) !== parent) throw new Error('The destination folder changed.')
  if (previous) await access(path, constants.W_OK)
  const temporary = join(parent, '.ion-' + randomUUID() + '.tmp')
  const handle = await open(temporary, 'wx', previous ? Number(previous.mode & 0o777n) : 0o666)

  try {
    try {
      await handle.writeFile(text, 'utf8')
      if (previous) await handle.chmod(Number(previous.mode & 0o777n))
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (previous) {
      await replaceSource(temporary, path, parent, revision(previous))
    } else {
      if (await realpath(parent) !== parent) throw new Error('The destination folder changed.')
      // A hard link publishes the completed file only if the destination is still absent.
      try {
        await link(temporary, path)
      } catch (error) {
        // Volumes such as exFAT cannot create hard links, but an exclusive copy still avoids clobbering.
        if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes(errorCode(error) ?? '')) throw error
        await copyFile(temporary, path, constants.COPYFILE_EXCL)
      }
      await rm(temporary)
    }
    return revision(await lstat(path, { bigint: true }))
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export class WorkspaceFiles {
  private root: string | null = null
  private readonly files = new Set<string>()
  private mutation: Promise<void> = Promise.resolve()

  get rootPath(): string | null {
    return this.root
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation)
    this.mutation = result.then(() => undefined, () => undefined)
    return result
  }

  async grant(value: unknown, expected?: EntryKind, requireCanonical = false): Promise<Entry> {
    const entry = await resolveEntry(value, expected, requireCanonical)
    if (entry.kind === 'folder') this.root = entry.path
    else this.files.add(entry.path)
    return entry
  }

  authorizes(path: string): boolean {
    return this.files.has(path) || (this.root !== null && isWithin(this.root, path))
  }

  async restoreSession(rootPath: string | null, paths: string[], current: () => boolean) {
    const previousRoot = this.root
    const [root, entries] = await Promise.all([
      rootPath === null ? null : resolveEntry(rootPath, 'folder', true).catch(() => null),
      Promise.all(paths.map((path) => resolveEntry(path, 'file', true).catch(() => null))),
    ])
    if (!current() || this.root !== previousRoot) throw new Error('The workspace changed before it could be resumed.')
    if (root) this.root = root.path
    const restored = new Map<string, Entry>()
    for (const entry of entries) {
      if (!entry) continue
      this.files.add(entry.path)
      restored.set(entry.path, entry)
    }
    return { root, restored }
  }

  async inspect(value: unknown, kind?: EntryKind): Promise<{ path: string; stats: BigIntStats }> {
    const path = absolutePath(value)
    if (!this.authorizes(path)) {
      throw new Error('Open the file or its folder before accessing it.')
    }
    const stats = await getStats(path)
    if ((kind === 'file' && !stats.isFile()) || (kind === 'folder' && !stats.isDirectory())) {
      throw new Error('The selected item is no longer a ' + kind + '.')
    }
    return { path, stats }
  }

  async list(value: unknown): Promise<Entry[]> {
    const { path } = await this.inspect(value, 'folder')
    const entries: Entry[] = []
    const directory = await opendir(path)
    let seen = 0
    for await (const entry of directory) {
      if (++seen > maxDirectoryEntries) {
        throw new Error('This folder has more than 4,000 entries. Open a smaller folder or an individual file.')
      }
      if (entry.isDirectory()) entries.push(toEntry(join(path, entry.name), 'folder'))
      if (entry.isFile() && !/^\.ion-[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
        entries.push(toEntry(join(path, entry.name), 'file'))
      }
    }
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : a.kind === 'folder' ? -1 : 1)
    return entries
  }

  async read(value: unknown, mode?: unknown): Promise<Required<FileContents>> {
    const { path, stats: original } = await this.inspect(value, 'file')
    if (mode !== undefined && (mode !== 'notebook' || !isNotebookName(path))) throw new Error('Open an .ipynb notebook first.')
    const limit = mode === 'notebook' ? maxNotebookBytes : maxFileBytes
    if (limit === maxFileBytes && !isNotebookName(path) && !documentFormat(path) && original.size > BigInt(limit)) {
      throw new Error(`${largeTextError} Only UTF-8 text files up to 2 MiB can be edited. Open a read-only text preview instead.`)
    }
    const { data, stats } = await readStableBytes(path, limit)
    if (data.includes(0)) throw new Error('This file contains binary data.')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
    } catch {
      throw new Error('This file is not valid UTF-8.')
    }
    this.files.add(path)
    return { text, revision: revision(stats), contentHash: contentHash(data) }
  }

  async readTextPage(value: unknown, index: unknown, expected?: unknown): Promise<TextPage> {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= maxTextPreviewBytes / textPageBytes
      || (expected !== undefined && (typeof expected !== 'string' || expected.length > 256))) {
      throw new Error('Invalid text preview page.')
    }
    const { path, stats: original } = await this.inspect(value, 'file')
    if (isNotebookName(path) || documentFormat(path)) throw new Error('Choose a large plain text file.')
    const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock)
    try {
      const opened = await handle.stat({ bigint: true })
      const token = revision(opened)
      if (!opened.isFile() || token !== revision(original) || (expected !== undefined && expected !== token)) {
        throw new Error('The file changed on disk. Restart the preview to see the new version.')
      }
      if (opened.size <= BigInt(maxEditableTextBytes)) throw new Error('The file is now small enough to edit. Close and reopen it.')
      if (opened.size > BigInt(maxTextPreviewBytes)) throw new Error('Text preview supports files up to 128 MiB.')
      const size = Number(opened.size)
      const pages = Math.ceil(size / textPageBytes)
      if (index >= pages) throw new Error('This preview page does not exist.')
      const position = index * textPageBytes
      const bytes = Buffer.allocUnsafe(Math.min(size - position, textPageBytes + 3))
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, position + offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset !== bytes.length || revision(await getStats(path)) !== token) {
        throw new Error('The file changed on disk. Restart the preview to see the new version.')
      }
      // A character split at the page boundary belongs to the previous page.
      const continuation = (byte: number) => (byte & 0xc0) === 0x80
      let start = 0
      let end = Math.min(textPageBytes, bytes.length)
      while (index && start < 3 && continuation(bytes[start])) start++
      while (end < bytes.length && continuation(bytes[end])) end++
      const page = bytes.subarray(start, end)
      if (page.includes(0)) throw new Error('This page contains binary data.')
      try {
        return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(page), pages, revision: token }
      } catch {
        throw new Error('This page is not valid UTF-8 text.')
      }
    } finally {
      await handle.close()
    }
  }

  save(value: unknown, content: unknown, token: unknown, baseHash?: unknown): Promise<Required<FileRevision> & { baseRevision: string }> {
    const limit = typeof value === 'string' && isNotebookName(value) ? maxNotebookBytes : maxFileBytes
    if (limit === maxFileBytes && typeof content === 'string'
      && (content.length > limit || Buffer.byteLength(content) > limit)) {
      throw new Error('This buffer exceeds the 2 MiB editing limit. Use Save As to keep a copy up to 16 MiB, or shorten the buffer.')
    }
    const text = fileText(content, limit)
    if (typeof token !== 'string' || token.length > 256) throw new Error('Invalid file revision.')
    if (baseHash !== undefined && (typeof baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(baseHash))) {
      throw new Error('Invalid file content hash.')
    }
    return this.serialize(async () => {
      let path: string
      let stats: BigIntStats
      try {
        ({ path, stats } = await this.inspect(value, 'file'))
      } catch (error) {
        if (errorCode(error) === 'ENOENT') throw new Error('FILE_CHANGED: This file was moved or removed. Use Save As to keep your edits.')
        throw error
      }
      if (stats.size > BigInt(limit)) {
        if (token === revision(stats)) throw new Error('This large file is read only in Ion.');
        throw new Error('FILE_CHANGED: The file on disk exceeds the editing limit. Use Save As to keep your edits.')
      }
      if (token !== revision(stats)) {
        // A metadata update or identical replacement can change the revision without changing the editor's base text.
        const current = baseHash === undefined ? null : await readStableBytes(path, limit).catch(() => null)
        if (!current || contentHash(current.data) !== baseHash) {
          throw new Error(fileChanged)
        }
        stats = current.stats
      }
      return { revision: await writeAtomically(path, text, stats), contentHash: contentHash(text), baseRevision: revision(stats) }
    })
  }

  saveAs(
    value: string, content: unknown, confirmOverwrite?: (path: string) => Promise<boolean>,
  ): Promise<(Entry & Required<FileRevision>) | null> {
    const selected = absolutePath(value)
    const text = fileText(content, isNotebookName(selected) ? maxNotebookBytes : maxTextCopyBytes)
    return this.serialize(async () => {
      const parent = await realpath(dirname(selected))
      const { path, before } = await saveAsTarget(join(parent, entryName(basename(selected))))
      if (before && !before.isFile()) throw new Error('Choose a regular file as the destination.')
      if (before && (!confirmOverwrite || !await confirmOverwrite(path))) return null
      const updatedRevision = await writeAtomically(path, text, before)
      this.files.add(path)
      return { ...toEntry(path, 'file'), revision: updatedRevision, contentHash: contentHash(text) }
    })
  }

  create(parent: unknown, value: unknown, kind: unknown, initialText?: unknown): Promise<Entry> {
    const name = entryName(value)
    if (kind !== 'file' && kind !== 'folder') throw new Error('Invalid entry type.')
    if (initialText !== undefined && (kind !== 'file' || documentFormat(name) || isNotebookName(name))) {
      throw new Error('Starter text is only supported for editable text files.')
    }
    const text = initialText === undefined ? undefined : fileText(initialText)
    return this.serialize(async () => {
      const { path } = await this.inspect(parent, 'folder')
      const destination = join(path, name)
      if (kind === 'folder') await mkdir(destination)
      else if (text !== undefined) await writeAtomically(destination, text, null)
      else await (await open(destination, 'wx')).close()
      return toEntry(destination, kind)
    })
  }

  rename(value: unknown, nextName: unknown): Promise<Entry> {
    const name = entryName(nextName)
    return this.serialize(async () => {
      const { path, stats } = await this.inspect(value)
      if (path === this.root) throw new Error('Close the workspace before renaming its folder in your file manager.')
      const kind = stats.isFile() ? 'file' : 'folder'
      const destination = join(dirname(path), name)
      if (destination === path) return toEntry(path, kind)
      const caseOnly = windows && relative(path, destination) === ''
      try {
        const target = await lstat(destination, { bigint: true })
        if ((windows && !caseOnly) || target.dev !== stats.dev || target.ino !== stats.ino
          || await realpath(destination) !== path) {
          throw new Error('A file or folder with that name already exists.')
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
      await rename(path, destination)
      if (caseOnly && await realpath(destination) !== destination) {
        throw new Error('Windows kept the original filename case. Rename to a different name first, then rename it again.')
      }
      for (const file of [...this.files]) {
        if (isWithin(path, file)) {
          this.files.delete(file)
          this.files.add(join(destination, relative(path, file)))
        }
      }
      return toEntry(destination, kind)
    })
  }

  trash(value: unknown, confirm: (path: string) => Promise<boolean>, moveToTrash: (path: string) => Promise<void>): Promise<boolean> {
    return this.serialize(async () => {
      const { path, stats } = await this.inspect(value)
      if (path === this.root) {
        throw new Error(windows
          ? 'Close the workspace before moving its folder to the Recycle Bin from File Explorer.'
          : 'Move the workspace folder to Trash from Finder after closing it.')
      }
      if (!await confirm(path)) return false
      const current = await this.inspect(path)
      if (revision(current.stats) !== revision(stats)) throw new Error('The selected item changed while confirming.')
      await moveToTrash(path)
      for (const file of this.files) {
        if (isWithin(path, file)) this.files.delete(file)
      }
      return true
    })
  }
}
