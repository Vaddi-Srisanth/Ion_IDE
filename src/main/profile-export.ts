import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, opendir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isCustomThemeId } from '../shared/themes'
import { isWithin } from './files'
import type { PreferenceStore } from './preferences'
import {
  learningLibraryDirectory, learningLibraryRegistry, maxLearningLibraryBytes, maxLearningPackBytes, parseInstalledLibrary,
} from './learning/catalog-store'

const KiB = 1024
const exportLimit = 64 * KiB * KiB
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const projectName = /^[0-9a-f]{64}\.json$/

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function readStoredFile(path: string, limit: number): Promise<Buffer | null> {
  const handle = await open(path, readFlags).catch((error: unknown) => {
    if (missing(error)) return null
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
      throw new Error('A local profile file uses a symbolic link.')
    }
    throw error
  })
  if (!handle) return null
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(limit)) throw new Error('A local profile file is invalid or too large.')
    const bytes = Buffer.allocUnsafe(Number(before.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (offset !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error('Local profile data changed during export. Try again.')
    }
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

export async function exportLocalProfile(userData: string, destination: string, preferences: PreferenceStore): Promise<string> {
  const source = await realpath(userData)
  const parent = await realpath(destination)
  if (isWithin(source, parent)) throw new Error('Choose an export folder outside the active Ion IDE profile.')

  // mkdtemp reserves a new private parent. Publish a complete Profile folder
  // inside it with a same-volume rename, without replacing any existing data.
  const exportedAt = new Date().toISOString()
  const output = await mkdtemp(join(parent, `Ion IDE Backup ${exportedAt.slice(0, 10)} `))
  const stage = join(output, '.profile.tmp')
  const exported = join(output, 'Profile')
  let bytesWritten = 0

  async function store(relative: string, content: string | Buffer) {
    bytesWritten += Buffer.byteLength(content)
    if (bytesWritten > exportLimit) throw new Error('Local profile exports support up to 64 MiB of data.')
    const target = join(stage, relative)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, content, { flag: 'wx', mode: 0o600 })
  }

  async function copy(relative: string, limit: number) {
    const path = join(source, relative)
    // The leaf is opened without following links. Check its parent separately
    // so a profile store symlink cannot pull arbitrary files into the export.
    const folder = dirname(path)
    if (await realpath(folder) !== folder) throw new Error('A local profile store uses a symbolic link.')
    const content = await readStoredFile(path, limit)
    if (content === null) return false
    await store(relative, content)
    return true
  }

  async function copyStore(
    name: string, matches: (entry: string) => boolean, countLimit: number, fileLimit: number,
  ) {
    const directory = join(source, name)
    const canonical = await realpath(directory).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    })
    if (canonical === null) return 0
    if (canonical !== directory) throw new Error('A local profile store uses a symbolic link.')
    let copied = 0
    let inspected = 0
    for await (const entry of await opendir(directory)) {
      if (++inspected > 8192) throw new Error('A local profile store contains too many files to export.')
      if (!matches(entry.name)) continue
      if (copied >= countLimit) throw new Error('A local profile store contains too many records to export.')
      if (await copy(join(name, entry.name), fileLimit)) copied++
    }
    return copied
  }

  try {
    await store('preferences.json', JSON.stringify(await preferences.exportSnapshot()) + '\n')
    const learning = await copy('learning.json', 512 * KiB)
    const libraryFolder = join(source, learningLibraryDirectory)
    const libraryPath = await realpath(libraryFolder).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    })
    if (libraryPath !== null && libraryPath !== libraryFolder) throw new Error('The learning library uses a symbolic link.')
    const libraryFile = join(learningLibraryDirectory, learningLibraryRegistry)
    const library = libraryPath && await readStoredFile(join(source, libraryFile), maxLearningLibraryBytes)
    let learningPacks = 0
    if (library) {
      const { installed } = parseInstalledLibrary(library.toString('utf8'))
      for (const { id } of installed) {
        if (!await copy(join(learningLibraryDirectory, id + '.json'), maxLearningPackBytes)) {
          throw new Error('Installed learning packs changed during export. Try again.')
        }
        learningPacks++
      }
      const current = await readStoredFile(join(source, libraryFile), maxLearningLibraryBytes)
      if (!current?.equals(library)) throw new Error('The learning library changed during export. Try again.')
      await store(libraryFile, library)
    }
    const projects = await copyStore('projects-v1', (name) => projectName.test(name), 512, 320 * KiB)
    const themeFolder = await realpath(join(source, 'themes')).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    })
    const registry = themeFolder !== null && await copy(join('themes', 'registry.json'), 512 * KiB)
    const themes = registry ? await copyStore('themes', (name) =>
      name.endsWith('.json') && isCustomThemeId(name.slice(0, -5)), 1000, 8 * KiB) : 0
    await store('ion-profile-backup.json', JSON.stringify({
      format: 'ion-local-profile', version: 1, exportedAt,
      preferences: true, learning, learningPacks, projects, themes,
    }, null, 2) + '\n')
    if (await realpath(output) !== output) throw new Error('The selected export folder changed.')
    await rename(stage, exported)
    return exported
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    await rmdir(output).catch(() => undefined)
    throw error
  }
}
