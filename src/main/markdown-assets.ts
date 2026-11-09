import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import type { Entry, MarkdownImage } from '../shared/contracts'
import { isMarkdownFile } from '../shared/markdown-path'
import { isWithin, revision, type WorkspaceFiles } from './files'

const maxHrefLength = 4096
const maxImageBytes = 5 * 1024 * 1024
const maxImagePixels = 8_000_000
const invalidHref = /[\\\x00-\x1f\x7f-\x9f]/
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const imageMimes = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
])

function linkText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxHrefLength || invalidHref.test(value)) {
    throw new Error('Invalid Markdown link.')
  }
  return value.trim()
}

function markdownSource(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isMarkdownFile(value)) {
    throw new Error('Open a Markdown file before accessing its links or images.')
  }
  return value
}

async function localFile(scope: WorkspaceFiles, sourcePath: unknown, href: string) {
  const root = scope.rootPath
  const source = markdownSource(sourcePath)
  if (!root || !isAbsolute(source) || !isWithin(root, source)) {
    throw new Error('Open the Markdown file inside a workspace folder to access its local links or images.')
  }
  const relativePath = decodeURIComponent(href.split(/[?#]/, 1)[0])
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes(':') || invalidHref.test(relativePath)) {
    throw new Error('Use a relative link or image path inside the workspace.')
  }
  const path = resolve(dirname(source), relativePath)
  if (path === root || !isWithin(root, path)) throw new Error('The Markdown link or image is outside the workspace.')
  await scope.inspect(source, 'file')
  if (scope.rootPath !== root) throw new Error('The workspace changed while resolving the Markdown link or image.')
  const file = await scope.inspect(path, 'file')
  if (scope.rootPath !== root) throw new Error('The workspace changed while resolving the Markdown link or image.')
  return { ...file, root }
}

function jpegSize(bytes: Buffer): [number, number] | undefined {
  if (bytes.readUInt16BE(0) !== 0xffd8) return
  let offset = 2
  while (offset < bytes.length && bytes[offset] === 0xff) {
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9) return
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue
    if (offset + 2 > bytes.length) return
    const size = bytes.readUInt16BE(offset)
    if (size < 2 || offset + size > bytes.length) return
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && size >= 8) {
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]
    }
    offset += size
  }
}

function webpSize(bytes: Buffer): [number, number] | undefined {
  if (bytes.length < 25 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP') return
  const chunk = bytes.toString('ascii', 12, 16)
  const size = bytes.readUInt32LE(16)
  if (bytes.readUInt32LE(4) !== bytes.length - 8 || size > bytes.length - 20) return
  if (chunk === 'VP8X' && size === 10) return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1]
  if (chunk === 'VP8L' && size >= 5 && bytes[20] === 0x2f) {
    const dimensions = bytes.readUInt32LE(21)
    return [(dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1]
  }
  if (chunk === 'VP8 ' && size >= 10 && bytes.readUIntBE(23, 3) === 0x9d012a) {
    return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
  }
}

function imageSize(bytes: Buffer, mime: string): [number, number] | undefined {
  switch (mime) {
    case 'image/png':
      if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature) && bytes.readUInt32BE(8) === 13
        && bytes.toString('ascii', 12, 16) === 'IHDR') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
      return
    case 'image/jpeg': return jpegSize(bytes)
    case 'image/gif':
      if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
        return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)]
      }
      return
    case 'image/webp': return webpSize(bytes)
    case 'image/bmp': {
      if (bytes.length < 26 || bytes.readUInt16BE(0) !== 0x424d || bytes.readUInt32LE(10) >= bytes.length) return
      const headerSize = bytes.readUInt32LE(14)
      if (headerSize === 12) return [bytes.readUInt16LE(18), bytes.readUInt16LE(20)]
      if (headerSize >= 40 && headerSize <= bytes.length - 14) {
        return [bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22))]
      }
    }
  }
}

export async function readMarkdownImage(scope: WorkspaceFiles, sourcePath: unknown, value: unknown): Promise<MarkdownImage> {
  const { root, path, stats } = await localFile(scope, sourcePath, linkText(value))
  const mime = imageMimes.get(extname(path).toLowerCase())
  if (!mime) throw new Error('Only PNG, JPEG, GIF, WebP, and BMP images are supported in Markdown previews.')
  if (stats.size < 2n || stats.size > BigInt(maxImageBytes)) throw new Error('Markdown preview images must be at most 5 MiB.')

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    const token = revision(stats)
    if (!opened.isFile() || revision(opened) !== token) throw new Error('The Markdown image changed while opening.')
    const data = new Uint8Array(Number(opened.size))
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (!bytesRead) throw new Error('The Markdown image changed while opening.')
      offset += bytesRead
    }
    const current = await scope.inspect(path, 'file')
    if (scope.rootPath !== root || revision(current.stats) !== token) {
      throw new Error('The Markdown image or workspace changed while opening.')
    }
    const dimensions = imageSize(Buffer.from(data.buffer), mime)
    if (!dimensions) throw new Error('The Markdown image format does not match its file extension.')
    const [width, height] = dimensions
    if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > maxImagePixels) {
      throw new Error('The Markdown image exceeds the preview dimension limit.')
    }
    return { bytes: data.buffer, mime }
  } finally {
    await handle.close()
  }
}

export async function resolveMarkdownLink(scope: WorkspaceFiles, sourcePath: unknown, value: unknown):
  Promise<{ kind: 'external'; href: string } | { kind: 'file'; entry: Entry }> {
  const href = linkText(value)
  if (/^https?:\/\//i.test(href)) {
    const url = new URL(href)
    if (!url.hostname || url.username || url.password) throw new Error('Invalid Markdown link.')
    if (sourcePath !== null) await scope.inspect(markdownSource(sourcePath), 'file')
    return { kind: 'external', href: url.href }
  }
  const { path } = await localFile(scope, sourcePath, href)
  return { kind: 'file', entry: { kind: 'file', path, name: basename(path) } }
}
