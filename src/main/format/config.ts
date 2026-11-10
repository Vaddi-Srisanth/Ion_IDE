import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, dirname, join, matchesGlob, relative, sep } from 'node:path'
import { isWithin } from '../files'

const configLimit = 64 * 1024

async function readConfig(path: string): Promise<string | undefined> {
  // Formatter configuration is data. Reject symlink files and special files
  // before reading anything into the main process.
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return
    throw new Error('Could not read ' + basename(path) + ' safely.')
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > configLimit) throw new Error(basename(path) + ' exceeds the formatter configuration limit.')
    const bytes = Buffer.allocUnsafe(stats.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== stats.size) throw new Error(basename(path) + ' changed while preparing to format.')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

export async function findConfig(source: string, root: string, names: readonly string[], accepts = (_name: string, _text: string) => true) {
  let directory = dirname(source)
  for (let level = 0; level < 32 && isWithin(root, directory); level++) {
    for (const name of names) {
      const path = join(directory, name)
      const canonical = await realpath(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        throw error
      })
      if (!canonical) continue
      if (!isWithin(root, canonical)) throw new Error(name + ' is outside the formatter configuration directory.')
      const text = await readConfig(path)
      if (text !== undefined && accepts(name, text)) return { path: canonical, text }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const prettierKeys = [
  'arrowParens', 'bracketSameLine', 'bracketSpacing', 'embeddedLanguageFormatting', 'htmlWhitespaceSensitivity',
  'jsxSingleQuote', 'printWidth', 'proseWrap', 'quoteProps', 'semi', 'singleAttributePerLine', 'singleQuote',
  'tabWidth', 'trailingComma', 'useTabs', 'vueIndentScriptAndStyle',
] as const

function prettierOptions(value: unknown) {
  if (!isRecord(value)) throw new Error('Use a JSON object for the Prettier configuration.')
  if (value.plugins !== undefined && (!Array.isArray(value.plugins) || value.plugins.length)) {
    throw new Error('Ion’s Prettier integration accepts built-in parsers only. Remove plugins from the JSON config to use it here.')
  }
  return Object.fromEntries(prettierKeys.flatMap((key) => {
    const option = value[key]
    return ['string', 'number', 'boolean'].includes(typeof option) ? [[key, option]] : []
  }))
}

export async function prettierConfig(source: string, root: string) {
  const config = await findConfig(source, root, ['.prettierrc', '.prettierrc.json', 'package.json'],
    (name, text) => name !== 'package.json' || /"prettier"\s*:/.test(text))
  if (!config) return undefined
  let data: unknown
  try { data = JSON.parse(config.text) }
  catch { throw new Error('Use JSON in .prettierrc or .prettierrc.json to format this file in Ion.') }
  if (basename(config.path) === 'package.json') {
    if (!isRecord(data) || !Object.hasOwn(data, 'prettier')) return undefined
    data = data.prettier
  }
  const options = prettierOptions(data)
  if (!isRecord(data) || data.overrides === undefined) return options
  if (!Array.isArray(data.overrides) || data.overrides.length > 64) throw new Error('Invalid Prettier overrides.')
  const patterns = (value: unknown): value is string | string[] =>
    typeof value === 'string' || (Array.isArray(value) && value.length <= 64 && value.every((pattern) => typeof pattern === 'string'))
  const relativeSource = relative(dirname(config.path), source).split(sep).join('/')
  const matches = (patterns: string | string[]) => [patterns].flat().some((pattern) =>
    matchesGlob(pattern.includes('/') ? relativeSource : basename(source), pattern))
  for (const override of data.overrides) {
    if (!isRecord(override) || !patterns(override.files) || (override.excludeFiles !== undefined && !patterns(override.excludeFiles))) {
      throw new Error('Invalid Prettier override paths.')
    }
    if (matches(override.files) && (override.excludeFiles === undefined || !matches(override.excludeFiles))) {
      Object.assign(options, prettierOptions(override.options))
    }
  }
  return options
}
