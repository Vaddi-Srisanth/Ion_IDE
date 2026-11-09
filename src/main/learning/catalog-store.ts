import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { diagnosticPackIds, type PackDetails, type PackImportPreview, type PackLesson, type PackLibrary,
  type PackSummary, type PackTopic } from '../../shared/learning-packs'
import { coreSummaryKeys, describe, details, hasKeys, isCompatible, isId, isLesson, isSummaryList, isTopicId, legacySource,
  lessonByteLimit, manifestFor, maxLearningLibraryBytes, maxLearningPackBytes, maxPackIndexBytes, maxPacks,
  parseManifest, parsePack, topicIndex, type PackManifest } from './pack-format'

export { maxLearningLibraryBytes, maxLearningPackBytes } from './pack-format'
export const learningLibraryDirectory = 'learning-library'
export const learningLibraryRegistry = 'library.json'
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const recentLimit = 8
type PackDefinition = ReturnType<typeof parsePack>
type Installed = PackSummary & { storage?: string }
interface Registry { schema: 1; selected: string | null; installed: Installed[]; recent?: string[] }
interface PendingImport { path: string; token: string; fingerprint: string; expires: number }

function errorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function readJson(path: string, limit: number, label: string): Promise<unknown> {
  const entry = await lstat(path, { bigint: true })
  if (!entry.isFile()) throw new Error(`${label} must be a regular file.`)
  if (entry.size > BigInt(limit)) throw new Error(`${label} exceeds ${limit / 1024} KiB.`)
  const handle = await open(path, readFlags).catch((error: unknown) => {
    if (errorCode(error, 'ELOOP')) throw new Error(`${label} must be a regular file.`)
    throw error
  })
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || entry.ino !== before.ino || entry.dev !== before.dev) {
      throw new Error(`${label} must be the selected regular file.`)
    }
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

function validateRegistry(stored: unknown): Registry {
  if (!hasKeys(stored, ['schema', 'selected', 'installed'], ['recent']) || stored.schema !== 1 || !isSummaryList(stored.installed)
    || (stored.selected !== null && (!isId(stored.selected) || !stored.installed.some(({ id }) => id === stored.selected)))
    || (Object.hasOwn(stored, 'recent') && (!Array.isArray(stored.recent) || stored.recent.length > recentLimit
      || !stored.recent.every((id: unknown) => isId(id))
      || new Set(stored.recent).size !== stored.recent.length))) {
    throw new Error('The learning library could not be read.')
  }
  const registry = stored as unknown as Registry
  const storage = registry.installed.flatMap((item) => item.storage ? [item.storage] : [])
  if (storage.length !== new Set(storage).size) throw new Error('The learning library could not be read.')
  return registry
}

export function parseInstalledLibrary(text: string): Registry {
  return validateRegistry(JSON.parse(text) as unknown)
}

function itemSource(item: Installed): 'catalog' | 'local' {
  return item.source ?? legacySource(item.id)
}

function installedListing({ storage: _storage, ...item }: Installed): PackSummary {
  const source = itemSource(item)
  return { ...item, source, offline: true, diagnostics: source === 'catalog' && diagnosticPackIds.some((id) => id === item.id) }
}

function folderName(storage: string): string {
  return 'pack-' + storage
}

function fingerprint(pack: PackDefinition): string {
  return createHash('sha256').update(JSON.stringify(pack)).digest('hex')
}

function verifyMatch(manifest: PackManifest, item: Installed) {
  if (manifest.id !== item.id || manifest.version !== item.version || manifest.topics.length !== item.topicCount) {
    throw new Error('The installed learning pack does not match its index.')
  }
}

