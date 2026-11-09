import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { documentFormat, type DocumentFormat, type TableMatch, type TablePage, type TableSheet,
  type ViewerSession, type WordImage, type WordPage } from '../../shared/viewers'
import { revision, type WorkspaceFiles } from '../files'
import { convertPresentation, findPresentationEngine } from './presentation'
import { DocumentWorker } from './worker-client'

const MiB = 1024 * 1024
const inputLimits: Record<DocumentFormat, number> = { pdf: 96 * MiB, csv: 24 * MiB, docx: 32 * MiB, xlsx: 48 * MiB, pptx: 48 * MiB }
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error('Invalid document preview range.')
  }
  return value
}

function smallString(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.length || value.length > limit || value.includes('\0')) {
    throw new Error('Invalid document preview request.')
  }
  return value
}

interface Resources {
  file?: FileHandle
  worker?: DocumentWorker
  directory?: string
}

interface ActivePreview extends Resources {
  info: ViewerSession
  fileRevision?: string
  reads: number
}

async function release(resources: Resources): Promise<void> {
  await Promise.all([resources.worker?.close(), resources.file?.close().catch(() => undefined)])
  if (resources.directory) await rm(resources.directory, { recursive: true, force: true }).catch(() => undefined)
}

async function checkPdf(file: FileHandle, length: number) {
  if (length < 8 || length > inputLimits.pdf) throw new Error('PDF previews support files up to 96 MiB.')
  const sample = Buffer.alloc(Math.min(length, 1024))
  const { bytesRead } = await file.read(sample, 0, sample.length, 0)
  if (!sample.subarray(0, bytesRead).includes('%PDF-')) throw new Error('This file does not contain a PDF header.')
}

export class ViewerService {
  private pending = new Map<string, { controller: AbortController; task: Promise<ViewerSession> }>()
  private active = new Map<string, ActivePreview>()
  private closed = false

  constructor(private readonly files: WorkspaceFiles) {}

  open(path: unknown, requestId: unknown): Promise<ViewerSession> {
    if (this.closed) throw new Error('The workspace closed.')
    if (!validId(requestId) || this.pending.has(requestId)) throw new Error('Invalid document preview request.')
    if (this.pending.size + this.active.size >= 4) throw new Error('Close an open preview before opening another document.')
    const controller = new AbortController()
    const task = this.prepare(path, controller.signal).finally(() => this.pending.delete(requestId))
    this.pending.set(requestId, { controller, task })
    return task
  }

  cancel(requestId: unknown): void {
    if (validId(requestId)) this.pending.get(requestId)?.controller.abort()
  }

  async close(id: unknown): Promise<void> {
    if (!validId(id)) return
    const session = this.active.get(id)
    this.active.delete(id)
    if (session) await release(session)
  }

  async dispose(): Promise<void> {
    this.closed = true
    for (const { controller } of this.pending.values()) controller.abort()
    await Promise.allSettled([
      ...Array.from(this.pending.values(), ({ task }) => task),
      ...Array.from(this.active.keys(), (id) => this.close(id)),
    ])
  }

