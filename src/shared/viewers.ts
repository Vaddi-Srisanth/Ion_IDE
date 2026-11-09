export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv'

const formats = new Set<DocumentFormat>(['pdf', 'docx', 'pptx', 'xlsx', 'csv'])

export function documentFormat(name: string): DocumentFormat | undefined {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase() as DocumentFormat
  return name.includes('.') && formats.has(extension) ? extension : undefined
}

export interface PagedViewerSession {
  id: string
  format: 'pdf' | 'pptx'
  byteLength: number
}

export interface TableSheet {
  id: string
  name: string
}

export interface TableViewerSession {
  id: string
  format: 'csv' | 'xlsx'
  sheets: TableSheet[]
}

export interface TablePage {
  rowCount: number
  columnCount: number
  rowOffset: number
  columnOffset: number
  cells: string[][]
}

export interface TableMatch {
  row: number
  column: number
}

export interface WordViewerSession {
  id: string
  format: 'docx'
}

export interface WordRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export interface WordParagraph {
  kind: 'paragraph'
  heading?: number
  runs: WordRun[]
}

export type WordBlock = WordParagraph
  | { kind: 'table'; rows: WordParagraph[][][] }
  | { kind: 'image'; id: string; alt: string; width?: number; height?: number }

export interface WordPage {
  blocks: WordBlock[]
  pageCount: number
  unsupported: boolean
}

export interface WordImage {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
}

export type ViewerSession = PagedViewerSession | TableViewerSession | WordViewerSession

export interface ViewerBridge {
  open(path: string, requestId: string): Promise<ViewerSession>
  close(id: string): Promise<void>
  cancel(requestId: string): Promise<void>
  openExternal(path: string): Promise<void>
  readPdf(id: string, offset: number, length: number): Promise<Uint8Array>
  tablePage(id: string, sheetId: string, rowOffset: number, columnOffset: number, rowLimit: number, columnLimit: number): Promise<TablePage>
  tableSearch(id: string, sheetId: string, query: string, after?: TableMatch): Promise<TableMatch | null>
  wordPage(id: string, page: number): Promise<WordPage>
  wordImage(id: string, imageId: string): Promise<WordImage>
}