export async function packProfileFiles(libraryDirectory: string, item: Installed): Promise<Array<{ name: string; limit: number }>> {
  if (!item.storage) return [{ name: item.id + '.json', limit: maxLearningPackBytes }]
  const folder = folderName(item.storage)
  const path = join(libraryDirectory, folder)
  if (!(await lstat(path)).isDirectory()) throw new Error('An installed learning pack must use a local directory.')
  const manifest = parseManifest(await readJson(join(path, 'manifest.json'), maxPackIndexBytes, 'Installed pack index'))
  verifyMatch(manifest, item)
  return [
    { name: join(folder, 'manifest.json'), limit: maxPackIndexBytes },
    ...manifest.topics.map(({ id }) => ({ name: join(folder, 'lesson-' + id + '.json'), limit: lessonByteLimit(manifest.schema) })),
  ]
}

export async function compileLearningCatalog(source: string, destination: string, current: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  const names = (await readdir(source)).filter((name) => name.endsWith('.json') && name !== 'index.json').sort()
  const listings: PackSummary[] = []
  if (!names.length || names.length > maxPacks) throw new Error('The bundled learning catalog has an invalid pack count.')
  for (const name of names) {
    try {
      const pack = parsePack(await readJson(join(source, name), maxLearningPackBytes, 'Bundled pack'))
      if (name !== pack.id + '.json' || !isCompatible(pack.metadata?.minimumIonVersion, current)) {
        throw new Error('Pack filename or minimum Ion version is invalid.')
      }
      const listing = describe(pack, 'catalog')
      listings.push(listing)
      await Promise.all([
        writeJson(join(destination, name), pack, maxLearningPackBytes),
        writeJson(join(destination, pack.id + '.details.json'), manifestFor(pack), maxPackIndexBytes),
      ])
    } catch (error) {
      throw new Error('Invalid bundled pack ' + name, { cause: error })
    }
  }
  if (!isSummaryList(listings)) throw new Error('The bundled learning catalog is invalid.')
  await writeJson(join(destination, 'index.json'), listings, maxLearningLibraryBytes)
}

export class LearningPackStore {
  private readonly directory: string
  private readonly registryPath: string
  private pending = Promise.resolve()
  private preview?: PendingImport

  constructor(profile: string, private readonly catalogPath: string, private readonly current = '0.9.4') {
    this.directory = join(profile, learningLibraryDirectory)
    this.registryPath = join(this.directory, learningLibraryRegistry)
  }

  getLibrary(includeCatalog = true): Promise<PackLibrary> {
    return this.serial(async () => this.library(await this.readRegistry(), includeCatalog ? await this.readCatalog() : []))
  }

