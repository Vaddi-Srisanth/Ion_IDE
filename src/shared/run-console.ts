import type { RunResult } from './contracts'

export { runnableLanguage as runLanguage, type RunLanguage } from './languages'

export function canPreviewWeb(name: string): boolean {
  return /\.(?:html?|css|js|mjs)$/i.test(name)
}

export type RunUpdate =
  | { kind: 'phase'; phase: 'preparing' | 'compiling' | 'running'; label?: string }
  | { kind: 'data'; text: string; stream: 'compiler' | 'terminal' }

export type RunConsoleEvent = RunUpdate | { kind: 'complete' }

export interface RunConsoleBridge {
  projectInputs(path: string): Promise<{ manifest: string; paths: string[] } | null>
  start(id: string, path: string, learn: boolean, expectedRevision?: string): Promise<RunResult>
  input(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  cancel(id: string): Promise<void>
  onUpdate(callback: (event: { id: string; update: RunConsoleEvent }) => void): () => void
  preview(path: string): Promise<void>
}
