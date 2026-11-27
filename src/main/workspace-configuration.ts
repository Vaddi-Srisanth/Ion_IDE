import { isAbsolute, resolve } from 'node:path'
import type { Settings } from '../shared/contracts'
import { workspaceConfigurationBytes, workspaceRootLimit,
  type SavedWorkspaceConfiguration, type WorkspaceConfigurationSettings } from '../shared/workspace-configuration'
import { readJson, writeJson } from './projects/storage'

const keys = ['fontSize', 'tabSize', 'wordWrap', 'lineNumbers', 'showExplorer', 'explorerWidth'] as const

function settingsOf(value: unknown): WorkspaceConfigurationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace settings.')
  const input = value as Record<string, unknown>
  const settings = {} as WorkspaceConfigurationSettings
  for (const key of keys) {
    const item = input[key]
    if (key === 'fontSize' && (typeof item !== 'number' || !Number.isInteger(item) || item < 10 || item > 28)
      || key === 'tabSize' && (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 8)
      || key === 'explorerWidth' && (typeof item !== 'number' || !Number.isFinite(item) || item < 150 || item > 620)
      || key !== 'fontSize' && key !== 'tabSize' && key !== 'explorerWidth' && typeof item !== 'boolean') {
      throw new Error('Invalid workspace settings.')
    }
    ;(settings as Record<string, unknown>)[key] = item
  }
  return settings
}

export function workspaceSettings(settings: Settings): WorkspaceConfigurationSettings {
  return Object.fromEntries(keys.map((key) => [key, settings[key]])) as unknown as WorkspaceConfigurationSettings
}

export function validateWorkspaceConfiguration(value: unknown): SavedWorkspaceConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Ion workspace configuration.')
  const input = value as Record<string, unknown>
  if (input.version !== 1 || !Array.isArray(input.roots) || input.roots.length < 1 || input.roots.length > workspaceRootLimit) {
    throw new Error('Invalid Ion workspace configuration.')
  }
  const roots = input.roots.map((root) => {
    if (typeof root !== 'string' || root.length > 4096 || root.includes('\0') || !isAbsolute(root) || resolve(root) !== root) {
      throw new Error('Invalid workspace folder path.')
    }
    return root
  })
  if (new Set(roots).size !== roots.length) throw new Error('Duplicate workspace folder.')
  return { version: 1, roots, settings: settingsOf(input.settings) }
}

export async function readWorkspaceConfiguration(path: string) {
  const value = await readJson(path, workspaceConfigurationBytes)
  if (value === null) throw new Error('The Ion workspace configuration is missing.')
  return validateWorkspaceConfiguration(value)
}

export async function writeWorkspaceConfiguration(path: string, roots: readonly string[], settings: unknown) {
  const value = validateWorkspaceConfiguration({ version: 1, roots: [...roots], settings: workspaceSettings(settings as Settings) })
  await writeJson(path, value, workspaceConfigurationBytes)
}
