import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { isWithin, maxFileBytes, workspaceRootLabel, type WorkspaceFiles } from './files'
import { isNotebookName } from '../shared/notebook-path'
import { documentFormat } from '../shared/viewers'
import { workspaceReplaceTextLimit, workspaceSearchQueryLimit, workspaceSearchResultLimit, type WorkspaceReplacePreview, type WorkspaceReplaceResult, type WorkspaceSearchFile, type WorkspaceSearchResult } from '../shared/workspace-search'

const outputLimit = 8 * 1024 * 1024
const deadlineMs = 8_000
const replaceReviewBytesLimit = 8 * 1024 * 1024
const generated = ['node_modules', 'dist', 'build', 'target', 'coverage', '__pycache__', 'vendor']
const documentExtensions = ['pdf', 'csv', 'docx', 'xlsx', 'pptx', 'ipynb']

export function workspaceSearchQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > workspaceSearchQueryLimit || /[\0\r\n\uD800-\uDFFF]/u.test(value)) {
    throw new Error('Enter a single line of text up to 200 characters.')
  }
  return value
}

export function workspaceReplacement(value: unknown): string {
  if (typeof value !== 'string' || value.length > workspaceReplaceTextLimit || Buffer.byteLength(value) > workspaceReplaceTextLimit
    || /[\0\uD800-\uDFFF]/u.test(value)) throw new Error('Enter replacement text up to 10,000 UTF-8 bytes.')
  return value
}

interface ReplaceFile { path: string; relativePath: string; revision: string; hash: string; text: string; replacements: number }

export class WorkspaceReplaceReview {
  private current?: { token: string; roots: string[]; expiresAt: number; files: ReplaceFile[] }

  constructor(private readonly executable: string, private readonly scope: WorkspaceFiles) {}

  clear() { this.current = undefined }

  async review(queryValue: unknown, replacementValue: unknown): Promise<WorkspaceReplacePreview> {
    const query = workspaceSearchQuery(queryValue)
    const replacement = workspaceReplacement(replacementValue)
    const roots = [...this.scope.rootPaths]
    if (!roots.length || !query) throw new Error('Enter text to find in the open workspace.')
    const results = await Promise.all(roots.map((root) => searchWorkspaceText(
      this.executable, this.scope, root, query, new AbortController().signal)))
    if (results.some((result) => result.limit || result.skipped)) {
      throw new Error('Refine the search before replacing; Ion must review every affected saved file.')
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped, 'giu')
    const files: ReplaceFile[] = []
    let retainedBytes = 0
    for (const [rootIndex, result] of results.entries()) for (const found of result.files) {
      const source = await this.scope.read(found.path)
      let replacements = 0
      const text = source.text.replace(pattern, () => { replacements++; return replacement })
      if (replacements) {
        retainedBytes += Buffer.byteLength(text)
        if (retainedBytes > replaceReviewBytesLimit) throw new Error('This replacement affects more than 8 MiB of text. Refine the search and review a smaller change.')
        files.push({ path: found.path, relativePath: roots.length > 1 ? `${workspaceRootLabel(roots, rootIndex)}/${found.relativePath}` : found.relativePath, revision: source.revision,
          hash: source.contentHash, text, replacements })
      }
    }
    if (roots.length !== this.scope.rootPaths.length || roots.some((root, index) => this.scope.rootPaths[index] !== root)) {
      throw new Error('The workspace changed during replace review.')
    }
    const state = this.current = { token: randomUUID(), roots, expiresAt: Date.now() + 120_000, files }
    return { token: state.token, expiresAt: state.expiresAt, replacements: files.reduce((sum, file) => sum + file.replacements, 0),
      files: files.map(({ path, relativePath, replacements }) => ({ path, relativePath, replacements })) }
  }

