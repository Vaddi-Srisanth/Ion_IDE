import { constants } from 'node:fs'
import { open, opendir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

interface EntryClass {
  name: string
  source?: string
  launchable: boolean
}

// Read only the JVM metadata needed to identify an entry point. This avoids
// running a class loader or loading every Java file in the workspace.
function classMetadata(bytes: Buffer): EntryClass | null {
  let offset = 0
  function u2() {
    const value = bytes.readUInt16BE(offset)
    offset += 2
    return value
  }
  function u4() {
    const value = bytes.readUInt32BE(offset)
    offset += 4
    return value
  }
  function attributes(visit?: (name: string | undefined, size: number) => void) {
    const count = u2()
    for (let index = 0; index < count; index++) {
      const name = utf8.get(u2())
      const size = u4()
      if (offset + size > bytes.length) throw new Error('Invalid class attribute')
      visit?.(name, size)
      offset += size
    }
  }

  const utf8 = new Map<number, string>()
  const classes = new Map<number, number>()
  if (u4() !== 0xcafebabe) return null
  u2() // minor
  const major = u2()
  const constants = u2()
  for (let index = 1; index < constants; index++) {
    const tag = bytes[offset++]
    switch (tag) {
      case 1: {
        const size = u2()
        // Package and class identifiers normally use the same bytes as UTF-8.
        // Supplementary characters use CESU-8 surrogate pairs in class files.
        let text = ''
        let previous = offset
        const end = offset + size
        for (let cursor = offset; cursor + 2 < end; cursor++) {
          if (bytes[cursor] === 0xed && (bytes[cursor + 1] & 0xe0) === 0xa0) {
            const codeUnit = (bytes[cursor] & 15) << 12 | (bytes[cursor + 1] & 63) << 6 | bytes[cursor + 2] & 63
            text += bytes.toString('utf8', previous, cursor) + String.fromCharCode(codeUnit)
            cursor += 2
            previous = cursor + 1
          }
        }
        utf8.set(index, text + bytes.toString('utf8', previous, end))
        offset = end
        break
      }
      case 7: classes.set(index, u2()); break
      case 8: case 16: case 19: case 20: offset += 2; break
      case 15: offset += 3; break
      case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18: offset += 4; break
      case 5: case 6: offset += 8; index++; break
      default: return null
    }
  }
  u2() // class access flags
  const className = utf8.get(classes.get(u2()) ?? 0)?.replaceAll('/', '.')
  u2() // superclass
  const interfaces = u2()
  offset += interfaces * 2
  const fields = u2()
  for (let index = 0; index < fields; index++) {
    offset += 6
    attributes()
  }
  let launchable = false
  const methods = u2()
  for (let index = 0; index < methods; index++) {
    const flags = u2()
    const name = utf8.get(u2())
    const descriptor = utf8.get(u2())
    if (name === 'main') {
      const classic = (flags & 9) === 9 && descriptor === '([Ljava/lang/String;)V'
      const modern = major >= 69 && (flags & (2 | 0x400)) === 0
        && (descriptor === '([Ljava/lang/String;)V' || descriptor === '()V')
      launchable ||= classic || modern
    }
    attributes()
  }
  let source: string | undefined
  attributes((name, size) => {
    if (name === 'SourceFile' && size === 2) source = utf8.get(bytes.readUInt16BE(offset))
  })
  return className && /^(?:[$_\p{ID_Start}][$\p{ID_Continue}]*\.)*[$_\p{ID_Start}][$\p{ID_Continue}]*$/u.test(className)
    ? { name: className, source, launchable } : null
}

const classSizeLimit = 2 * 1024 * 1024

async function readClass(path: string, minimumTime: number, budget: { remaining: number }) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') return null
      throw error
    })
  if (!handle) return null
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > classSizeLimit || stat.mtimeMs + 1 < minimumTime) return null
    if (stat.size > budget.remaining) throw new Error('Too much compiled data to find a Java entry point. Run a smaller source package.')
    budget.remaining -= stat.size
    const bytes = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) return null
      offset += bytesRead
    }
    return classMetadata(bytes)
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  } finally {
    await handle.close()
  }
}

export async function findMainClass(
  source: string, packageName: string, classDirectories: readonly string[], signal: AbortSignal,
  verifyFresh = false,
): Promise<string> {
  const filename = basename(source)
  const wanted = (packageName ? packageName + '.' : '') + basename(filename, '.java')
  const sourceTime = verifyFresh ? (await stat(source)).mtimeMs : 0
  const candidates = new Set<string>()
  const budget = { remaining: 32 * 1024 * 1024 }
  let visited = 0
  for (const directory of classDirectories) {
    signal.throwIfAborted()
    const packagePath = join(directory, ...packageName.split('.').filter(Boolean))
    const named = await readClass(join(packagePath, basename(filename, '.java') + '.class'), sourceTime, budget)
    if (named?.name === wanted && named.launchable && (named.source === filename || !named.source)) return wanted
    const entries = await opendir(packagePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    })
    if (!entries) continue
    for await (const entry of entries) {
      signal.throwIfAborted()
      if (++visited > 4096) throw new Error('Too many compiled classes to find a Java entry point. Run a smaller source package.')
      if (!entry.isFile() || !entry.name.endsWith('.class')) continue
      const metadata = await readClass(join(packagePath, entry.name), sourceTime, budget)
      if (metadata?.source !== filename || !metadata.launchable) continue
      if (metadata.name.slice(0, Math.max(0, metadata.name.lastIndexOf('.'))) === packageName) candidates.add(metadata.name)
    }
  }
  if (candidates.size === 1) return candidates.values().next().value!
  if (candidates.size > 1) throw new Error('More than one class in this file has a main method. Open a file with one entry point.')
  throw new Error('No launchable main method was found in this Java file. Open the class containing main.')
}