  private async prepare(value: unknown, signal: AbortSignal): Promise<ViewerSession> {
    const { path, stats } = await this.files.inspect(value, 'file')
    const format = documentFormat(path)
    if (!format) throw new Error('This file does not have a supported document extension.')
    const byteLength = Number(stats.size)
    if (!byteLength || byteLength > inputLimits[format]) {
      throw new Error(`${format.toUpperCase()} previews require a nonempty file up to ${inputLimits[format] / MiB} MiB.`)
    }
    signal.throwIfAborted()
    const engine = format === 'pptx' ? await findPresentationEngine() : undefined
    const id = randomUUID()
    const resources: Resources = {}
    let published = false
    const cancelWorker = () => { void resources.worker?.close() }
    signal.addEventListener('abort', cancelWorker, { once: true })
    try {
      resources.file = await open(path, readFlags)
      const originalRevision = revision(stats)
      if (revision(await resources.file.stat({ bigint: true })) !== originalRevision) {
        throw new Error('The document changed while opening it. Reopen the preview.')
      }
      let info: ViewerSession
      let fileRevision: string | undefined
      if (format === 'pdf') {
        await checkPdf(resources.file, byteLength)
        info = { id, format, byteLength }
        fileRevision = originalRevision
      } else {
        signal.throwIfAborted()
        resources.directory = await mkdtemp(join(await realpath(tmpdir()), 'ion-preview-'))
        const copy = join(resources.directory, 'input.' + format)
        // Stream a stable file descriptor into a private snapshot. Parsers and
        // converters never open or write the original workspace path.
        await pipeline(
          resources.file.createReadStream({ autoClose: false, start: 0, end: byteLength - 1 }),
          createWriteStream(copy, { flags: 'wx', mode: 0o600 }), { signal },
        )
        if (revision(await resources.file.stat({ bigint: true })) !== originalRevision) {
          throw new Error('The document changed while reading it. Reopen the preview.')
        }
        await resources.file.close()
        resources.file = undefined
        signal.throwIfAborted()
        resources.worker = new DocumentWorker()
        if (format === 'pptx' && engine) {
          await resources.worker.request({ kind: 'verify-presentation', path: copy })
          await resources.worker.close()
          resources.worker = undefined
          const output = await convertPresentation(engine, resources.directory, copy, signal)
          resources.file = await open(output, readFlags)
          const outputStats = await resources.file.stat({ bigint: true })
          if (!outputStats.isFile()) throw new Error('The slide converter did not produce a regular PDF.')
          const length = Number(outputStats.size)
          await checkPdf(resources.file, length)
          fileRevision = revision(outputStats)
          // Keep only the generated PDF while the deck is visible.
          await rm(copy, { force: true })
          await rm(join(resources.directory, 'profile'), { force: true, recursive: true })
          info = { id, format, byteLength: length }
        } else if (format === 'docx') {
          await resources.worker.request({ kind: 'open-word', path: copy })
          info = { id, format }
        } else if (format === 'csv' || format === 'xlsx') {
          const sheets = await resources.worker.request<TableSheet[]>({ kind: 'open-table', path: copy, format })
          info = { id, format, sheets }
        } else {
          throw new Error('PowerPoint preview engine unavailable.')
        }
      }
      signal.throwIfAborted()
      this.active.set(id, { ...resources, info, fileRevision, reads: 0 })
      published = true
      return info
    } finally {
      signal.removeEventListener('abort', cancelWorker)
      if (!published) await release(resources)
    }
  }

  private preview(id: unknown, formats: readonly DocumentFormat[]): ActivePreview {
    const found = validId(id) ? this.active.get(id) : undefined
    if (!found || !formats.includes(found.info.format)) throw new Error('This document preview is no longer open.')
    return found
  }

  async readPdf(id: unknown, offset: unknown, length: unknown): Promise<Uint8Array> {
    const session = this.preview(id, ['pdf', 'pptx'])
    const { file, info } = session
    if (!file || !('byteLength' in info)) throw new Error('This PDF preview is closed.')
    const begin = integer(offset, 0, info.byteLength)
    const size = integer(length, 1, Math.min(256 * 1024, info.byteLength - begin))
    if (session.reads >= 8) throw new Error('Too many concurrent PDF reads.')
    session.reads++
    try {
      if (revision(await file.stat({ bigint: true })) !== session.fileRevision) {
        throw new Error('The PDF changed on disk. Reopen the preview.')
      }
      const bytes = new Uint8Array(size)
      let read = 0
      while (read < size) {
        const { bytesRead } = await file.read(bytes, read, size - read, begin + read)
        if (bytesRead === 0) throw new Error('The PDF ended unexpectedly.')
        read += bytesRead
      }
      return bytes
    } finally {
      session.reads--
    }
  }

  tablePage(id: unknown, sheet: unknown, row: unknown, column: unknown, rows: unknown, columns: unknown) {
    return this.preview(id, ['csv', 'xlsx']).worker!.request<TablePage>({
      kind: 'table-page', sheet: smallString(sheet, 128),
      row: integer(row, 0, 1_048_575), column: integer(column, 0, 16_383),
      rows: integer(rows, 1, 80), columns: integer(columns, 1, 16),
    })
  }

  tableSearch(id: unknown, sheet: unknown, query: unknown, after: unknown) {
    let start: TableMatch | undefined
    if (after !== undefined) {
      if (typeof after !== 'object' || !after || !('row' in after) || !('column' in after)) {
        throw new Error('Invalid search position.')
      }
      start = { row: integer(after.row, 0, 1_048_575), column: integer(after.column, 0, 16_383) }
    }
    return this.preview(id, ['csv', 'xlsx']).worker!.request<TableMatch | null>({
      kind: 'table-search', sheet: smallString(sheet, 128), query: smallString(query, 160), after: start,
    })
  }

  wordPage(id: unknown, page: unknown) {
    return this.preview(id, ['docx']).worker!.request<WordPage>({ kind: 'word-page', page: integer(page, 0, 249) })
  }

  wordImage(id: unknown, image: unknown) {
    return this.preview(id, ['docx']).worker!.request<WordImage>({ kind: 'word-image', image: smallString(image, 512) })
  }
}