  isSelected(id: string): Promise<boolean> {
    return this.serial(async () => {
      const registry = await this.readRegistry()
      const selected = registry.installed.find((item) => item.id === id)
      if (registry.selected !== id || !selected || itemSource(selected) !== 'catalog') return false
      const path = selected.storage ? join(this.directory, folderName(selected.storage), 'manifest.json') : this.legacyPath(id)
      if (selected.storage && !(await this.hasDirectory(join(this.directory, folderName(selected.storage))))) return false
      const stat = await lstat(path).catch((error: unknown) => {
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
      const previous = registry.installed.find((item) => item.id === entry.id)
      if (previous && itemSource(previous) !== 'catalog') {
        throw new Error('A local pack already uses this ID. Export it before removing it or changing its ID.')
      }
      if (previous && previous.version >= entry.version) return this.library(registry, catalog)
      const pack = parsePack(await readBundledJson(join(this.catalogPath, entry.id + '.json'), maxLearningPackBytes))
      const summary = describe(pack, 'catalog')
      if (!coreSummaryKeys.every((key) => summary[key] === entry[key])) throw new Error('The catalog pack does not match its listing.')
      if (previous) await this.checkTopicContinuity(previous, pack)
      await this.save(registry, pack, summary, previous)
      return this.library(registry, catalog)
    })
  }

  previewFile(path: string): Promise<PackImportPreview> {
    return this.serial(async () => {
      this.preview = undefined
      const pack = parsePack(await readJson(path, maxLearningPackBytes, 'Learning pack'))
      const catalog = await this.readCatalog()
      const registry = await this.readRegistry()
      const summary = describe(pack, 'local')
      const previous = await this.checkImport(registry, catalog, pack, summary)
      const token = randomUUID()
      this.preview = { path, token, fingerprint: fingerprint(pack), expires: Date.now() + 10 * 60_000 }
      return { token, details: details(summary, pack.lessons.map(topicIndex), pack.metadata), update: !!previous }
    })
  }

  confirmImport(token: unknown): Promise<PackLibrary> {
    return this.serial(async () => {
      const preview = this.preview
      if (!preview || preview.token !== token || preview.expires < Date.now()) {
        throw new Error('This import preview has expired. Open the file again.')
      }
      this.preview = undefined
      const pack = parsePack(await readJson(preview.path, maxLearningPackBytes, 'Learning pack'))
      if (fingerprint(pack) !== preview.fingerprint) throw new Error('The pack changed after preview. Open the file again.')
      return this.importPack(pack)
    })
  }

  discardImport(token: unknown): void {
    if (this.preview?.token === token) this.preview = undefined
  }

  // Used by trusted local tools and regression fixtures. The app uses preview and confirmation.
  importFile(path: string): Promise<PackLibrary> {
    return this.serial(async () => this.importPack(parsePack(await readJson(path, maxLearningPackBytes, 'Learning pack'))))
  }

  exportFile(id: unknown, path: string): Promise<void> {
    return this.serial(async () => {
      const installed = await this.requireInstalled(id)
      if (!installed.storage) return writeJson(path, await this.readLegacy(installed), maxLearningPackBytes)
      const manifest = await this.readInstalledIndex(installed)
      const { topics, ...metadata } = manifest
      const lessons: PackLesson[] = []
      for (const topic of topics) lessons.push(await this.readLesson(installed, topic, manifest.schema))
      await writeJson(path, parsePack({ ...metadata, lessons }), maxLearningPackBytes)
    })
  }

  select(id: unknown, includeCatalog = true): Promise<PackLibrary> {
    return this.serial(async () => {
      const catalog = includeCatalog ? await this.readCatalog() : []
      const registry = await this.readRegistry()
      if (id !== null && (!isId(id) || !registry.installed.some((entry) => entry.id === id))) {
        throw new Error('Install this learning pack before selecting it.')
      }
      if (registry.selected !== id || (id && registry.recent?.[0] !== id)) {
        registry.selected = id
        if (id) registry.recent = [id, ...(registry.recent ?? []).filter((item) => item !== id)].slice(0, recentLimit)
        await writeJson(this.registryPath, registry, maxLearningLibraryBytes)
      }
      return this.library(registry, catalog)
    })
  }

  remove(id: unknown): Promise<PackLibrary> {
    return this.serial(async () => {
      if (!isId(id)) throw new Error('Invalid learning pack ID.')
      const catalog = await this.readCatalog()
      const registry = await this.readRegistry()
      const previous = registry.installed.find((entry) => entry.id === id)
      if (previous) {
        registry.installed = registry.installed.filter((entry) => entry.id !== id)
        if (registry.selected === id) registry.selected = null
        registry.recent = registry.recent?.filter((item) => item !== id) ?? []
        await writeJson(this.registryPath, registry, maxLearningLibraryBytes)
        await this.removeData(previous)
      }
      return this.library(registry, catalog)
    })
  }

  getDetails(id: unknown): Promise<PackDetails> {
    return this.serial(async () => {
      if (!isId(id)) throw new Error('Invalid learning pack ID.')
      const registry = await this.readRegistry()
      const installed = registry.installed.find((item) => item.id === id)
      if (installed) {
        const manifest = await this.readInstalledIndex(installed)
        return details(installedListing(installed), manifest.topics, manifest.metadata)
      }
      const entry = (await this.readCatalog()).find((item) => item.id === id)
      if (!entry) throw new Error('This pack is not in the Marketplace catalog.')
      const raw = await readBundledJson(join(this.catalogPath, id + '.details.json'), maxPackIndexBytes)
        .catch((error: unknown) => { if (!errorCode(error, 'ENOENT')) throw error })
      const manifest = raw ? parseManifest(raw)
        : manifestFor(parsePack(await readBundledJson(join(this.catalogPath, id + '.json'), maxLearningPackBytes)))
      verifyMatch(manifest, entry)
      return details(entry, manifest.topics, manifest.metadata)
    })
  }

  getTopics(id: unknown): Promise<PackTopic[]> {
    return this.serial(async () => (await this.readInstalledIndex(await this.requireInstalled(id))).topics)
  }

  getLesson(id: unknown, topic: unknown): Promise<PackLesson> {
    return this.serial(async () => {
      if (!isTopicId(topic)) throw new Error('Invalid learning topic ID.')
      const installed = await this.requireInstalled(id)
      if (!installed.storage) {
        const lesson = (await this.readLegacy(installed)).lessons.find(({ id }) => id === topic)
        if (!lesson) throw new Error('This topic is not in the installed learning pack.')
        return lesson
      }
      const index = await this.readInstalledIndex(installed)
      const summary = index.topics.find((entry) => entry.id === topic)
      if (!summary) throw new Error('This topic is not in the installed learning pack.')
      return this.readLesson(installed, summary, index.schema)
    })
  }

  private async checkImport(registry: Registry, catalog: PackSummary[], pack: PackDefinition, summary: PackSummary) {
    const previous = registry.installed.find((entry) => entry.id === pack.id)
    if ((!previous || itemSource(previous) !== 'local')
      && (catalog.some((entry) => entry.id === pack.id) || legacySource(pack.id) === 'catalog')) {
      throw new Error('This ID is reserved for a catalog pack. Install that pack from Marketplace.')
    }
    this.assertCompatible(summary)
    if (previous && (itemSource(previous) !== 'local' || previous.version >= pack.version)) {
      throw new Error('A learning pack with this ID is already installed. Choose a newer compatible version to update it.')
    }
    if (previous) await this.checkTopicContinuity(previous, pack)
    return previous
  }

  private async importPack(pack: PackDefinition): Promise<PackLibrary> {
    const catalog = await this.readCatalog()
    const registry = await this.readRegistry()
    const summary = describe(pack, 'local')
    const previous = await this.checkImport(registry, catalog, pack, summary)
    await this.save(registry, pack, summary, previous)
    return this.library(registry, catalog)
  }

  private assertCompatible(summary: PackSummary) {
    if (!isCompatible(summary.minimumIonVersion, this.current)) {
      throw new Error('This learning pack requires Ion ' + summary.minimumIonVersion + ' or later.')
    }
  }

  private async checkTopicContinuity(previous: Installed, pack: PackDefinition) {
    const next = new Set(pack.lessons.map(({ id }) => id))
    if ((await this.readInstalledIndex(previous)).topics.some(({ id }) => !next.has(id))) {
      throw new Error('This update removes existing lesson IDs. Use a different pack ID to keep both versions.')
    }
  }

  private async save(registry: Registry, pack: PackDefinition, summary: PackSummary, previous?: Installed) {
    this.assertCompatible(summary)
    if (!previous && registry.installed.length >= maxPacks) throw new Error('The ' + maxPacks + '-pack installation limit has been reached.')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (!await this.hasDirectory(this.directory)) throw new Error('The learning library folder could not be created.')
    const storage = randomUUID()
    const folder = join(this.directory, folderName(storage))
    await mkdir(folder, { mode: 0o700 })
    try {
      await writeJson(join(folder, 'manifest.json'), manifestFor(pack), maxPackIndexBytes)
      for (const lesson of pack.lessons) await writeJson(join(folder, 'lesson-' + lesson.id + '.json'), lesson, lessonByteLimit(pack.schema))
      const installed = { ...summary, storage }
      if (previous) registry.installed[registry.installed.indexOf(previous)] = installed
      else registry.installed.push(installed)
      await writeJson(this.registryPath, registry, maxLearningLibraryBytes)
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    if (previous) await this.removeData(previous)
  }

  private async removeData(item: Installed) {
    const path = item.storage ? join(this.directory, folderName(item.storage)) : this.legacyPath(item.id)
    await rm(path, { recursive: !!item.storage, force: true }).catch(() => undefined)
  }

  private library(registry: Registry, catalog: PackSummary[]): PackLibrary {
    const bundled = new Map(catalog.map((entry) => [entry.id, entry]))
    const installed = registry.installed.map((item): PackSummary => {
      const listing = installedListing(item)
      const matching = !item.storage && listing.source === 'catalog' ? bundled.get(item.id) : undefined
      if (!matching) return listing
      if (coreSummaryKeys.every((key) => matching[key] === listing[key])) return { ...matching, ...listing }
      return { kind: matching.kind, categories: matching.categories, difficulties: ['beginner'], ...listing }
    })
    return { catalog, installed, selected: registry.selected,
      recent: registry.recent ?? [] }
  }

  private async readCatalog(): Promise<PackSummary[]> {
    const catalog = await readBundledJson(join(this.catalogPath, 'index.json'), maxLearningLibraryBytes)
    if (!isSummaryList(catalog)) throw new Error('The learning pack catalog is invalid.')
    return catalog
  }

  private legacyPath(id: string): string { return join(this.directory, id + '.json') }

  private async requireInstalled(id: unknown): Promise<Installed> {
    if (!isId(id)) throw new Error('Install this learning pack first.')
    const item = (await this.readRegistry()).installed.find((entry) => entry.id === id)
    if (!item) throw new Error('Install this learning pack first.')
    return item
  }

  private async readInstalledIndex(item: Installed): Promise<PackManifest> {
    let index: PackManifest
    if (!item.storage) {
      index = manifestFor(await this.readLegacy(item))
    } else {
      const folder = join(this.directory, folderName(item.storage))
      if (!await this.hasDirectory(folder)) throw new Error('The installed learning pack is missing.')
      index = parseManifest(await readJson(join(folder, 'manifest.json'), maxPackIndexBytes, 'Installed pack index'))
    }
    verifyMatch(index, item)
    return index
  }

  private async readLesson(item: Installed, topic: PackTopic, schema: PackManifest['schema']): Promise<PackLesson> {
    if (!item.storage) throw new Error('The installed learning pack does not have a lesson index.')
    const lesson = await readJson(join(this.directory, folderName(item.storage), 'lesson-' + topic.id + '.json'),
      lessonByteLimit(schema), 'Installed lesson')
    if (!isLesson(lesson) || lesson.id !== topic.id || lesson.title !== topic.title) {
      throw new Error('The installed lesson does not match its index.')
    }
    return lesson
  }

  private async readLegacy(item: Installed): Promise<PackDefinition> {
    const pack = parsePack(await readJson(this.legacyPath(item.id), maxLearningPackBytes, 'Installed learning pack'))
    if (pack.id !== item.id || pack.version !== item.version || pack.lessons.length !== item.topicCount) {
      throw new Error('The installed learning pack does not match its index.')
    }
    return pack
  }

  private async hasDirectory(path: string): Promise<boolean> {
    const stat = await lstat(path).catch((error: unknown) => {
      if (errorCode(error, 'ENOENT')) return null
      throw error
    })
    if (stat && !stat.isDirectory()) throw new Error('The learning library must use local directories.')
    return stat !== null
  }

  private async readRegistry(): Promise<Registry> {
    const fresh: Registry = { schema: 1, selected: null, installed: [] }
    if (!await this.hasDirectory(this.directory)) return fresh
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
