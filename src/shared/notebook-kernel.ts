import type { NotebookOutput } from './notebook-format'

export type NotebookKernelLifetime = 'tab' | 'window'

export interface NotebookKernelEnvironment {
  id: string
  label: string
  path: string
  names?: string[]
}

export interface NotebookKernelStatus {
  state: 'stopped' | 'starting' | 'idle' | 'busy'
  environment?: NotebookKernelEnvironment
}

export interface NotebookKernelRequest {
  id: string
  code: string
  environmentId?: string
  preferredName?: string
}

export interface NotebookKernelResult {
  outputs: NotebookOutput[]
  count: number | null
  status: 'ok' | 'error' | 'interrupted'
}

export interface NotebookKernelEvent {
  path: string
  id: string
  output: NotebookOutput
}

export interface NotebookKernelBridge {
  discover(path: string): Promise<NotebookKernelEnvironment[]>
  choose(path: string): Promise<NotebookKernelEnvironment | null>
  status(path: string): Promise<NotebookKernelStatus>
  run(path: string, request: NotebookKernelRequest): Promise<NotebookKernelResult>
  restart(path: string): Promise<NotebookKernelStatus>
  interrupt(path: string): Promise<void>
  stop(path: string): Promise<void>
  release(path: string, keep: boolean): Promise<void>
  onOutput(listener: (event: NotebookKernelEvent) => void): () => void
}
