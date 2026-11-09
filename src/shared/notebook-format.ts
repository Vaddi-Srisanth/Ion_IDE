import { maxNotebookBytes } from './notebook-path'

export type NotebookMultiline = string | string[]

export interface NotebookOutput extends Record<string, unknown> {
  output_type: string
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
  execution_count?: number | null
  name?: string
  text?: NotebookMultiline
  ename?: string
  evalue?: string
  traceback?: string[]
}

export interface NotebookCell extends Record<string, unknown> {
  cell_type: string
  id?: string
  metadata: Record<string, unknown>
  source?: NotebookMultiline
  execution_count?: number | null
  outputs?: NotebookOutput[]
  attachments?: Record<string, Record<string, unknown>>
}

export interface NotebookDocument extends Record<string, unknown> {
  nbformat: 4
  nbformat_minor: number
  metadata: Record<string, unknown>
  cells: NotebookCell[]
}

export const maxNotebookCells = 10_000
const maxDepth = 64
const maxStructure = 500_000
const invalidIdCharacter = /[^A-Za-z0-9_-]/

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((part) => typeof part === 'string')
}

function multiline(value: unknown): value is NotebookMultiline {
  return typeof value === 'string' || strings(value)
}

/** Normalize an nbformat multiline value for display without joining unused large segments. */
export function notebookText(value: unknown, limit = Infinity): string | undefined {
  if (typeof value === 'string') return value.slice(0, limit)
  if (!strings(value)) return undefined
  if (limit === Infinity) return value.join('')
  const pieces: string[] = []
  let remaining = limit
  for (const part of value) {
    if (remaining <= 0) break
    pieces.push(part.slice(0, remaining))
    remaining -= part.length
  }
  return pieces.join('')
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function executionCount(value: unknown): value is number | null {
  return value === null || nonnegativeInteger(value)
}

function validOutput(value: unknown): value is NotebookOutput {
  if (!record(value) || typeof value.output_type !== 'string' || !value.output_type) return false
  switch (value.output_type) {
    case 'stream': return typeof value.name === 'string' && multiline(value.text)
    case 'error': return typeof value.ename === 'string' && typeof value.evalue === 'string' && strings(value.traceback)
    case 'display_data': return record(value.data) && record(value.metadata)
    case 'execute_result': return record(value.data) && record(value.metadata) && executionCount(value.execution_count)
    default: return true
  }
}

function validateCell(value: unknown, index: number, ids: Set<string>): asserts value is NotebookCell {
  const error = (reason: string) => new Error(`Invalid notebook cell ${index + 1}. ${reason}`)
  if (!record(value) || typeof value.cell_type !== 'string' || !value.cell_type || !record(value.metadata)) {
    throw error('Expected a cell type and metadata object.')
  }
  if (value.id !== undefined) {
    if (typeof value.id !== 'string' || !value.id || value.id.length > 64 || invalidIdCharacter.test(value.id)) {
      throw error('Invalid cell ID.')
    }
    if (ids.has(value.id)) throw error('Duplicate cell ID.')
    ids.add(value.id)
  }
  if (value.cell_type === 'code' || value.cell_type === 'markdown' || value.cell_type === 'raw') {
    if (!multiline(value.source)) throw error('Expected source text.')
  }
  if (value.attachments !== undefined && (!record(value.attachments) || !Object.values(value.attachments).every(record))) {
    throw error('Expected an attachment MIME bundle.')
  }
  if (value.cell_type === 'code') {
    if (!executionCount(value.execution_count)) throw error('Invalid execution count.')
    if (!Array.isArray(value.outputs) || !value.outputs.every(validOutput)) throw error('Invalid saved outputs.')
  }
}

// Limit the amount of object material JSON.parse can allocate, even when the file fits the byte cap.
function checkBudget(text: string): void {
  const oversized = () => new Error(`The notebook exceeds the ${maxNotebookBytes / (1024 * 1024)} MiB file limit.`)
  if (text.length > maxNotebookBytes) throw oversized()
  const checkBytes = text.length > maxNotebookBytes / 3
  let bytes = 0
  let depth = 0
  let structure = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (checkBytes) {
      if (unit < 0x80) bytes += 1
      else if (unit < 0x800) bytes += 2
      else {
        const previous = text.charCodeAt(index - 1)
        bytes += unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? 1 : 3
      }
      if (bytes > maxNotebookBytes) throw oversized()
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (unit === 0x5c) escaped = true
      else if (unit === 0x22) quoted = false
      continue
    }
    if (unit === 0x22) {
      quoted = true
    } else if (unit === 0x5b || unit === 0x7b) {
      depth++
      structure++
      if (depth > maxDepth) throw new Error('The notebook JSON is nested too deeply.')
    } else if (unit === 0x5d || unit === 0x7d) {
      depth--
    } else if (unit === 0x2c || unit === 0x3a) {
      structure++
    }
    if (structure > maxStructure) throw new Error('The notebook JSON contains too many entries.')
  }
}

/** Validate the parts Ion uses while retaining every original field for later edits. */
export function parseNotebook(text: string): NotebookDocument {
  checkBudget(text)
  let value: unknown
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new Error('The notebook contains invalid JSON.')
  }
  if (!record(value)) throw new Error('Expected a Jupyter notebook JSON object.')
  if (value.nbformat !== 4) throw new Error('Unsupported notebook format. Ion opens Jupyter nbformat 4 notebooks.')
  if (!nonnegativeInteger(value.nbformat_minor) || !record(value.metadata) || !Array.isArray(value.cells)) {
    throw new Error('Invalid notebook structure. Expected a version, metadata object and cell list.')
  }
  if (value.cells.length > maxNotebookCells) throw new Error('The notebook has more than 10,000 cells.')
  const ids = new Set<string>()
  value.cells.forEach((cell: unknown, index: number) => validateCell(cell, index, ids))
  return value as NotebookDocument
}
