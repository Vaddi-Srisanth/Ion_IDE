import type { RunResult } from './contracts'

export type RunLanguage = 'c' | 'cpp' | 'java' | 'python' | 'javascript'

const languages: Record<string, RunLanguage> = {
  c: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp',
  java: 'java', py: 'python', python: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
}

export function runLanguage(name: string): RunLanguage | undefined {
  const extension = name.slice(name.lastIndexOf('.') + 1)
  if (name.endsWith('.C')) return 'cpp'
  return name.includes('.') && Object.hasOwn(languages, extension.toLowerCase()) ? languages[extension.toLowerCase()] : undefined
}

export function canPreviewWeb(name: string): boolean {
  return /\.(?:html?|css|js|mjs)$/i.test(name)
}

export type RunUpdate =
  | { kind: 'phase'; phase: 'preparing' | 'compiling' | 'running'; label?: string }
  | { kind: 'data'; text: string; stream: 'compiler' | 'terminal' }

export type RunConsoleEvent = RunUpdate | { kind: 'complete' }

export interface RunConsoleBridge {
  start(id: string, path: string, learn: boolean, expectedRevision?: string): Promise<RunResult>
  input(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  cancel(id: string): Promise<void>
  onUpdate(callback: (event: { id: string; update: RunConsoleEvent }) => void): () => void
  preview(path: string): Promise<void>
}
