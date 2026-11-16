import { randomUUID, createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { Transform, Readable } from 'node:stream'
import * as yauzl from 'yauzl'
import { ZipFile } from 'yazl'
import { limits, parseManifest, portablePath, type BackupManifest } from './format'
import { aborted, clean, directory, fingerprint } from './safe-fs'

export async function syncDirectory(path: string) {
  // Windows does not expose directory fsync through Node. File publications and
  // journal files are flushed; volume-wide atomicity is deliberately not claimed.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() }
}
export async function writeArchive(stage: string, manifest: BackupManifest, destination: string, signal?: AbortSignal, beforePublish: () => Promise<void> = async () => {}) {
  parseManifest(manifest)
  const parent = await directory(await realpath(dirname(destination))), name = basename(destination)
  destination = join(parent, name)
  const temporary = join(parent, '.ion-backup-' + randomUUID() + '.tmp')
  const zip = new ZipFile(); let total = 0, owned = false
  const inputs = new Set<import('node:stream').Readable>()
  const cap = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    total += chunk.length; callback(total > limits.bytes ? new Error('Archive exceeds 2 GiB.') : null, chunk)
  } })
  zip.on('error', e => zip.outputStream.destroy(e))
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  if (manifestBytes.length > limits.manifestBytes || manifest.entries.reduce((n, e) => n + e.bytes, manifestBytes.length) > limits.bytes) throw new Error('Backup exceeds its manifest or expanded-size limit.')
  zip.addBuffer(manifestBytes, 'manifest.json', { mode: 0o100600, compressionLevel: 1 })
  for (const entry of manifest.entries) {
    zip.addReadStreamLazy(entry.path, { size: entry.bytes, mode: 0o100600, compressionLevel: 1 }, callback => {
      void fingerprint(stage, entry.path, limits.fileBytes, signal).then(async value => {
        if (value.bytes !== entry.bytes || value.sha256 !== entry.sha256) throw new Error('Staged backup changed.')
        const input = await open(join(stage, ...entry.path.split('/')), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const stream = input.createReadStream(); inputs.add(stream)
        stream.once('close', () => inputs.delete(stream))
        if (signal?.aborted) { stream.destroy(); callback(new Error('Backup operation cancelled.')); return }
        callback(null, stream)
      }).catch(error => callback(error instanceof Error ? error : new Error('Unable to read staged backup.')))
    })
  }
  try {
    aborted(signal)
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 }); output.once('open', () => { owned = true })
    zip.end()
    await pipeline(zip.outputStream, cap, output, { signal })
    const handle = await open(temporary, 'r+'); try { await handle.sync() } finally { await handle.close() }
    aborted(signal); await beforePublish(); await directory(parent)
    // link is an exclusive publication: EEXIST leaves an existing backup intact.
    await link(temporary, destination)
    await syncDirectory(parent)
  } finally {
    zip.outputStream.destroy(); cap.destroy()
    await Promise.all([...inputs].map(async input => { input.destroy(); await finished(input, { cleanup: true }).catch(() => {}) }))
    if (owned) await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e })
  }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crcUpdate(crc: number, data: Buffer) { for (const value of data) crc = crcTable[(crc ^ value) & 255]! ^ (crc >>> 8); return crc }

