import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackLesson, PackLibrary, PackSummary, PackTopic } from '../../shared/learning-packs'

export const learningLibraryDirectory = 'learning-library'
export const learningLibraryRegistry = 'library.json'
export const maxLearningPackBytes = 256 * 1024
export const maxLearningLibraryBytes = 96 * 1024
const maxPacks = 64
const maxLessons = 64
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const summaryKeys = ['id', 'name', 'summary', 'version', 'topicCount'] as const

interface PackDefinition extends Omit<PackSummary, 'topicCount'> {
  schema: 1
  lessons: PackLesson[]
}

interface Registry {
  schema: 1
  selected: string | null
  installed: PackSummary[]
}

function errorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function hasKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && value === value.trim() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function isPackId(value: unknown): value is string {
  return isId(value) && !/^(?:index|library|aux|con|nul|prn|com[0-9]|lpt[0-9])$/.test(value)
}

function text(value: unknown, limit: number, multiline = false, empty = false): value is string {
  return typeof value === 'string' && value.length <= limit && (empty || value.trim().length > 0)
    && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isSummary(value: unknown): value is PackSummary {
  return hasKeys(value, summaryKeys) && isPackId(value.id) && text(value.name, 72)
    && text(value.summary, 360) && isVersion(value.version)
    && typeof value.topicCount === 'number' && Number.isInteger(value.topicCount)
    && value.topicCount >= 1 && value.topicCount <= maxLessons
}

function isSummaryList(value: unknown): value is PackSummary[] {
  return Array.isArray(value) && value.length <= maxPacks && value.every(isSummary)
    && new Set(value.map(({ id }) => id)).size === value.length
}

export function parseInstalledLibrary(text: string): Registry {
  return validateRegistry(JSON.parse(text) as unknown)
}

function validateRegistry(stored: unknown): Registry {
  if (!hasKeys(stored, ['schema', 'selected', 'installed']) || stored.schema !== 1 || !isSummaryList(stored.installed)
    || (stored.selected !== null && (!isPackId(stored.selected) || !stored.installed.some(({ id }) => id === stored.selected)))) {
    throw new Error('The learning library could not be read.')
  }
  return { schema: 1, selected: stored.selected, installed: stored.installed }
}

function isLesson(value: unknown): value is PackLesson {
  return hasKeys(value, ['id', 'title', 'section', 'explanation', 'example', 'api', 'practice'], ['pitfall'])
    && isId(value.id) && text(value.title, 120) && text(value.section, 48)
    && text(value.explanation, 6000, true) && text(value.example, 8000, true, true) && text(value.practice, 2000, true)
    && (!Object.hasOwn(value, 'pitfall') || text(value.pitfall, 2000, true))
    && Array.isArray(value.api) && value.api.length <= 24
    && value.api.every((entry: unknown) => hasKeys(entry, ['name', 'description'])
      && text(entry.name, 100) && text(entry.description, 600, true))
}

function parsePack(value: unknown): PackDefinition {
  if (!hasKeys(value, ['schema', 'id', 'name', 'summary', 'version', 'lessons'])
    || value.schema !== 1 || !isPackId(value.id) || !text(value.name, 72) || !text(value.summary, 360)
    || !isVersion(value.version) || !Array.isArray(value.lessons) || value.lessons.length < 1
    || value.lessons.length > maxLessons || !value.lessons.every(isLesson)
    || new Set(value.lessons.map(({ id }) => id)).size !== value.lessons.length) {
    throw new Error('Invalid learning pack. Use a version 1 JSON pack with unique topic IDs and plain lesson content.')
  }
  return { schema: 1, id: value.id, name: value.name, summary: value.summary, version: value.version, lessons: value.lessons }
}

async function readJson(path: string, limit: number, label: string): Promise<unknown> {
  const handle = await open(path, readFlags).catch((error: unknown) => {
    if (errorCode(error, 'ELOOP')) throw new Error(`${label} must be a regular file.`)
    throw error
  })
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`${label} must be a regular file.`)
    if (before.size > BigInt(limit)) throw new Error(`${label} exceeds ${limit / 1024} KiB.`)
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (offset !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error(`${label} changed while reading. Try again.`)
    }
    return decodeJson(buffer.subarray(0, offset), label)
  } finally {
    await handle.close()
  }
}

function decodeJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON.`)
  }
}

async function readBundledJson(path: string, limit: number): Promise<unknown> {
  // ASAR gives bundled files synthetic timestamps. Use the bundled size and read
  // through Electron's archive-aware API. Imports always use the bounded handle above.
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > limit) throw new Error('The bundled learning catalog file is invalid or too large.')
  const bytes = await readFile(path)
  if (bytes.length !== stat.size) throw new Error('The bundled learning catalog file changed while reading.')
  return decodeJson(bytes, 'Learning pack catalog')
}

async function writeJson(path: string, data: unknown, limit: number): Promise<void> {
  const text = JSON.stringify(data) + '\n'
  if (Buffer.byteLength(text) > limit) throw new Error(`Learning content exceeds ${limit / 1024} KiB.`)
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

function describe(pack: PackDefinition): PackSummary {
  const { id, name, summary, version, lessons } = pack
  return { id, name, summary, version, topicCount: lessons.length }
}

export class LearningPackStore {
  private readonly directory: string
  private readonly registryPath: string
  private catalog: PackSummary[] | undefined
  private pending = Promise.resolve()

  constructor(profile: string, private readonly catalogPath: string) {
    this.directory = join(profile, learningLibraryDirectory)
    this.registryPath = join(this.directory, learningLibraryRegistry)
  }

  getLibrary(): Promise<PackLibrary> {
    return this.serial(async () => this.library(await this.readRegistry(), await this.readCatalog()))
  }

  isSelected(id: string): Promise<boolean> {
    return this.serial(async () => {
      if ((await this.readRegistry()).selected !== id) return false
      const stat = await lstat(this.packPath(id)).catch((error: unknown) => {
        if (errorCode(error, 'ENOENT')) return null
        throw error
      })
      return stat !== null && stat.isFile() && stat.size > 0 && stat.size <= maxLearningPackBytes
    })
  }

  install(id: unknown): Promise<PackLibrary> {
    return this.serial(async () => {
      const catalog = await this.readCatalog()
      const entry = catalog.find((item) => item.id === id)
      if (!entry) throw new Error('This pack is not in the Marketplace catalog.')
      const registry = await this.readRegistry()
      if (registry.installed.some((item) => item.id === entry.id)) return this.library(registry, catalog)
      const pack = parsePack(await readBundledJson(join(this.catalogPath, entry.id + '.json'), maxLearningPackBytes))
      const summary = describe(pack)
      if (!summaryKeys.every((key) => summary[key] === entry[key])) {
        throw new Error('The catalog pack does not match its listing.')
      }
      return this.add(registry, catalog, pack)
    })
  }

  importFile(path: string): Promise<PackLibrary> {
    return this.serial(async () => {
      const pack = parsePack(await readJson(path, maxLearningPackBytes, 'Learning pack'))
      const catalog = await this.readCatalog()
      if (catalog.some((entry) => entry.id === pack.id) || pack.id === 'c') {
        throw new Error('This ID is reserved for a catalog pack. Install that pack from Marketplace.')
      }
      const registry = await this.readRegistry()
      if (registry.installed.some((entry) => entry.id === pack.id)) throw new Error('A learning pack with this ID is already installed.')
      return this.add(registry, catalog, pack)
    })
  }

  select(id: unknown): Promise<PackLibrary> {
    return this.serial(async () => {
      const catalog = await this.readCatalog()
      const registry = await this.readRegistry()
      if (id !== null && (!isPackId(id) || !registry.installed.some((entry) => entry.id === id))) {
        throw new Error('Install this learning pack before selecting it.')
      }
      if (registry.selected !== id) {
        registry.selected = id
        await writeJson(this.registryPath, registry, maxLearningLibraryBytes)
      }
      return this.library(registry, catalog)
    })
  }

  remove(id: unknown): Promise<PackLibrary> {
    return this.serial(async () => {
      if (!isPackId(id)) throw new Error('Invalid learning pack ID.')
      const catalog = await this.readCatalog()
      const registry = await this.readRegistry()
      if (registry.installed.some((entry) => entry.id === id)) {
        registry.installed = registry.installed.filter((entry) => entry.id !== id)
        if (registry.selected === id) registry.selected = null
        await writeJson(this.registryPath, registry, maxLearningLibraryBytes)
        await rm(this.packPath(id), { force: true }).catch(() => undefined)
      }
      return this.library(registry, catalog)
    })
  }

  getTopics(id: unknown): Promise<PackTopic[]> {
    return this.serial(async () => (await this.readInstalled(id)).lessons.map(({ id, title, section }) => ({ id, title, section })))
  }

  getLesson(id: unknown, topic: unknown): Promise<PackLesson> {
    return this.serial(async () => {
      if (!isId(topic)) throw new Error('Invalid learning topic ID.')
      const lesson = (await this.readInstalled(id)).lessons.find(({ id }) => id === topic)
      if (!lesson) throw new Error('This topic is not in the installed learning pack.')
      return lesson
    })
  }

  private library(registry: Registry, catalog: PackSummary[]): PackLibrary {
    return { catalog, installed: registry.installed, selected: registry.selected }
  }

  private async add(registry: Registry, catalog: PackSummary[], pack: PackDefinition): Promise<PackLibrary> {
    if (registry.installed.length >= maxPacks) throw new Error('The 64-pack installation limit has been reached.')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (!await this.hasDirectory()) throw new Error('The learning library folder could not be created.')
    const path = this.packPath(pack.id)
    await writeJson(path, pack, maxLearningPackBytes)
    registry.installed.push(describe(pack))
    try {
      await writeJson(this.registryPath, registry, maxLearningLibraryBytes)
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined)
      throw error
    }
    return this.library(registry, catalog)
  }

  private async readCatalog(): Promise<PackSummary[]> {
    if (this.catalog) return this.catalog
    const catalog = await readBundledJson(join(this.catalogPath, 'index.json'), maxLearningLibraryBytes)
    if (!isSummaryList(catalog)) throw new Error('The learning pack catalog is invalid.')
    return (this.catalog = catalog)
  }

  private packPath(id: string): string {
    return join(this.directory, id + '.json')
  }

  private async readInstalled(id: unknown): Promise<PackDefinition> {
    if (!isPackId(id) || !(await this.readRegistry()).installed.some((entry) => entry.id === id)) {
      throw new Error('Install this learning pack first.')
    }
    const pack = parsePack(await readJson(this.packPath(id), maxLearningPackBytes, 'Installed learning pack'))
    if (pack.id !== id) throw new Error('The installed learning pack has a mismatched ID.')
    return pack
  }

  private async hasDirectory(): Promise<boolean> {
    const stat = await lstat(this.directory).catch((error: unknown) => {
      if (errorCode(error, 'ENOENT')) return null
      throw error
    })
    if (stat && !stat.isDirectory()) throw new Error('The learning library must be a local directory.')
    return stat !== null
  }

  private async readRegistry(): Promise<Registry> {
    const fresh: Registry = { schema: 1, selected: null, installed: [] }
    if (!await this.hasDirectory()) return fresh
    const stored = await readJson(this.registryPath, maxLearningLibraryBytes, 'Learning library').catch((error: unknown) => {
      if (errorCode(error, 'ENOENT')) return fresh
      throw error
    })
    return validateRegistry(stored)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }
}
