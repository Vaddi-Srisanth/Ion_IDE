export type DebugLanguage = 'c' | 'cpp'
export type DebugState = 'idle' | 'starting' | 'running' | 'stopped' | 'terminated' | 'error'
export type DebugAction = 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut' | 'restart'

export interface DebugBreakpoint {
  path: string
  line: number
  column?: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

export interface DebugStartRequest {
  sourcePath: string
  language: DebugLanguage
  version: number
  expectedRevision: string
  expectedContentHash: string
  breakpoints: DebugBreakpoint[]
}

export interface DebugBreakpointResult extends DebugBreakpoint {
  id?: number
  verified: boolean
  message?: string
}

export interface DebugSession {
  id: string
  state: DebugState
  threadId?: number
  sourcePath: string
  adapter: string
  compiler: string
  breakpoints: DebugBreakpointResult[]
}

export interface DebugFrame { id: number; name: string; path?: string; line: number; column: number }
export interface DebugScope { name: string; variablesReference: number; expensive: boolean }
export interface DebugVariable { name: string; value: string; type?: string; variablesReference: number }
export interface DebugEvaluation { result: string; type?: string; variablesReference: number }

export type DebugEvent =
  | { type: 'state'; sessionId: string; state: DebugState; reason?: string; threadId?: number }
  | { type: 'output'; sessionId: string; category: 'console' | 'stdout' | 'stderr'; output: string }
  | { type: 'breakpoints'; sessionId: string; breakpoints: DebugBreakpointResult[] }

export interface DebugBridge {
  start(request: DebugStartRequest): Promise<DebugSession>
  stop(sessionId: string): Promise<void>
  action(sessionId: string, action: DebugAction, threadId?: number): Promise<void>
  stack(sessionId: string, threadId: number): Promise<DebugFrame[]>
  scopes(sessionId: string, frameId: number): Promise<DebugScope[]>
  variables(sessionId: string, variablesReference: number): Promise<DebugVariable[]>
  evaluate(sessionId: string, expression: string, frameId?: number): Promise<DebugEvaluation>
  status(): Promise<DebugSession | null>
  onEvent(callback: (event: DebugEvent) => void): () => void
}

export function validDebugDocumentVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export const debugLimits = {
  breakpoints: 256, frames: 256, scopes: 64, variables: 1_000,
  expressionBytes: 4 * 1024, outputBytes: 256 * 1024, stringBytes: 64 * 1024,
} as const
