import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { DocumentCommand } from './document-worker'

interface Pending {
  resolve(value: unknown): void
  reject(reason: Error): void
  timeout: ReturnType<typeof setTimeout>
}

export class DocumentWorker {
  private worker = new Worker(join(__dirname, 'document-worker.cjs'), {
    resourceLimits: { maxOldGenerationSizeMb: 160, maxYoungGenerationSizeMb: 16 },
  })
  private pending = new Map<number, Pending>()
  private sequence = 0
  private termination: Promise<unknown> | undefined

  constructor() {
    this.worker.on('message', ({ id, value, error }: { id: number; value: unknown; error?: string }) => {
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      clearTimeout(request.timeout)
      if (error) request.reject(new Error(error))
      else request.resolve(value)
    })
    this.worker.on('error', () => {
      void this.close(new Error('The document preview stopped. The file may exceed its resource limits.'))
    })
    this.worker.on('exit', () => { void this.close() })
  }

  request<T>(command: DocumentCommand): Promise<T> {
    if (this.termination) return Promise.reject(new Error('This document preview is closed.'))
    if (this.pending.size >= 8) return Promise.reject(new Error('Too many pending preview requests. Try again.'))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.close(new Error('The document exceeded the preview processing time limit.'))
      }, 25_000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout })
      this.worker.postMessage({ id, command })
    })
  }

  close(reason = new Error('This document preview is closed.')): Promise<unknown> {
    if (!this.termination) {
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout)
        request.reject(reason)
      }
      this.pending.clear()
      this.termination = this.worker.terminate().catch(() => undefined)
    }
    return this.termination
  }
}
