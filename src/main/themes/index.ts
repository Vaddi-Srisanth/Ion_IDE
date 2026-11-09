import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  builtinThemes, isCustomThemeId, isThemeAppearance, isThemeId, isThemeName, validateTheme,
  type ThemeData, type ThemeDefinition, type ThemeSummary,
} from '../../shared/themes'

const maxThemeBytes = 8 * 1024
const maxRegistryBytes = 512 * 1024
const maxCustomThemes = 1_000
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

async function readJson(file: string, limit: number, label: string): Promise<unknown> {
  const handle = await open(file, readFlags)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`${label} must be a regular file.`)
    if (stat.size > limit) throw new Error(`${label} exceeds ${limit / 1024} KiB.`)
    // Reserve one byte to catch files that grow between stat and read.
    const buffer = Buffer.allocUnsafe(stat.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > stat.size) throw new Error(`${label} changed while reading. Try again.`)
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)))
    } catch {
      throw new Error(`${label} must contain valid UTF-8 JSON.`)
    }
  } finally {
    await handle.close()
  }
}

async function writeJson(file: string, data: unknown, indent?: number): Promise<void> {
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temp, JSON.stringify(data, null, indent) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

function errorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function isCustomSummary(value: unknown): value is ThemeSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return Object.keys(entry).length === 4 && isCustomThemeId(entry.id) && isThemeName(entry.name)
    && isThemeAppearance(entry.appearance) && entry.source === 'custom'
}

export class ThemeStore {
  private readonly registryPath: string
  private readonly directory: string
  private mutations = Promise.resolve()

  constructor(userDataPath: string, private readonly builtinThemeDir: string) {
    this.directory = join(userDataPath, 'themes')
    this.registryPath = join(this.directory, 'registry.json')
  }

  async list(): Promise<ThemeSummary[]> {
    await this.mutations
    return [...builtinThemes, ...await this.readRegistry()]
  }

  async load(id: unknown): Promise<ThemeData> {
    if (!isThemeId(id)) throw new Error('Invalid theme ID.')
    const source = isCustomThemeId(id) ? 'custom' : 'builtin'
    const definition = source === 'custom'
      ? await this.readDefinition(join(this.directory, id + '.json'))
      : validateTheme(JSON.parse(await readFile(join(this.builtinThemeDir, id + '.json'), 'utf8')))
    return { id, source, ...definition }
  }

  async importFile(filePath: string): Promise<ThemeSummary> {
    return this.install(await this.readDefinition(filePath))
  }

  async exportFile(id: unknown, filePath: string): Promise<void> {
    const { version, name, appearance, colors, syntax } = await this.load(id)
    await writeJson(filePath, { version, name, appearance, colors, syntax }, 2)
  }

  async create(value: unknown): Promise<ThemeSummary> {
    return this.install(validateTheme(value))
  }

  private async readDefinition(file: string): Promise<ThemeDefinition> {
    try {
      return validateTheme(await readJson(file, maxThemeBytes, 'Theme file'))
    } catch (error) {
      if (errorCode(error, 'ENOENT')) throw new Error('Theme file could not be found.')
      if (errorCode(error, 'ELOOP')) throw new Error('Theme file must be a regular file.')
      throw error
    }
  }

  private async readRegistry(): Promise<ThemeSummary[]> {
    let value: unknown
    try {
      value = await readJson(this.registryPath, maxRegistryBytes, 'Theme registry')
    } catch (error) {
      if (errorCode(error, 'ENOENT')) return []
      throw error
    }
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('themes' in value) || !Array.isArray(value.themes) || value.themes.length > maxCustomThemes
      || !value.themes.every(isCustomSummary)
      || new Set(value.themes.map((entry) => entry.id)).size !== value.themes.length) {
      throw new Error('The custom theme registry could not be read.')
    }
    return value.themes
  }

  private install(definition: ThemeDefinition): Promise<ThemeSummary> {
    const result = this.mutations.then(async () => {
      const themes = await this.readRegistry()
      if (themes.length >= maxCustomThemes) throw new Error('The custom theme limit has been reached.')
      const { name, appearance } = definition
      const entry = { id: 'custom-' + randomUUID(), name, appearance, source: 'custom' } as const
      const file = join(this.directory, entry.id + '.json')
      await mkdir(dirname(file), { recursive: true })
      await writeJson(file, definition)
      try {
        await writeJson(this.registryPath, { version: 1, themes: [...themes, entry] })
      } catch (error) {
        await rm(file, { force: true }).catch(() => undefined)
        throw error
      }
      return entry
    })
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }
}