// No archive filename is ever used until it has passed portable-path checks.
// Staging must be private and empty; callers own its lifetime.
export async function readArchive(source: string, stage: string, signal?: AbortSignal): Promise<BackupManifest> {
  await directory(stage)
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits.bytes) throw new Error('Choose a regular .ionbackup archive up to 2 GiB.')
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let zip: yauzl.ZipFile | undefined
  try {
    const opened = await handle.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error('Archive changed while opening.')
    class OwnedReader extends yauzl.RandomAccessReader {
      _readStreamForRange(start: number, end: number) {
        let position = start
        return new Readable({ highWaterMark: 64 * 1024, read() {
          if (position >= end) { this.push(null); return }
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position))
          void handle.read(buffer, 0, buffer.length, position).then(({ bytesRead }) => {
            if (!bytesRead) throw new Error('Truncated archive range.')
            position += bytesRead; if (!this.destroyed) this.push(buffer.subarray(0, bytesRead))
          }).catch(error => this.destroy(error))
        } })
      }
      close(callback: (error: Error | null) => void) { callback(null) }
    }
    zip = await new Promise<yauzl.ZipFile>((yes, no) => yauzl.fromRandomAccessReader(new OwnedReader(), info.size,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, file) => error ? no(error) : yes(file!)))
    if (zip.entryCount > limits.files + 1) throw new Error('Archive has too many entries.')
    let manifest: BackupManifest | undefined, count = 0, expanded = 0
    const seen = new Set<string>(), ancestors = new Set<string>()
    let expectedEntries: Map<string, BackupManifest['entries'][number]> | undefined
    const next = () => new Promise<yauzl.Entry | null>((yes, no) => {
      const onEntry = (entry: yauzl.Entry) => { off(); yes(entry) }, onEnd = () => { off(); yes(null) }, onError = (e: Error) => { off(); no(e) }
      const off = () => { zip!.off('entry', onEntry); zip!.off('end', onEnd); zip!.off('error', onError); signal?.removeEventListener('abort', onAbort) }
      const onAbort = () => { off(); no(new Error('Backup operation cancelled.')) }
      zip!.once('entry', onEntry); zip!.once('end', onEnd); zip!.once('error', onError); signal?.addEventListener('abort', onAbort, { once: true }); zip!.readEntry()
    })
    // Retain an error handler between entries as yauzl may report a reader error asynchronously.
    let readerError: Error | undefined
    zip.on('error', error => { readerError = error })
    for (;;) {
      aborted(signal); if (readerError) throw readerError
      const entry = await next(); if (!entry) break
      const name = portablePath(entry.fileName), folded = name.toLowerCase(), mode = entry.externalFileAttributes >>> 16
      if (seen.has(folded) || ancestors.has(folded) || folded.split('/').slice(0, -1).some((_, i, a) => seen.has(a.slice(0, i + 1).join('/')))
        || (mode && (mode & 0o170000) !== 0o100000) || entry.externalFileAttributes & 0x10 || entry.generalPurposeBitFlag & 1
        || ![0, 8].includes(entry.compressionMethod) || name.endsWith('/')) throw new Error('Unsafe, duplicate or unsupported archive entry.')
      seen.add(folded); const components = folded.split('/'); for (let n = 1; n < components.length; n++) ancestors.add(components.slice(0, n).join('/'))
      if (++count > limits.files + 1) throw new Error('Archive has too many entries.')
      const max = name === 'manifest.json' ? limits.manifestBytes : limits.fileBytes
      if (entry.uncompressedSize > max || (expanded += entry.uncompressedSize) > limits.bytes) throw new Error('Archive expands beyond its size limit.')
      // Check the local header too: central-directory-only validation is insufficient.
      const local = Buffer.alloc(30)
      if ((await handle.read(local, 0, 30, entry.relativeOffsetOfLocalHeader)).bytesRead !== 30 || local.readUInt32LE(0) !== 0x04034b50
        || local.readUInt16LE(6) !== entry.generalPurposeBitFlag || local.readUInt16LE(8) !== entry.compressionMethod) throw new Error('Malformed ZIP local header.')
      const localName = Buffer.alloc(local.readUInt16LE(26))
      if (!localName.length || localName.length > limits.pathBytes
        || (await handle.read(localName, 0, localName.length, entry.relativeOffsetOfLocalHeader + 30)).bytesRead !== localName.length
        || new TextDecoder('utf-8', { fatal: true }).decode(localName) !== name) throw new Error('ZIP headers disagree on the entry path.')
      if (!(entry.generalPurposeBitFlag & 8) && (local.readUInt32LE(14) !== entry.crc32 || local.readUInt32LE(18) !== entry.compressedSize || local.readUInt32LE(22) !== entry.uncompressedSize)) throw new Error('ZIP local sizes or checksum disagree.')
      const start = entry.relativeOffsetOfLocalHeader + 30 + localName.length + local.readUInt16LE(28)
      if (start + entry.compressedSize > info.size) throw new Error('Truncated archive payload.')
      if (!manifest && name !== 'manifest.json') throw new Error('Ion backup manifest must be the first entry.')
      const expected = expectedEntries?.get(name)
      if (manifest && (!expected || expected.bytes !== entry.uncompressedSize)) throw new Error('Archive payload is outside its manifest.')
      const stream = await new Promise<NodeJS.ReadableStream>((yes, no) => zip!.openReadStream(entry, (error, stream) => error ? no(error) : yes(stream!)))
      const hash = createHash('sha256'); let bytes = 0, crc = 0xffffffff
      const chunks: Buffer[] = []
      let output: Awaited<ReturnType<typeof open>> | undefined
      try {
        if (manifest) {
          const target = join(stage, ...name.split('/')); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); output = await open(target, 'wx', 0o600)
        }
        const abort = () => (stream as import('node:stream').Readable).destroy(new Error('Backup operation cancelled.'))
        signal?.addEventListener('abort', abort, { once: true })
        try {
          for await (const chunk of stream as import('node:stream').Readable) {
            aborted(signal); const data = chunk as Buffer; bytes += data.length
            if (bytes > max || bytes > entry.uncompressedSize) throw new Error('Archive payload exceeded its declared size.')
            hash.update(data); crc = crcUpdate(crc, data)
            if (output) await output.writeFile(data); else chunks.push(data)
          }
        } finally { signal?.removeEventListener('abort', abort) }
        if (bytes !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error('Archive checksum or size is invalid.')
        if (!manifest) {
          manifest = parseManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
          expectedEntries = new Map(manifest.entries.map(e => [e.path, e]))
        }
        else if (hash.digest('hex') !== expected!.sha256) throw new Error('Archive SHA-256 checksum is invalid.')
        await output?.sync()
      } finally { (stream as import('node:stream').Readable).destroy(); await output?.close() }
    }
    if (!manifest || count !== manifest.entries.length + 1 || manifest.entries.some(e => !seen.has(e.path.toLowerCase()))) throw new Error('Archive is incomplete.')
    const current = await handle.stat()
    if (current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs) throw new Error('Archive changed during validation.')
    return manifest
  } catch (e) { await clean(stage); await mkdir(stage, { mode: 0o700 }); throw e }
  finally { zip?.close(); await handle.close() }
}
