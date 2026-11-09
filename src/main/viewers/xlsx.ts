import { posix } from 'node:path'
import { parser, type QualifiedTag } from 'sax'
import type { TableSheet } from '../../shared/viewers'
import { checkPage, checkSearch, gridPage, gridSearch, maxCellLength, maxTableColumns, maxTableRows, trimCell, type TableDocument, type TableGrid } from './table-grid'
import { openZip } from './zip'

const maxMetadataBytes = 1024 * 1024
const maxWorksheetBytes = 32 * 1024 * 1024
const maxStringPartBytes = 16 * 1024 * 1024
const maxTextChars = 16 * 1024 * 1024
const maxStrings = 400_000
const maxCells = 1_000_000
const maxStoredRows = 150_000
const maxSheets = 128
const relationshipUris = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
])
const spreadsheetUris = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
])

interface XmlHandlers {
  open?(tag: QualifiedTag, path: readonly string[]): void
  text?(text: string, path: readonly string[]): void
  close?(tag: string, path: readonly string[]): void
}

function readXml(bytes: Buffer, root: string, handlers: XmlHandlers) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  const decoder = new TextDecoder(encoding, { fatal: true })
  const options = { xmlns: true, strictEntities: true }
  const sax = parser(true, options)
  const path: string[] = []
  let seenRoot = false
  sax.ondoctype = () => { throw new Error('Workbook XML cannot contain a document type declaration.') }
  sax.onerror = () => { throw new Error('Workbook contains malformed ' + root + ' XML.') }
  sax.onopentag = (tag) => {
    if (!('local' in tag)) throw new Error('Workbook XML namespace data is unavailable.')
    if (path.length === 0) {
      if (seenRoot || tag.local !== root || (root !== 'Relationships' && !spreadsheetUris.has(tag.uri))) {
        throw new Error('Workbook has an unexpected ' + root + ' XML part.')
      }
      seenRoot = true
    }
    if (path.length >= 64) throw new Error('Workbook XML exceeds the preview nesting limit.')
    path.push(tag.local)
    handlers.open?.(tag, path)
  }
  sax.onclosetag = () => {
    const tag = path.pop()
    if (tag) handlers.close?.(tag, path)
  }
  sax.ontext = sax.oncdata = (text) => handlers.text?.(text, path)
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    sax.write(decoder.decode(bytes.subarray(offset, offset + 64 * 1024), { stream: true }))
  }
  sax.write(decoder.decode()).close()
  if (!seenRoot) throw new Error('Workbook has an empty ' + root + ' XML part.')
}

function attr(tag: QualifiedTag, name: string): string | undefined {
  return tag.attributes[name]?.value
}

