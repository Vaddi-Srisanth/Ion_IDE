import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import type { LanguageEditPreview, LanguageEditResult } from '../../shared/language-tools'
import { workspaceRootLabel, type WorkspaceFiles } from '../files'

const reviewLifetimeMs = 120_000
const retainedTextLimit = 8 * 1024 * 1024

interface PendingEdit {
  path: string
  relativePath: string
  revision: string
  hash: string
  text: string
  edits: number
}

interface TextEdit {
  start: number
  end: number
  text: string
}

function offsetAt(text: string, line: number, character: number) {
  let offset = 0
  for (let row = 0; row < line; row++) {
    const newline = text.indexOf('\n', offset)
    if (newline < 0) throw new Error('Language server edit points outside the current file.')
    offset = newline + 1
  }
  const newline = text.indexOf('\n', offset)
  const lineEnd = newline < 0 ? text.length : newline
  if (character > lineEnd - offset) throw new Error('Language server edit points outside the current line.')
  return offset + character
}

function number(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Language server returned an invalid edit range.')
  return parsed
}

/** Main-owned review state for inert LSP text edits. Language servers never
 * receive filesystem grants and never publish changes directly. */
export class LanguageWorkspaceEditReview {
  private current?: { token: string; roots: string[]; expiresAt: number; files: PendingEdit[] }

  constructor(private readonly scope: WorkspaceFiles) {}

  clear() { this.current = undefined }

  async review(rows: string[][], dirtyPaths: readonly string[]): Promise<LanguageEditPreview> {
    this.current = undefined
    const roots = [...this.scope.rootPaths]
    if (!roots.length || !rows.length) throw new Error('The language server did not return any workspace edits.')
    if (rows.length > 1_000 || dirtyPaths.length > 64 || dirtyPaths.some(path => typeof path !== 'string')) {
      throw new Error('Language server edit review exceeds Ion’s safety limits.')
    }
    const dirty = new Set<string>()
    for (const candidate of dirtyPaths) {
      const { path } = await this.scope.inspect(candidate, 'file')
      dirty.add(path)
    }
    const grouped = new Map<string, string[][]>()
    for (const row of rows) {
      if (row.length !== 6) throw new Error('Language server returned an invalid edit.')
      const [requested] = row
      const { path } = await this.scope.inspect(requested, 'file')
      if (dirty.has(path)) throw new Error('Save or discard modified files before applying a language-server rename.')
      const group = grouped.get(path) ?? []
      group.push(row)
      grouped.set(path, group)
    }
    let retainedBytes = 0
    const files: PendingEdit[] = []
    for (const [path, edits] of grouped) {
      const source = await this.scope.read(path)
      const parsed: TextEdit[] = edits.map(([, startLine, startCharacter, endLine, endCharacter, text]) => {
        const start = offsetAt(source.text, number(startLine), number(startCharacter))
        const end = offsetAt(source.text, number(endLine), number(endCharacter))
        if (end < start) throw new Error('Language server returned a reversed edit range.')
        return { start, end, text }
      }).sort((first, second) => second.start - first.start || second.end - first.end)
      for (let index = 1; index < parsed.length; index++) {
        if (parsed[index - 1].start < parsed[index].end) throw new Error('Language server returned overlapping edits.')
      }
      let text = source.text
      for (const edit of parsed) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
      retainedBytes += Buffer.byteLength(text)
      if (retainedBytes > retainedTextLimit) throw new Error('Language server edits retain more than 8 MiB. Review a smaller change.')
      const rootIndex = roots.findIndex(root => this.scope.rootFor(path) === root)
      if (rootIndex < 0) throw new Error('Language server edit targets a file outside the open workspace.')
      const relativePath = roots.length > 1 ? `${workspaceRootLabel(roots, rootIndex)}/${relative(roots[rootIndex], path)}`
        : relative(roots[rootIndex], path)
      files.push({ path, relativePath, revision: source.revision, hash: source.contentHash, text, edits: parsed.length })
    }
    if (roots.length !== this.scope.rootPaths.length || roots.some((root, index) => this.scope.rootPaths[index] !== root)) {
      throw new Error('The workspace changed during language-server edit review.')
    }
    const state = this.current = { token: randomUUID(), roots, expiresAt: Date.now() + reviewLifetimeMs, files }
    return { token: state.token, expiresAt: state.expiresAt,
      edits: files.reduce((total, file) => total + file.edits, 0),
      files: files.map(({ path, relativePath, edits }) => ({ path, relativePath, edits })) }
  }

  async apply(token: unknown): Promise<LanguageEditResult> {
    const state = this.current
    this.current = undefined
    if (!state || typeof token !== 'string' || token !== state.token || Date.now() > state.expiresAt) {
      throw new Error('This language-server edit review expired. Review the current files again.')
    }
    if (state.roots.length !== this.scope.rootPaths.length
      || state.roots.some((root, index) => this.scope.rootPaths[index] !== root)) {
      throw new Error('The workspace changed. Review the language-server edits again.')
    }
    const result: LanguageEditResult = { applied: [], failed: [] }
    for (const file of state.files) {
      try {
        await this.scope.save(file.path, file.text, file.revision, file.hash)
        result.applied.push(file.path)
      } catch (error) {
        result.failed.push({ path: file.path, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }
}
