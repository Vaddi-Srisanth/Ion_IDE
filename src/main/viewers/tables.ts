import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { TableMatch } from '../../shared/viewers'
import { checkPage, checkSearch, gridPage, gridSearch, trimCell, type TableDocument, type TableGrid } from './table-grid'

export type { TableDocument } from './table-grid'

const maxCsvBytes = 24 * 1024 * 1024
const maxCsvRows = 100_000
const maxCsvColumns = 1_024
const maxCsvFields = 1_000_000
const maxCsvChars = 16 * 1024 * 1024
const delimiters = [',', '\t', ';', '|'] as const
const csvSheet = { id: 'csv', name: 'CSV' }

class InvalidEncoding extends Error {}

function decode(decoder: TextDecoder, data?: Uint8Array): string {
  try {
    return decoder.decode(data, { stream: data !== undefined })
  } catch {
    throw new InvalidEncoding('CSV contains invalid text for the detected encoding.')
  }
}

async function* readChunks(handle: FileHandle, encoding: string) {
  const bytes = Buffer.allocUnsafe(64 * 1024)
  const decoder = new TextDecoder(encoding, { fatal: true })
  let offset = 0
  while (offset <= maxCsvBytes) {
    const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, maxCsvBytes + 1 - offset), offset)
    if (bytesRead === 0) break
    offset += bytesRead
    if (offset > maxCsvBytes) throw new Error('CSV exceeds the 24 MiB preview limit.')
    const text = decode(decoder, bytes.subarray(0, bytesRead))
    if (text.includes('\0')) throw new Error('CSV preview requires text without binary null bytes.')
    yield text
  }
  yield decode(decoder)
}

function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
}

function detectDelimiter(sample: string, complete: boolean): string {
  const records: number[][] = []
  let fields = delimiters.map(() => 0)
  let quoted = false
  for (let index = 0; index < sample.length && records.length < 20; index++) {
    const character = sample[index]
    if (character === '"') {
      if (quoted && sample[index + 1] === '"') index++
      else quoted = !quoted
    } else if (!quoted) {
      if (character === '\n' || character === '\r') {
        if (character === '\r' && sample[index + 1] === '\n') index++
        records.push(fields)
        fields = delimiters.map(() => 0)
      } else {
        const delimiter = delimiters.findIndex((item) => item === character)
        if (delimiter >= 0) fields[delimiter]++
      }
    }
  }
  if ((complete || !records.length) && fields.some(Boolean)) records.push(fields)
  let selected: string = ','
  let bestScore = 0
  for (let delimiter = 0; delimiter < delimiters.length; delimiter++) {
    const frequencies = new Map<number, number>()
    for (const counts of records) {
      const count = counts[delimiter]
      if (count > 0) frequencies.set(count, (frequencies.get(count) ?? 0) + 1)
    }
    for (const [count, frequency] of frequencies) {
      // Favor a stable field count across records over delimiter-like characters in data.
      const score = (frequency / records.length) ** 2 * Math.log2(count + 1)
      if (score > bestScore) {
        bestScore = score
        selected = delimiters[delimiter]
      }
    }
  }
  return selected
}

async function readCsv(handle: FileHandle, encoding: string, delimiter: string): Promise<TableGrid> {
  const { parse } = await import('csv-parse')
  const rows: string[][] = []
  let columnCount = 0
  let fields = 0
  let chars = 0
  const parser = parse({
    delimiter,
    relax_column_count: true,
    max_record_size: 64 * 1024,
    cast(value, context) {
      // Bound empty fields before the parser has to allocate the whole record.
      if (context.index >= maxCsvColumns) throw new Error('CSV exceeds the preview limit of 1,024 columns.')
      return value
    },
  })
  try {
    await pipeline(Readable.from(readChunks(handle, encoding)), parser, async (records) => {
      for await (const fieldsInRow of records as AsyncIterable<string[]>) {
        fields += fieldsInRow.length
        if (rows.length >= maxCsvRows || fieldsInRow.length > maxCsvColumns || fields > maxCsvFields) {
          throw new Error('CSV exceeds the preview limit of 100,000 rows, 1,024 columns or 1,000,000 fields.')
        }
        const row = fieldsInRow.map((value) => trimCell(value))
        for (const value of row) chars += value.length
        if (chars > maxCsvChars) throw new Error('CSV contains too much text for the preview.')
        columnCount = Math.max(columnCount, row.length)
        rows.push(row)
      }
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('CSV_')) {
      throw new Error('CSV could not be parsed. Check the quoting or record size.')
    }
    throw error
  }
  return { rows, rowCount: rows.length, columnCount }
}

async function openCsv(path: string): Promise<TableDocument> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let grid: TableGrid | undefined
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > maxCsvBytes) throw new Error('CSV exceeds the 24 MiB preview limit or is not a regular file.')
    const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, stats.size))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const sample = bytes.subarray(0, bytesRead)
    const bom = bomEncoding(sample)
    let encoding = bom ?? 'utf-8'
    let decoded: string
    try {
      decoded = decode(new TextDecoder(encoding, { fatal: true }), sample)
    } catch (error) {
      if (bom || !(error instanceof InvalidEncoding)) throw error
      encoding = 'windows-1252'
      decoded = new TextDecoder(encoding).decode(sample)
    }
    if (decoded.includes('\0')) throw new Error('CSV preview requires UTF-8, BOM-marked UTF-16, or Windows-1252 text.')
    const delimiter = detectDelimiter(decoded, sample.length === stats.size)
    try {
      grid = await readCsv(handle, encoding, delimiter)
    } catch (error) {
      if (bom || encoding !== 'utf-8' || !(error instanceof InvalidEncoding)) throw error
      grid = await readCsv(handle, 'windows-1252', delimiter)
    }
  } finally {
    await handle.close()
  }

  function getGrid(sheetId: string) {
    if (sheetId !== csvSheet.id || !grid) throw new Error('This CSV sheet is unavailable.')
    return grid
  }

  return {
    sheets: [csvSheet],
    async page(sheetId, rowOffset, columnOffset, rowLimit, columnLimit) {
      checkPage(rowOffset, columnOffset, rowLimit, columnLimit)
      return gridPage(getGrid(sheetId), rowOffset, columnOffset, rowLimit, columnLimit)
    },
    async search(sheetId, query, after?: TableMatch) {
      checkSearch(query, after)
      return gridSearch(getGrid(sheetId), query, after)
    },
    close() { grid = undefined },
  }
}

export async function openTable(path: string, format: 'csv' | 'xlsx'): Promise<TableDocument> {
  return format === 'csv' ? openCsv(path) : (await import('./xlsx')).openWorkbook(path)
}