function resolvePart(source: string, target: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(target)
  } catch {
    return undefined
  }
  if (!decoded || decoded.length > 512 || /[\\:#?\0]/.test(decoded)) return undefined
  const name = decoded.startsWith('/') ? posix.normalize(decoded.slice(1)) : posix.join(posix.dirname(source), decoded)
  return name !== '..' && !name.startsWith('../') && !name.startsWith('/') ? name : undefined
}

interface Relationship { type: string; part: string }

function relationships(bytes: Buffer, source: string): Map<string, Relationship> {
  const result = new Map<string, Relationship>()
  readXml(bytes, 'Relationships', {
    open(tag, path) {
      if (path.length !== 2 || tag.local !== 'Relationship') return
      const id = attr(tag, 'Id')
      const target = attr(tag, 'Target')
      const type = attr(tag, 'Type')
      const mode = attr(tag, 'TargetMode')
      if (!id || !type || !target || (mode && mode !== 'Internal')) return
      const part = resolvePart(source, target)
      if (part) result.set(id, { type, part })
    },
  })
  return result
}

interface Worksheet extends TableSheet { part: string }

function worksheets(bytes: Buffer, parts: ReadonlyMap<string, Relationship>): Worksheet[] {
  const sheets: Worksheet[] = []
  readXml(bytes, 'workbook', {
    open(tag, path) {
      if (path.length !== 3 || path[1] !== 'sheets' || tag.local !== 'sheet') return
      const relationship = Object.values(tag.attributes).find((item) => item.local === 'id' && relationshipUris.has(item.uri))?.value
      const part = relationship && parts.get(relationship)
      if (!part || !part.type.endsWith('/worksheet')) return
      if (sheets.length >= maxSheets) throw new Error('Workbook exceeds the preview limit of 128 worksheets.')
      const index = sheets.length + 1
      sheets.push({ id: 'sheet-' + index, name: trimCell(attr(tag, 'name') || 'Sheet ' + index, 128), part: part.part })
    },
  })
  if (!sheets.length) throw new Error('No readable worksheets were found in this workbook.')
  return sheets
}

function append(value: string, text: string): string {
  // Keep one extra character so the preview can distinguish a truncated value.
  return value.length > maxCellLength ? value : value + text.slice(0, maxCellLength + 1 - value.length)
}

function sharedStrings(bytes: Buffer): string[] {
  const values: string[] = []
  let text = ''
  let chars = 0
  readXml(bytes, 'sst', {
    open(tag, path) {
      if (path.length === 2 && tag.local === 'si') text = ''
    },
    text(value, path) {
      if (path[1] === 'si' && ((path.length === 3 && path[2] === 't')
        || (path.length === 4 && path[2] === 'r' && path[3] === 't'))) {
        text = append(text, value)
      }
    },
    close(tag, path) {
      if (tag !== 'si' || path.length !== 1) return
      const value = trimCell(text)
      chars += value.length
      if (values.length >= maxStrings || chars > maxTextChars) throw new Error('Workbook shared text exceeds the preview limit.')
      values.push(value)
    },
  })
  return values
}

interface Cell {
  row: number
  column: number
  kind: string | undefined
  text: string
  formula: boolean
}

function positiveInteger(value: string | undefined, limit: number): number {
  if (!value || !/^\d{1,7}$/.test(value)) throw new Error('Workbook contains an invalid cell address.')
  const number = Number(value)
  if (number < 1 || number > limit) throw new Error('Workbook contains an invalid cell address.')
  return number
}

function cellAddress(address: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})(\d{1,7})$/.exec(address)
  if (!match) throw new Error('Workbook contains an invalid cell address.')
  let column = 0
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64
  if (column > maxTableColumns) throw new Error('Workbook contains an invalid column address.')
  return { row: positiveInteger(match[2], maxTableRows) - 1, column: column - 1 }
}

function cellText(cell: Cell, strings: readonly string[]): string {
  if (cell.formula && !cell.text) return '[No cached formula value]'
  if (cell.kind === 's') {
    return /^\d{1,7}$/.test(cell.text) ? strings[Number(cell.text)] ?? '[Invalid shared string]' : '[Invalid shared string]'
  }
  if (cell.kind === 'b') {
    if (cell.text === '1') return 'TRUE'
    if (cell.text === '0') return 'FALSE'
  }
  return trimCell(cell.text)
}

