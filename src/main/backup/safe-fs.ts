import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, opendir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { limits, portablePath } from './format'

export function within(root: string, candidate: string) {
  const value = relative(root, candidate)
  return !value || (!isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep))
}
export const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT'
export async function exists(path: string) { try { await lstat(path); return true } catch (e) { if (missing(e)) return false; throw e } }
export function aborted(signal?: AbortSignal) { if (signal?.aborted) throw new Error('Backup operation cancelled. No incomplete backup was published.') }
export async function directory(path: string): Promise<string> {
  const info = await lstat(path)
  const canonical = await realpath(path)
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolve(path)) throw new Error('Use a regular local directory without links.')
  return canonical
}
export async function checkedPath(root: string, name: string): Promise<string> {
  portablePath(name)
  await directory(root)
  const parts = name.split('/'); let path = root
  for (const part of parts.slice(0, -1)) { path = join(path, part); await directory(path) }
  return join(root, ...parts)
}
export async function fingerprint(root: string, name: string, max = limits.fileBytes, signal?: AbortSignal) {
  aborted(signal)
  const path = await checkedPath(root, name), original = await lstat(path, { bigint: true })
  if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1n || original.size > BigInt(max)) throw new Error('Backup source must be a bounded regular file.')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (before.dev !== original.dev || before.ino !== original.ino || !before.isFile()) throw new Error('Backup source changed while opening.')
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024); let bytes = 0
    while (true) {
      aborted(signal)
      const read = await handle.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      bytes += read.bytesRead; if (bytes > max) throw new Error('Backup source exceeds its size limit.')
      hash.update(buffer.subarray(0, read.bytesRead))
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true })
    if (bytes !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || current.dev !== before.dev || current.ino !== before.ino) throw new Error('Backup source changed. Review it again.')
    await checkedPath(root, name)
    return { bytes, sha256: hash.digest('hex'), identity: before.dev + ':' + before.ino + ':' + before.mtimeNs + ':' + before.ctimeNs }
  } finally { await handle.close() }
}
export async function copyChecked(root: string, name: string, target: string, max = limits.fileBytes, signal?: AbortSignal) {
  const expected = await fingerprint(root, name, max, signal)
  const source = await checkedPath(root, name), input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let output
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    output = await open(target, 'wx', 0o600)
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024); let bytes = 0
    while (true) {
      aborted(signal)
      const read = await input.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break
      bytes += read.bytesRead; if (bytes > max) throw new Error('Backup entry exceeds its size limit.')
      hash.update(buffer.subarray(0, read.bytesRead))
      let offset = 0
      while (offset < read.bytesRead) { const written = await output.write(buffer, offset, read.bytesRead - offset); if (!written.bytesWritten) throw new Error('Incomplete backup write.'); offset += written.bytesWritten }
    }
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error('Backup source changed during copying.')
    const after = await fingerprint(root, name, max, signal)
    if (after.identity !== expected.identity || after.sha256 !== expected.sha256) throw new Error('Backup source changed during copying.')
    await output.sync()
    return expected
  } finally { await input.close(); await output?.close() }
}
export async function names(root: string, signal?: AbortSignal): Promise<string[]> {
  if (!await exists(root)) return []
  await directory(root)
  const results: string[] = []; let visited = 0
  async function visit(folder: string, depth: number) {
    if (depth > limits.depth) throw new Error('Backup tree is too deep.')
    const iterator = await opendir(folder)
    for await (const entry of iterator) {
      aborted(signal); if (++visited > limits.visits) throw new Error('Backup tree exceeds its entry limit.')
      const path = join(folder, entry.name), name = relative(root, path).split('\\').join('/')
      portablePath(name)
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Backup store contains a link or special file.')
      if (entry.isDirectory()) { await directory(path); await visit(path, depth + 1) }
      else { results.push(name); if (results.length > limits.files) throw new Error('Backup has too many files.') }
    }
  }
  await visit(root, 0)
  return results.sort()
}
export async function clean(path: string) { await rm(path, { recursive: true, force: true }) }

export async function readBounded(root: string, name: string, max: number): Promise<Buffer> {
  const checked = await fingerprint(root, name, max)
  const handle = await open(await checkedPath(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const bytes = Buffer.allocUnsafe(checked.bytes + 1); let offset = 0
    while (offset < bytes.length) { const r = await handle.read(bytes, offset, bytes.length - offset, null); if (!r.bytesRead) break; offset += r.bytesRead }
    const result = bytes.subarray(0, offset)
    if (offset !== checked.bytes || createHash('sha256').update(result).digest('hex') !== checked.sha256) throw new Error('Backup data changed while reading.')
    return result
  } finally { await handle.close() }
}
export async function readValue(root: string, name: string, max: number): Promise<unknown> {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(root, name, max)))
}
