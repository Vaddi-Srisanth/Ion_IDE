import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

async function transfer(source: FileHandle, target: FileHandle, signal: AbortSignal): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let total = 0
  for (;;) {
    signal.throwIfAborted()
    const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
    if (!bytesRead) return
    total += bytesRead
    if (total > 32 * 1024 * 1024) throw new Error('This Git index exceeds the safe staging limit.')
    let offset = 0
    while (offset < bytesRead) {
      const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, null)
      if (!bytesWritten) throw new Error('Git index publication made no progress.')
      offset += bytesWritten
    }
  }
}

async function preserveIndexTimestamp(target: FileHandle, source: { atimeNs: bigint; mtimeNs: bigint }): Promise<void> {
  // Git uses the index timestamp to distrust stat-cache entries written in the
  // same filesystem clock tick. A fresh copy timestamp can make changed bytes
  // look clean. Round down rather than forward across a racy boundary when
  // converting Node's nanoseconds to utimes' floating-point seconds.
  await target.utimes(Number(source.atimeNs / 1_000_000_000n), Number(source.mtimeNs / 1_000_000_000n))
}

/** Git owns only the private index. Ion owns and publishes the real index lock,
 * so even a force-killed Git/filter process cannot strand that real lock. */
export async function withIndexTransaction<T>(directory: string, signal: AbortSignal,
  run: (indexFile: string) => Promise<T>): Promise<T> {
  const index = join(directory, 'index')
  const lockPath = index + '.lock'
  const privateIndex = join(directory, '.ion-index-' + randomUUID())
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0), 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error('Another Git operation holds the index lock. Wait for it to finish.')
      throw error
    })
  let owned
  try {
    owned = await lock.stat({ bigint: true })
    signal.throwIfAborted()
    const original = await open(index, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    let previous
    if (original) {
      try {
        previous = await original.stat({ bigint: true })
        if (!previous.isFile() || previous.size > 32n * 1024n * 1024n) throw new Error('This Git index exceeds the safe staging limit.')
        const copy = await open(privateIndex, 'wx', 0o600)
        try {
          await transfer(original, copy, signal)
          await preserveIndexTimestamp(copy, previous)
        } finally { await copy.close() }
      } finally { await original.close() }
    }
    const result = await run(privateIndex)
    signal.throwIfAborted()
    const current = await lstat(index, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (Boolean(previous) !== Boolean(current) || previous && current
      && (previous.dev !== current.dev || previous.ino !== current.ino || previous.size !== current.size
        || previous.mtimeNs !== current.mtimeNs || previous.ctimeNs !== current.ctimeNs)) {
      throw new Error('The Git index changed outside its lock. Refresh before staging again.')
    }
    const staged = await open(privateIndex, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let stagedMode
    try {
      const stats = await staged.stat({ bigint: true })
      if (!stats.isFile() || stats.size > 32n * 1024n * 1024n) throw new Error('This Git index exceeds the safe staging limit.')
      stagedMode = Number(stats.mode & 0o777n)
      await transfer(staged, lock, signal)
      await preserveIndexTimestamp(lock, stats)
    } finally { await staged.close() }
    await lock.chmod(stagedMode)
    await lock.sync()
    signal.throwIfAborted()
    const beforePublish = await lstat(lockPath, { bigint: true })
    if (beforePublish.dev !== owned.dev || beforePublish.ino !== owned.ino) {
      throw new Error('The Git index lock changed. Refresh before staging again.')
    }
    await lock.close()
    await rename(lockPath, index)
    return result
  } finally {
    await lock.close().catch(() => {})
    const remaining = await lstat(lockPath, { bigint: true }).catch(() => undefined)
    if (owned && remaining?.dev === owned.dev && remaining.ino === owned.ino) await rm(lockPath)
    await rm(privateIndex + '.lock', { force: true })
    await rm(privateIndex, { force: true })
  }
}
