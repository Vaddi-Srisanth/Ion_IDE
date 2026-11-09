import { fromBufferPromise, openPromise, type Entry, type ZipFile } from 'yauzl'

const maxEntries = 4096
const maxExpandedBytes = 192 * 1024 * 1024
const maxEntryBytes = 64 * 1024 * 1024

export interface DocumentZip {
  names: ReadonlySet<string>
  has(name: string): boolean
  read(name: string, limit: number): Promise<Buffer>
  verifyLocalHeaders(): Promise<void>
  close(): void
}

const options = { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true }

export async function openZip(path: string): Promise<DocumentZip> {
  return indexZip(await openPromise(path, options), maxExpandedBytes)
}

export async function openZipBuffer(bytes: Buffer, limit: number): Promise<DocumentZip> {
  return indexZip(await fromBufferPromise(bytes, options), limit)
}

async function indexZip(zip: ZipFile, expandedLimit: number): Promise<DocumentZip> {
  const entries = new Map<string, Entry>()
  const foldedNames = new Set<string>()
  let expandedBytes = 0
  try {
    if (zip.entryCount > maxEntries) throw new Error('This Office archive has too many entries.')
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName
      const folded = name.toLowerCase()
      if (name.length > 512 || name.includes('\0') || foldedNames.has(folded) || !entry.canDecodeFileData()) {
        throw new Error('The Office archive contains an invalid, duplicate, or encrypted entry.')
      }
      foldedNames.add(folded)
      expandedBytes += entry.uncompressedSize
      if (entry.uncompressedSize > maxEntryBytes || expandedBytes > expandedLimit) {
        throw new Error('The expanded Office archive exceeds the preview limit.')
      }
      if (!name.endsWith('/')) entries.set(name, entry)
    }
  } catch (error) {
    zip.close()
    throw error
  }

  return {
    names: new Set(entries.keys()),
    has: (name) => entries.has(name),
    async read(name, limit) {
      const entry = entries.get(name)
      if (!entry) throw new Error('A required part of the Office document is missing.')
      if (entry.uncompressedSize > limit) throw new Error('An Office document part exceeds the preview limit.')
      const bytes = Buffer.allocUnsafe(entry.uncompressedSize)
      const stream = await zip.openReadStreamPromise(entry)
      let position = 0
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (position + chunk.length > bytes.length) throw new Error('The Office archive entry has an invalid size.')
        chunk.copy(bytes, position)
        position += chunk.length
      }
      if (position !== bytes.length) throw new Error('The Office archive entry ended unexpectedly.')
      return bytes
    },
    async verifyLocalHeaders() {
      for (const entry of entries.values()) {
        const header = await zip.readLocalFileHeaderPromise(entry)
        if (!header.fileName.equals(entry.fileNameRaw) || header.compressionMethod !== entry.compressionMethod
          || header.generalPurposeBitFlag !== entry.generalPurposeBitFlag) {
          throw new Error('The Office archive headers disagree.')
        }
      }
    },
    close: () => zip.close(),
  }
}
