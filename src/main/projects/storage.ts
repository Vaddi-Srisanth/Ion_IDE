import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJson(path: string, maxBytes: number): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stats = await file.stat()
      if (!stats.isFile() || stats.size > maxBytes) throw new Error('Stored data exceeds its size limit.')
      const buffer = Buffer.alloc(stats.size + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
        if (!bytesRead) break
        size += bytesRead
      }
      if (size !== stats.size) throw new Error('Stored data changed while reading.')
      return JSON.parse(buffer.toString('utf8', 0, size)) as unknown
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Unable to read stored project data. Existing files have been left in place.', { cause: error })
  }
}

export async function writeJson(path: string, value: unknown, maxBytes: number): Promise<void> {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > maxBytes) throw new Error('Stored project data exceeds its size limit.')
  const temporary = path + '.' + randomUUID() + '.tmp'
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
