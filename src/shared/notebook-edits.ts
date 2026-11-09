import { maxNotebookCells, parseNotebook, type NotebookCell, type NotebookDocument, type NotebookOutput } from './notebook-format'

type CellType = 'code' | 'markdown' | 'raw'

interface Span { start: number; end: number }
interface Member extends Span { key: string; keyEnd: number; valueStart: number }
interface Layout { array: Span; cells: Span[] }

interface CellEntry {
  key: string
  cell: NotebookCell
  originalIndex?: number
  sourceWeight: number
  outputWeight: number
}

type Command =
  | { kind: 'replace'; index: number; before: CellEntry; after: CellEntry; typingAt?: number }
  | { kind: 'add' | 'delete'; index: number; entry: CellEntry }
  | { kind: 'move'; from: number; to: number }

const maxHistory = 64
const historyBudget = 4 * 1024 * 1024
const typingGroupMs = 700
const executionOutputTypes = new Set(['stream', 'error', 'display_data', 'execute_result', 'update_display_data'])

function knownType(type: string): type is CellType {
  return type === 'code' || type === 'markdown' || type === 'raw'
}

function sameSource(source: NotebookCell['source'], text: string): boolean {
  if (!Array.isArray(source)) return source === text
  let offset = 0
  for (const line of source) {
    if (!text.startsWith(line, offset)) return false
    offset += line.length
  }
  return offset === text.length
}

function whitespace(text: string, offset: number): number {
  while (text[offset] === ' ' || text[offset] === '\n' || text[offset] === '\r' || text[offset] === '\t') offset++
  return offset
}

// The document has already passed JSON.parse. Use offsets to retain raw, untouched values.
function stringEnd(text: string, start: number): number {
  let search = start + 1
  for (;;) {
    const quote = text.indexOf('"', search)
    if (quote < 0) throw new Error('Could not locate notebook text for saving.')
    let escapes = 0
    while (text[quote - escapes - 1] === '\\') escapes++
    if (escapes % 2 === 0) return quote + 1
    search = quote + 1
  }
}

function valueEnd(text: string, start: number): number {
  const first = text[start]
  if (first === '"') return stringEnd(text, start)
  if (first !== '[' && first !== '{') {
    let end = start
    while (end < text.length && !',]} \t\r\n'.includes(text[end])) end++
    return end
  }
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const symbol = text[index]
    if (symbol === '"') index = stringEnd(text, index) - 1
    else if (symbol === '[' || symbol === '{') depth++
    else if ((symbol === ']' || symbol === '}') && --depth === 0) return index + 1
  }
  throw new Error('Could not locate the end of a notebook value.')
}

function objectMembers(text: string, start: number): Member[] {
  const members: Member[] = []
  let offset = whitespace(text, start + 1)
  while (text[offset] !== '}') {
    const keyEnd = stringEnd(text, offset)
    const key: string = JSON.parse(text.slice(offset, keyEnd))
    const valueStart = whitespace(text, whitespace(text, keyEnd) + 1)
    const end = valueEnd(text, valueStart)
    members.push({ key, keyEnd, start: offset, end, valueStart })
    offset = whitespace(text, end)
    if (text[offset] !== ',') break
    offset = whitespace(text, offset + 1)
  }
  return members
}

function arrayEntries(text: string, array: Span): Span[] {
  const items: Span[] = []
  let offset = whitespace(text, array.start + 1)
  while (offset < array.end - 1) {
    const end = valueEnd(text, offset)
    items.push({ start: offset, end })
    offset = whitespace(text, end)
    if (text[offset] !== ',') break
    offset = whitespace(text, offset + 1)
  }
  return items
}

function notebookLayout(text: string, expected: number): Layout {
  const start = whitespace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0)
  const member = objectMembers(text, start).findLast(({ key }) => key === 'cells')
  if (!member || text[member.valueStart] !== '[') throw new Error('Could not locate the notebook cell list.')
  const array = { start: member.valueStart, end: member.end }
  const cells = arrayEntries(text, array)
  if (cells.length !== expected) throw new Error('The notebook cell list changed before saving.')
  return { array, cells }
}

function changedMember(text: string, member: Member, original: NotebookCell, cell: NotebookCell): string {
  const previous = original.outputs
  const next = cell.outputs
  if (member.key !== 'outputs' || !Array.isArray(previous) || !Array.isArray(next) || text[member.valueStart] !== '[') {
    return JSON.stringify(cell[member.key])
  }
  // Unsupported saved output entries are carried through a rerun verbatim.
  const items = arrayEntries(text, { start: member.valueStart, end: member.end })
  const originals = new Map(previous.map((output, index) => [output, items[index]]))
  return '[' + next.map((output) => {
    const span = originals.get(output)
    return span ? text.slice(span.start, span.end) : JSON.stringify(output)
  }).join(',') + ']'
}

