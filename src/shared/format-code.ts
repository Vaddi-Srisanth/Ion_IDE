export type PythonFormatter = 'auto' | 'ruff' | 'black'
export type JavaFormatter = 'auto' | 'clang-format' | 'google-java-format'

export interface FormatRequest {
  id: string
  name: string
  path: string | null
  revision?: string
  text: string
  tabSize: number
  insertSpaces: boolean
  eol: '\n' | '\r\n'
}

export type FormatResult =
  | { kind: 'formatted'; tool: string; text: string }
  | { kind: 'unchanged'; tool: string }
  | { kind: 'error' | 'conflict' | 'cancelled'; message: string }

export interface FormatBridge {
  run(request: FormatRequest): Promise<FormatResult>
  cancel(id: string): Promise<void>
}