  async apply(tokenValue: unknown, pathsValue: unknown): Promise<WorkspaceReplaceResult> {
    const state = this.current
    this.current = undefined
    if (!state || typeof tokenValue !== 'string' || tokenValue !== state.token || Date.now() > state.expiresAt) {
      throw new Error('This replace review expired. Review the current files again.')
    }
    if (state.roots.length !== this.scope.rootPaths.length || state.roots.some((root, index) => this.scope.rootPaths[index] !== root)
      || !Array.isArray(pathsValue) || pathsValue.length > state.files.length
      || pathsValue.some(path => typeof path !== 'string')) throw new Error('The workspace or replace selection changed. Review again.')
    const selected = new Set(pathsValue)
    if (selected.size !== pathsValue.length || [...selected].some(path => !state.files.some(file => file.path === path))) {
      throw new Error('The replace selection is invalid. Review again.')
    }
    const result: WorkspaceReplaceResult = { applied: [], failed: [] }
    for (const file of state.files.filter(({ path }) => selected.has(path))) {
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

interface MatchMessage {
  type?: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    submatches?: { start?: number }[]
  }
}

function resultPreview(text: string, offset: number): string {
  const start = Math.max(0, offset - 50)
  const end = start + 220
  return (start > 0 ? '…' : '') + text.slice(start, end)
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '�') + (text.length > end ? '…' : '')
}

export async function searchWorkspaceText(
  executable: string, scope: WorkspaceFiles, root: string, query: string, signal: AbortSignal,
): Promise<WorkspaceSearchResult> {
  signal.throwIfAborted()
  const { path: directory } = await scope.inspect(root, 'folder')
  signal.throwIfAborted()
  if (!scope.rootPaths.includes(root)) throw new Error('The workspace changed during search.')
  const args = ['--no-config', '--json', '--fixed-strings', '--ignore-case', '--no-require-git',
    '--no-ignore-parent', '--no-ignore-global', '--no-ignore-exclude', '--no-follow', '--no-mmap',
    '--threads=2', '--encoding=none', '--max-filesize', String(maxFileBytes),
    ...generated.flatMap((name) => ['--glob', '!' + name]),
    ...documentExtensions.flatMap((name) => ['--iglob', '!*.' + name]),
    '-e', query, '--', '.']
  const child = spawn(executable, args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>
  void closed.catch(() => undefined)
  child.stderr.resume()

  let killTimer: NodeJS.Timeout | undefined
  const stop = () => {
    if (killTimer || child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    killTimer = setTimeout(() => child.kill('SIGKILL'), 250)
    killTimer.unref()
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()

  let limit: WorkspaceSearchResult['limit']
  const restrict = (reason: NonNullable<WorkspaceSearchResult['limit']>) => {
    limit ??= reason
    stop()
  }
  const timer = setTimeout(() => restrict('time'), deadlineMs)
  timer.unref()
  let bytes = 0
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > outputLimit) restrict('output')
  })

  const files = new Map<string, WorkspaceSearchFile>()
  let count = 0
  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (limit || signal.aborted || !scope.rootPaths.includes(root)) break
        const message: MatchMessage = JSON.parse(line)
        if (message.type !== 'match') continue
        const match = message.data
        const source = match?.path?.text
        const sourceLine = match?.lines?.text
        const number = match?.line_number
        const offset = match?.submatches?.[0]?.start
        if (typeof source !== 'string' || typeof sourceLine !== 'string' || sourceLine.includes('\0')
          || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1
          || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) continue

        const path = resolve(directory, source)
        if (!isWithin(root, path) || documentFormat(path) || isNotebookName(path)) continue
        let file = files.get(path)
        if (!file) {
          const valid = await scope.inspect(path, 'file').catch(() => undefined)
          if (!valid || valid.stats.size > BigInt(maxFileBytes)) continue
          file = { path, relativePath: relative(root, path), matches: [] }
        }
        if (count === workspaceSearchResultLimit) {
          restrict('matches')
          break
        }
        files.set(path, file)
        count++
        const text = sourceLine.replace(/\r?\n$/, '')
        // Ripgrep reports byte offsets. Monaco counts UTF-16 units and hides the BOM.
        const hasBom = number === 1 && text.startsWith('\uFEFF')
        const prefixLength = Buffer.from(text).subarray(0, offset).toString('utf8').length
        const column = Math.max(1, prefixLength + (hasBom ? 0 : 1))
        file.matches.push({ line: number, column, preview: resultPreview(hasBom ? text.slice(1) : text, column - 1) })
      }
    } finally {
      lines.close()
    }
    if (!scope.rootPaths.includes(root)) stop()
    const [code] = await closed
    signal.throwIfAborted()
    if (!scope.rootPaths.includes(root)) throw new Error('The workspace changed during search.')
    if (!limit && code !== 0 && code !== 1 && code !== 2) throw new Error('Workspace search stopped unexpectedly.')
    return {
      files: [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      limit,
      skipped: !limit && code === 2,
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
      throw new Error('Workspace search is unavailable. Reinstall Ion or rebuild its search tool.')
    }
    throw error
  } finally {
    stop()
    await closed.catch(() => undefined)
    clearTimeout(killTimer)
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}