function writeCell(text: string, span: Span, original: NotebookCell, cell: NotebookCell): string {
  if (cell === original) return text.slice(span.start, span.end)
  const changed = Object.keys(cell).filter((key) => !Object.hasOwn(original, key) || cell[key] !== original[key])
  const removed = Object.keys(original).some((key) => !Object.hasOwn(cell, key))
  if (!removed && !changed.length) return text.slice(span.start, span.end)

  const members = objectMembers(text, span.start)
  const last = new Map(members.map((member) => [member.key, member]))
  const changedKeys = new Set(changed)
  const first = members[0]
  const leading = text.slice(span.start, first.start)
  const trailing = text.slice(members.at(-1)!.end, span.end)
  const separator = members[1] ? text.slice(first.end, members[1].start) : ','
  const colon = text.slice(first.keyEnd, first.valueStart)
  const pieces = [leading]
  let previous: Member | undefined
  for (const [index, member] of members.entries()) {
    if (!Object.hasOwn(cell, member.key)) continue
    if (previous) pieces.push(previous === members[index - 1] ? text.slice(previous.end, member.start) : separator)
    pieces.push(changedKeys.has(member.key) && last.get(member.key) === member
      ? text.slice(member.start, member.valueStart) + changedMember(text, member, original, cell)
      : text.slice(member.start, member.end))
    previous = member
  }
  for (const key of changed) {
    if (last.has(key)) continue
    if (pieces.length > 1) pieces.push(separator)
    pieces.push(JSON.stringify(key) + colon + JSON.stringify(cell[key]))
  }
  return pieces.concat(trailing).join('')
}

function retainedWeight(entry: CellEntry): number {
  return entry.sourceWeight + entry.outputWeight
}

function commandWeight(command: Command): number {
  if (command.kind === 'replace') return retainedWeight(command.before) + retainedWeight(command.after)
  return command.kind === 'move' ? 0 : retainedWeight(command.entry)
}

/** An editor's working copy and undo history. Opening a notebook does not generate any new JSON. */
export class NotebookEdits {
  private readonly original: NotebookDocument
  private entries: CellEntry[]
  private sequence = 0
  private readonly past: Command[] = []
  private readonly future: Command[] = []
  private layout?: Layout
  private serialized?: string

  constructor(private readonly originalText: string, parsed = parseNotebook(originalText)) {
    this.original = parsed
    this.entries = parsed.cells.map((cell, originalIndex) => this.entry(cell, originalIndex))
  }

  get cells(): readonly Pick<CellEntry, 'key' | 'cell'>[] { return this.entries }
  get document(): NotebookDocument { return { ...this.original, cells: this.entries.map(({ cell }) => cell) } }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  private entry(cell: NotebookCell, originalIndex?: number): CellEntry {
    return { key: String(++this.sequence), cell, originalIndex, sourceWeight: 0, outputWeight: 0 }
  }

  private find(key: string): number { return this.entries.findIndex((entry) => entry.key === key) }

  private apply(command: Command, reverse = false): void {
    this.serialized = undefined
    if (command.kind === 'replace') {
      this.entries = this.entries.with(command.index, reverse ? command.before : command.after)
    } else if (command.kind === 'move') {
      const from = reverse ? command.to : command.from
      const to = reverse ? command.from : command.to
      const next = this.entries.slice()
      const [entry] = next.splice(from, 1)
      next.splice(to, 0, entry)
      this.entries = next
    } else {
      const insert = (command.kind === 'add') !== reverse
      this.entries = insert ? this.entries.toSpliced(command.index, 0, command.entry) : this.entries.toSpliced(command.index, 1)
    }
  }

  private commit(command: Command): void {
    this.apply(command)
    const previous = this.past.at(-1)
    if (!this.future.length && command.kind === 'replace' && command.typingAt !== undefined && previous?.kind === 'replace'
      && previous.typingAt !== undefined && previous.after === command.before && command.typingAt - previous.typingAt < typingGroupMs) {
      this.past[this.past.length - 1] = { ...command, before: previous.before }
    } else {
      this.past.push(command)
    }
    this.future.length = 0
    let total = this.past.reduce((weight, change) => weight + commandWeight(change), 0)
    // Retain at least the latest action, even when the edited source alone exceeds the history budget.
    while (this.past.length > 1 && (this.past.length > maxHistory || total > historyBudget)) {
      total -= commandWeight(this.past.shift()!)
    }
  }

