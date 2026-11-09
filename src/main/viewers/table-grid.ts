import type { TableMatch, TablePage, TableSheet } from '../../shared/viewers'

export const maxTableRows = 1_048_576
export const maxTableColumns = 16_384
export const maxPageRows = 80
export const maxPageColumns = 16
export const maxCellLength = 4_000
const maxPreviewLength = 512
const maxQueryLength = 160

export interface TableDocument {
  readonly sheets: readonly TableSheet[]
  page(sheetId: string, rowOffset: number, columnOffset: number, rowLimit: number, columnLimit: number): Promise<TablePage>
  search(sheetId: string, query: string, after?: TableMatch): Promise<TableMatch | null>
  close(): void
}

export interface TableGrid {
  rowCount: number
  columnCount: number
  rows: string[][] | Map<number, Map<number, string>>
}

export function trimCell(value: string, limit = maxCellLength): string {
  if (value.length <= limit) return value
  let end = limit - 1
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return value.slice(0, end) + '…'
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

export function checkPage(row: number, column: number, rows: number, columns: number): void {
  if (!integerIn(row, 0, maxTableRows - 1) || !integerIn(column, 0, maxTableColumns - 1)
    || !integerIn(rows, 1, maxPageRows) || !integerIn(columns, 1, maxPageColumns)) {
    throw new Error('Invalid table page range.')
  }
}

export function checkSearch(query: string, after?: TableMatch): void {
  if (typeof query !== 'string' || query.length === 0 || query.length > maxQueryLength) {
    throw new Error('Enter between 1 and 160 characters to find a cell.')
  }
  if (after !== undefined && (after === null || typeof after !== 'object'
    || !integerIn(after.row, 0, maxTableRows - 1) || !integerIn(after.column, 0, maxTableColumns - 1))) {
    throw new Error('Invalid table search position.')
  }
}

export function gridPage(grid: TableGrid, rowOffset: number, columnOffset: number, rowLimit: number, columnLimit: number): TablePage {
  const { rowCount, columnCount, rows } = grid
  const columns = Math.max(0, Math.min(columnLimit, columnCount - columnOffset))
  const length = Math.max(0, Math.min(rowLimit, rowCount - rowOffset))
  const cells = Array.from({ length }, (_, index) => {
    const row = Array.isArray(rows) ? rows[rowOffset + index] : rows.get(rowOffset + index)
    return Array.from({ length: columns }, (_, column) => {
      const value = Array.isArray(row) ? row[columnOffset + column] : row?.get(columnOffset + column)
      return trimCell(value ?? '', maxPreviewLength)
    })
  })
  return { rowCount, columnCount, rowOffset, columnOffset, cells }
}

export function gridSearch(grid: TableGrid, query: string, after?: TableMatch): TableMatch | null {
  const needle = query.toLowerCase()
  let first: TableMatch | null = null
  for (const [row, values] of grid.rows.entries()) {
    for (const [column, value] of values.entries()) {
      if (!value.toLowerCase().includes(needle)) continue
      if (!after || row > after.row || (row === after.row && column > after.column)) return { row, column }
      first ??= { row, column }
    }
  }
  return first
}
