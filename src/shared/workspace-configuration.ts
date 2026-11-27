import type { Entry, Settings } from './contracts'

export const workspaceConfigurationBytes = 64 * 1024
export const workspaceRootLimit = 8

export type WorkspaceConfigurationSettings = Pick<Settings,
  'fontSize' | 'tabSize' | 'wordWrap' | 'lineNumbers' | 'showExplorer' | 'explorerWidth'>

export interface SavedWorkspaceConfiguration {
  version: 1
  roots: string[]
  settings: WorkspaceConfigurationSettings
}

export interface OpenedWorkspaceConfiguration {
  roots: Entry[]
  settings: WorkspaceConfigurationSettings
}
