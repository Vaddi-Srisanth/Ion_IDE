/** Read-only operations supported by a local language adapter. */
export type ToolOperation = 'diagnostics' | 'complete' | 'signature' | 'definition' | 'references'

export interface ToolSnapshot {
  language: string
  path: string
  version: number
  text: string
  operation: ToolOperation
  offset: number
}

export interface ToolReply {
  version: number
  rows: string[][]
}

export const toolTextLimit = 256 * 1024
export const smartLanguageIds = ['java'] as const

export interface LanguageToolsBridge {
  query(snapshot: ToolSnapshot): Promise<ToolReply | null>
  release(immediate: boolean): Promise<void>
}
