import { languageCapabilities, type SemanticOperation } from './languages'

export type ToolOperation = SemanticOperation

export interface ToolSnapshot {
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

export const toolTextLimit = 256 * 1024
export const smartLanguageIds = languageCapabilities.filter(({ semantic }) => semantic).map(({ id }) => id)

export interface LanguageToolsBridge {
  query(snapshot: ToolSnapshot): Promise<ToolReply | null>
  release(immediate: boolean, language?: string): Promise<void>
}
