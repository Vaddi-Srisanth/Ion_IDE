import { languageCapabilities, type SemanticOperation } from './languages'

export type ToolOperation = SemanticOperation

export interface ToolSnapshot {
  requestId?: string
  language: string
  path: string
  version: number
  text: string
  operation: ToolOperation
  offset: number
}

export interface SourceReference { path: string; line: number; column: number }

export interface ToolReply {
  version: number
  rows: string[][]
}

export interface ToolSave { language: string; path: string }

export const toolTextLimit = 256 * 1024
export const smartLanguageIds = languageCapabilities.filter(({ semantic }) => semantic).map(({ id }) => id)

export interface LanguageToolsBridge {
  query(snapshot: ToolSnapshot): Promise<ToolReply | null>
  cancel(requestId: string): Promise<void>
  saved(value: ToolSave): Promise<void>
  release(immediate: boolean, language?: string): Promise<void>
  status(): Promise<LanguageToolStatus[]>
  restart(language?: string): Promise<void>
}

export type LanguageToolState = 'disabled' | 'not-installed' | 'starting' | 'ready' | 'busy' | 'error' | 'stopped'
export interface LanguageToolStatus {
  adapter: string
  language: string
  root: string | null
  path: string
  state: LanguageToolState
  detail?: string
  executable?: string
  version?: string
  capabilities?: string[]
}