  setSource(key: string, text: string): boolean {
    const index = this.find(key)
    const before = this.entries[index]
    if (!before || !knownType(before.cell.cell_type) || sameSource(before.cell.source, text)) return false
    const original = before.originalIndex === undefined ? undefined : this.original.cells[before.originalIndex]
    const restored = original && sameSource(original.source, text)
    // A single string remains valid nbformat and avoids thousands of new array elements for large edits.
    const source = restored ? original.source : Array.isArray(before.cell.source) && text.length <= 32 * 1024
      ? text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [] : text
    const after = { ...before, cell: { ...before.cell, source }, sourceWeight: restored ? 0 : text.length }
    this.commit({ kind: 'replace', index, before, after, typingAt: Date.now() })
    return true
  }

  addCell(type: CellType, afterKey?: string): string {
    if (this.entries.length >= maxNotebookCells) throw new Error('A notebook can contain up to 10,000 cells.')
    const after = afterKey === undefined ? -1 : this.find(afterKey)
    const index = after < 0 ? this.entries.length : after + 1
    const cell: NotebookCell = { cell_type: type, metadata: {}, source: [] }
    if (this.original.nbformat_minor >= 5) cell.id = crypto.randomUUID()
    if (type === 'code') {
      cell.execution_count = null
      cell.outputs = []
    }
    const entry = this.entry(cell)
    this.commit({ kind: 'add', index, entry })
    return entry.key
  }

  deleteCell(key: string): boolean {
    const index = this.find(key)
    if (index < 0) return false
    this.commit({ kind: 'delete', index, entry: this.entries[index] })
    return true
  }

  moveCell(key: string, direction: -1 | 1): boolean {
    const from = this.find(key)
    const to = from + direction
    if (from < 0 || to < 0 || to >= this.entries.length) return false
    this.commit({ kind: 'move', from, to })
    return true
  }

  conversionDropsData(key: string, type: CellType): boolean {
    const cell = this.entries[this.find(key)]?.cell
    if (!cell || cell.cell_type === type) return false
    return type === 'code' ? (!!cell.attachments && Object.keys(cell.attachments).length > 0)
      || Object.hasOwn(cell, 'outputs') || Object.hasOwn(cell, 'execution_count')
      : cell.cell_type === 'code' && (!!cell.outputs?.length || cell.execution_count != null)
  }

  setCellType(key: string, type: CellType, allowDiscard = false): boolean {
    const index = this.find(key)
    const before = this.entries[index]
    if (!before || !knownType(before.cell.cell_type) || before.cell.cell_type === type) return false
    if (!allowDiscard && this.conversionDropsData(key, type)) return false
    const cell = { ...before.cell, cell_type: type }
    if (type === 'code') {
      delete cell.attachments
      cell.execution_count = null
      cell.outputs = []
    } else if (before.cell.cell_type === 'code') {
      delete cell.execution_count
      delete cell.outputs
    }
    this.commit({ kind: 'replace', index, before, after: { ...before, cell, outputWeight: 0 } })
    return true
  }

  setExecution(key: string, count: number | null, outputs: NotebookOutput[]): boolean {
    const index = this.find(key)
    const before = this.entries[index]
    if (!before || before.cell.cell_type !== 'code') return false
    const opaque = before.cell.outputs?.filter(({ output_type }) => !executionOutputTypes.has(output_type)) ?? []
    const cell = { ...before.cell, execution_count: count, outputs: [...opaque, ...outputs] }
    const after = { ...before, cell, outputWeight: JSON.stringify(outputs).length }
    this.commit({ kind: 'replace', index, before, after })
    return true
  }

  undo(): boolean {
    const command = this.past.pop()
    if (!command) return false
    this.apply(command, true)
    this.future.push(command)
    return true
  }

  redo(): boolean {
    const command = this.future.pop()
    if (!command) return false
    this.apply(command)
    this.past.push(command)
    return true
  }

  serialize(): string {
    if (this.serialized !== undefined) return this.serialized
    if (this.entries.length === this.original.cells.length
      && this.entries.every(({ cell }, index) => cell === this.original.cells[index])) return this.originalText

    const text = this.originalText
    const { array, cells } = this.layout ??= notebookLayout(text, this.original.cells.length)
    const headEnd = cells[0]?.start ?? array.start + 1
    const tailStart = cells.at(-1)?.end ?? headEnd
    const indent = text.slice(array.start + 1, headEnd)
    const separator = cells[1] ? text.slice(cells[0].end, cells[1].start) : ',' + indent
    const pieces = [text.slice(0, headEnd)]
    for (const [index, entry] of this.entries.entries()) {
      if (index > 0) pieces.push(cells[index] ? text.slice(cells[index - 1].end, cells[index].start) : separator)
      const { cell, originalIndex } = entry
      pieces.push(originalIndex === undefined ? JSON.stringify(cell)
        : writeCell(text, cells[originalIndex], this.original.cells[originalIndex], cell))
    }
    pieces.push(text.slice(tailStart))
    this.serialized = pieces.join('')
    return this.serialized
  }
}
