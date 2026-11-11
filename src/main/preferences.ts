import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultSettings, type Entry, type Preferences, type RecentEntry, type Settings } from '../shared/contracts'
import { isThemeId } from '../shared/themes'
import { parseShortcutOverrides, shortcutPlatform } from '../shared/shortcuts'
import { isWithin } from './files'
import { smartLanguageIds } from '../shared/language-tools'

const maxRecents = 20
const maxPreferencesBytes = 64 * 1024
const settingsVersion = 1
const windowsReplaceDelays = [25, 50, 100, 200, 400]

async function replacePreferences(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, destination)
      return
    } catch (error) {
      const wait = windowsReplaceDelays[attempt]
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (process.platform !== 'win32' || wait === undefined || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) {
        throw error
      }
      // A Windows reader or scanner can briefly prevent replacement. Retain the
      // same atomic rename and leave the old file in place if the lock persists.
      await delay(wait)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integerBetween(min: number, max: number): (value: unknown) => boolean {
  return (value) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function isBoolean(value: unknown): boolean {
  return typeof value === 'boolean'
}

function themeIds(value: unknown, limit: number): boolean {
  return Array.isArray(value) && value.length <= limit
    && value.every((id) => id === 'system' || isThemeId(id)) && new Set(value).size === value.length
}

const validators: Record<keyof Settings, (value: unknown) => boolean> = {
  resourceProfile: (value) => value === 'minimal' || value === 'full',
  openFullScreen: isBoolean,
  checkUpdatesOnLaunch: isBoolean,
  theme: (value) => value === 'system' || isThemeId(value),
  themeFavorites: (value) => themeIds(value, 100),
  recentThemes: (value) => themeIds(value, 8),
  accent: (value) => value === 'cyan' || value === 'violet' || value === 'lime' || value === 'amber',
  fontSize: integerBetween(10, 32),
  tabSize: integerBetween(1, 8),
  wordWrap: isBoolean,
  lineNumbers: isBoolean,
  smartLanguages: (value) => Array.isArray(value) && value.length <= smartLanguageIds.length
    && value.every((language) => smartLanguageIds.some((id) => id === language)),
  automaticSuggestions: isBoolean,
  javaFormatter: (value) => value === 'auto' || value === 'clang-format' || value === 'google-java-format',
  pythonFormatter: (value) => value === 'auto' || value === 'ruff' || value === 'black',
  autoSave: isBoolean,
  autoSaveDelay: integerBetween(250, 10_000),
  saveBeforeRun: isBoolean,
  keepRunOutput: isBoolean,
  learningLens: isBoolean,
  notebookKernelLifetime: (value) => value === 'tab' || value === 'window',
  auxiliaryWidth: integerBetween(220, 620),
  explorerWidth: integerBetween(150, 620),
  outputHeight: integerBetween(100, 600),
  showExplorer: isBoolean,
  showOutput: isBoolean,
  shortcuts: (value) => parseShortcutOverrides(value, shortcutPlatform(process.platform)) !== null,
}

function settingsPatch(value: unknown, strict: boolean): Partial<Settings> {
  if (!isRecord(value)) {
    if (strict) throw new Error('Invalid settings.')
    return {}
  }

  const entries = Object.entries(value).filter(([key, setting]) => {
    const valid = Object.hasOwn(validators, key) && validators[key as keyof Settings](setting)
    if (strict && !valid) throw new Error('Invalid setting: ' + key)
    return valid
  })
  return Object.fromEntries(entries.map(([key, setting]) => [
    key, key === 'shortcuts' ? parseShortcutOverrides(setting, shortcutPlatform(process.platform)) : setting,
  ]))
}

function isRecent(value: unknown): value is RecentEntry {
  return isRecord(value) && typeof value.path === 'string' && value.path.length <= 4096 && isAbsolute(value.path)
    && typeof value.name === 'string' && (value.kind === 'file' || value.kind === 'folder')
    && typeof value.lastOpened === 'number' && Number.isSafeInteger(value.lastOpened) && value.lastOpened >= 0
}

function defaults(): Preferences {
  return { settings: { ...defaultSettings }, recents: [] }
}

async function readData(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > maxPreferencesBytes) throw new Error('Invalid preferences file size.')
    const buffer = Buffer.allocUnsafe(stats.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

export class PreferenceStore {
  private state: Promise<Preferences> | undefined
  private mutations: Promise<void> = Promise.resolve()
  private newProfile = false

  constructor(private readonly path: string) {}

  async get(): Promise<Preferences> {
    await this.mutations
    return this.load()
  }

  drain(): Promise<void> {
    return this.mutations
  }

  takeFirstLaunch(): boolean {
    if (!this.newProfile) return false
    this.newProfile = false
    // The presence of an Ion preferences file also identifies legacy profiles.
    // Serialize the first write with any settings or recents saved by this window.
    void this.update((previous) => ({ ...previous })).catch(() => {
      console.warn('Unable to record the first Ion IDE launch.')
    })
    return true
  }

  async exportSnapshot() {
    const { settings, recents } = await this.get()
    return { version: settingsVersion, settings, recents: recents.map(({ path, name, kind, lastOpened }) => ({
      path, name, kind, lastOpened,
    })) }
  }

  private load(): Promise<Preferences> {
    return this.state ??= this.read()
  }

  private async read(): Promise<Preferences> {
    let raw: string
    try {
      raw = await readData(this.path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.newProfile = true
        return defaults()
      }
      throw new Error('Preferences could not be read. The existing settings file was left in place.')
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('Preferences are damaged. The existing settings file was left in place.')
    }
    if (!isRecord(value) || value.version !== settingsVersion) {
      throw new Error('This preferences format is unsupported. The existing settings file was left in place.')
    }
    return {
      settings: { ...defaultSettings, ...settingsPatch(value.settings, false) },
      recents: Array.isArray(value.recents) ? value.recents.filter(isRecent).slice(0, maxRecents) : [],
    }
  }

  private update(transform: (state: Preferences) => Preferences): Promise<Preferences> {
    const result = this.mutations.then(async () => {
      const previous = await this.load()
      const state = transform(previous)
      if (state === previous) return state

      const temporary = this.path + '.' + randomUUID() + '.tmp'
      await mkdir(dirname(this.path), { recursive: true })
      try {
        await writeFile(temporary, JSON.stringify({ version: settingsVersion, ...state }) + '\n', { mode: 0o600, flag: 'wx' })
        await replacePreferences(temporary, this.path)
        this.state = Promise.resolve(state)
        return state
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    })
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }

  async updateSettings(value: unknown): Promise<Settings> {
    const patch = settingsPatch(value, true)
    const state = await this.update((previous) => ({ ...previous, settings: { ...previous.settings, ...patch } }))
    return state.settings
  }

  async remember(entry: Entry): Promise<void> {
    await this.update((state) => ({
      ...state,
      recents: [{ ...entry, lastOpened: Date.now() }, ...state.recents.filter((item) => item.path !== entry.path)].slice(0, maxRecents),
    }))
  }

  async moveRecents(source: string, target?: string): Promise<void> {
    await this.update((state) => {
      if (!state.recents.some((entry) => isWithin(source, entry.path))) return state
      const recents = state.recents.flatMap((entry) => {
        if (!isWithin(source, entry.path)) return [entry]
        if (!target) return []
        const path = join(target, relative(source, entry.path))
        return [{ ...entry, path, name: basename(path) }]
      })
      return { ...state, recents }
    })
  }
}
