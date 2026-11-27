declare module 'yazl' {
  import { EventEmitter } from 'node:events'
  export class ZipFile extends EventEmitter {
    outputStream: import('node:stream').Readable
    addReadStreamLazy(name: string, options: { size: number; mode?: number; compressionLevel?: number }, callback: (callback: (error: Error | null, stream?: import('node:stream').Readable) => void) => void): void
    addBuffer(buffer: Buffer, name: string, options?: { mode?: number; compressionLevel?: number }): void
    end(): void
  }
}
