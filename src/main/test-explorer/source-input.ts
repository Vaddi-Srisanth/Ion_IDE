import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { revision } from '../files'

// Windows files may share timestamps across successive same-size writes.
// Bind review to bytes as well as identity; hashing alone doesn't bind the path.
export async function inspectTestInput(path: string, limit: number, expectedRevision?: string,
  signal?: AbortSignal, capture = false) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    const identity = revision(before)
    if (!before.isFile() || before.size > BigInt(limit) || (expectedRevision && expectedRevision !== identity)
      || await realpath(path) !== path) throw new Error('Test input changed or exceeded its review limit.')
    const size = Number(before.size)
    const bytes = capture ? Buffer.allocUnsafe(size) : undefined
    const chunk = Buffer.allocUnsafe(Math.min(size + 1, 64 * 1024))
    const hash = createHash('sha256')
    let offset = 0
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      if (offset + bytesRead > size) throw new Error('Test input changed while reading.')
      hash.update(chunk.subarray(0, bytesRead))
      bytes?.set(chunk.subarray(0, bytesRead), offset)
      offset += bytesRead
    }
    if (offset !== size || identity !== revision(await handle.stat({ bigint: true }))
      || await realpath(path) !== path || identity !== revision(await lstat(path, { bigint: true }))) {
      throw new Error('Test input changed while reading.')
    }
    const digest = hash.digest('hex')
    return { bytes, digest, token: identity + ':' + digest }
  } finally { await handle.close() }
}
