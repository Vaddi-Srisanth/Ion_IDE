import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { runLanguage } from '../../shared/run-console'
import { entryName, isWithin, maxFileBytes, revision, type WorkspaceFiles } from '../files'

const manifestName = '.ion/build.json'
const maxManifestBytes = 16 * 1024
const maxInputBytes = 32n * 1024n * 1024n
const headerName = /\.(?:h|hh|hpp|hxx|h\+\+|inc|inl|ipp|tpp|tcc)$/i

export interface NativeProject {
  manifest: string
  sources: string[]
  includeDirectories: string[]
  inputs: { path: string; revision: string }[]
}

function pathList(root: string, value: unknown, field: string, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${manifestName} requires ${field} to be a list of up to ${limit} workspace-relative paths.`)
  }
  const paths = value.map((item: unknown) => {
    if (typeof item !== 'string' || Buffer.byteLength(item) > 1024 || /[:<>|"*?]/.test(item)) {
      throw new Error(`${manifestName} has an invalid path in ${field}.`)
    }
    const segments = item.split('/')
    try {
      for (const segment of segments) entryName(segment)
    } catch {
      throw new Error(`${manifestName} requires regular workspace-relative paths separated by forward slashes.`)
    }
    return join(root, ...segments)
  })
  if (new Set(paths).size !== paths.length) throw new Error(`${manifestName} has duplicate paths in ${field}.`)
  return paths
}

async function readManifest(scope: WorkspaceFiles, path: string, expected: string, size: number): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  const changed = () => new Error(`${manifestName} changed while reading it. Run again.`)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || revision(before) !== expected) throw changed()
    const data = Buffer.alloc(size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (!bytesRead) throw changed()
      offset += bytesRead
    }
    const { stats } = await scope.inspect(path, 'file')
    if (revision(stats) !== expected) throw changed()
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
    } catch {
      throw new Error(`${manifestName} must contain valid UTF-8 JSON.`)
    }
  } finally {
    await handle.close()
  }
}

export async function readNativeProject(scope: WorkspaceFiles, root: string, active: string): Promise<NativeProject | undefined> {
  const language = runLanguage(active)
  if ((language !== 'c' && language !== 'cpp') || scope.rootPath !== root || !isWithin(root, active)) return

  const manifest = join(root, manifestName)
  const entry = await scope.inspect(manifest, 'file').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (!entry) return
  if (entry.stats.size > BigInt(maxManifestBytes)) throw new Error(`${manifestName} exceeds 16 KiB.`)

  const manifestRevision = revision(entry.stats)
  const value = await readManifest(scope, manifest, manifestRevision, Number(entry.stats.size))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${manifestName} must contain a build object.`)
  }
  const config = value as Record<string, unknown>
  if (config.version !== 1 || Object.keys(config).some((key) => !['version', 'sources', 'headers', 'includeDirectories'].includes(key))) {
    throw new Error(`${manifestName} supports version 1 with sources, headers and includeDirectories only.`)
  }

  const sources = pathList(root, config.sources, 'sources', 32)
  const sourceLanguage = sources.length && runLanguage(sources[0])
  if ((sourceLanguage !== 'c' && sourceLanguage !== 'cpp') || sources.some((source) => runLanguage(source) !== sourceLanguage)) {
    throw new Error(`${manifestName} requires a nonempty list of C or C++ source files using one language.`)
  }
  const headers = pathList(root, config.headers === undefined ? [] : config.headers, 'headers', 64)
  if (headers.some((header) => !headerName.test(header))) throw new Error(`${manifestName} has an invalid header extension.`)
  const includeDirectories = pathList(root, config.includeDirectories === undefined ? [] : config.includeDirectories, 'includeDirectories', 8)
  if (!sources.includes(active)) return

  const inputs = [{ path: manifest, revision: manifestRevision }]
  let total = 0n
  const identities = new Set<string>()
  for (const path of [...sources, ...headers]) {
    const { stats } = await scope.inspect(path, 'file')
    total += stats.size
    if (stats.size > BigInt(maxFileBytes) || total > maxInputBytes) {
      throw new Error(`${manifestName} limits inputs to 2 MiB per file and 32 MiB total.`)
    }
    const identity = `${stats.dev}:${stats.ino}`
    if (stats.ino !== 0n && identities.has(identity)) throw new Error(`${manifestName} lists the same input file more than once.`)
    identities.add(identity)
    inputs.push({ path, revision: revision(stats) })
  }
  for (const directory of includeDirectories) await scope.inspect(directory, 'folder')
  return { manifest, sources, includeDirectories, inputs }
}