function parseSheet(bytes: Buffer, strings: readonly string[]): TableGrid {
  let rows = new Map<number, Map<number, string>>()
  let rowCount = 0
  let columnCount = 0
  let row = -1
  let column = -1
  let count = 0
  let chars = 0
  let current: Cell | undefined
  let lastStoredRow = -1
  let lastStoredColumn = -1
  let unordered = false
  readXml(bytes, 'worksheet', {
    open(tag, path) {
      if (path[1] !== 'sheetData' || path[2] !== 'row') return
      if (path.length === 3) {
        const explicit = attr(tag, 'r')
        row = explicit ? positiveInteger(explicit, maxTableRows) - 1 : row + 1
        column = -1
      } else if (path[3] === 'c') {
        if (path.length === 4) {
          if (++count > maxCells) throw new Error('Worksheet exceeds the preview limit of 1,000,000 cells.')
          const address = attr(tag, 'r')
          const position = address ? cellAddress(address) : { row, column: column + 1 }
          column = position.column
          if (column >= maxTableColumns || position.row >= maxTableRows) throw new Error('Worksheet exceeds the preview grid size.')
          current = { ...position, kind: attr(tag, 't'), text: '', formula: false }
        } else if (path.length === 5 && tag.local === 'f' && current) current.formula = true
      }
    },
    text(text, path) {
      if (!current) return
      const value = path.length === 5 && path[4] === 'v'
      const inline = path[4] === 'is' && ((path.length === 6 && path[5] === 't')
        || (path.length === 7 && path[5] === 'r' && path[6] === 't'))
      if (value || inline) current.text = append(current.text, text)
    },
    close(tag, path) {
      if (!current || tag !== 'c' || path.length !== 3) return
      const cell = current
      current = undefined
      const value = cellText(cell, strings)
      if (!value) return
      // Shared strings are stored once. Referencing the same string does not duplicate it in memory.
      if (cell.kind !== 's') chars += value.length
      if (chars > maxTextChars) throw new Error('Worksheet contains too much text for the preview.')
      if (cell.row < lastStoredRow || (cell.row === lastStoredRow && cell.column < lastStoredColumn)) unordered = true
      lastStoredRow = cell.row
      lastStoredColumn = cell.column
      let entries = rows.get(cell.row)
      if (!entries) {
        if (rows.size >= maxStoredRows) throw new Error('Worksheet exceeds the preview limit of 150,000 populated rows.')
        entries = new Map()
        rows.set(cell.row, entries)
      }
      entries.set(cell.column, value)
      rowCount = Math.max(rowCount, cell.row + 1)
      columnCount = Math.max(columnCount, cell.column + 1)
    },
  })
  if (unordered) {
    if (count > 100_000) throw new Error('Worksheet cell order is unsupported at this size.')
    rows = new Map([...rows.entries()].sort(([left], [right]) => left - right))
    for (const [index, entries] of rows) {
      rows.set(index, new Map([...entries.entries()].sort(([left], [right]) => left - right)))
    }
  }
  return { rows, rowCount, columnCount }
}

export async function openWorkbook(file: string): Promise<TableDocument> {
  const archive = await openZip(file)
  try {
    const root = archive.has('_rels/.rels')
      ? relationships(await archive.read('_rels/.rels', maxMetadataBytes), '') : new Map<string, Relationship>()
    const workbookPart = Array.from(root.values()).find(({ type }) => type.endsWith('/officeDocument'))?.part ?? 'xl/workbook.xml'
    const relsPart = posix.join(posix.dirname(workbookPart), '_rels', posix.basename(workbookPart) + '.rels')
    const parts = relationships(await archive.read(relsPart, maxMetadataBytes), workbookPart)
    const sheets = worksheets(await archive.read(workbookPart, maxMetadataBytes), parts)
    const stringsPart = Array.from(parts.values()).find(({ type }) => type.endsWith('/sharedStrings'))?.part
    let strings: readonly string[] | undefined
    let active: { id: string; grid: TableGrid } | undefined
    let closed = false
    let pending = Promise.resolve()

    function withSheet<T>(sheetId: string, use: (grid: TableGrid) => T): Promise<T> {
      const sheet = sheets.find(({ id }) => id === sheetId)
      if (!sheet) return Promise.reject(new Error('This worksheet is unavailable.'))
      const result = pending.then(async () => {
        if (closed) throw new Error('This workbook has closed.')
        if (active?.id === sheet.id) return use(active.grid)
        active = undefined
        if (!strings) {
          strings = stringsPart ? sharedStrings(await archive.read(stringsPart, maxStringPartBytes)) : []
        }
        const data = await archive.read(sheet.part, maxWorksheetBytes)
        if (closed) throw new Error('This workbook has closed.')
        const grid = parseSheet(data, strings)
        active = { id: sheet.id, grid }
        return use(grid)
      })
      pending = result.then(() => undefined, () => undefined)
      return result
    }

    return {
      sheets: sheets.map(({ id, name }) => ({ id, name })),
      async page(sheetId, rowOffset, columnOffset, rowLimit, columnLimit) {
        checkPage(rowOffset, columnOffset, rowLimit, columnLimit)
        return withSheet(sheetId, (grid) => gridPage(grid, rowOffset, columnOffset, rowLimit, columnLimit))
      },
      async search(sheetId, query, after) {
        checkSearch(query, after)
        return withSheet(sheetId, (grid) => gridSearch(grid, query, after))
      },
      close() {
        closed = true
        active = undefined
        strings = undefined
        archive.close()
      },
    }
  } catch (error) {
    archive.close()
    throw error
  }
}
