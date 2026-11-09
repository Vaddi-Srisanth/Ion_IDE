import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { isWithin, maxFileBytes, type WorkspaceFiles } from './files'
import { isNotebookName } from '../shared/notebook-path'
import { documentFormat } from '../shared/viewers'
import { workspaceSearchQueryLimit, workspaceSearchResultLimit, type WorkspaceSearchFile, type WorkspaceSearchResult } from '../shared/workspace-search'

const outputLimit = 8 * 1024 * 1024
const deadlineMs = 8_000
const generated = ['node_modules', 'dist', 'build', 'target', 'coverage', '__pycache__', 'vendor']
const documentExtensions = ['pdf', 'csv', 'docx', 'xlsx', 'pptx', 'ipynb']

export function workspaceSearchQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > workspaceSearchQueryLimit || /[\0\r\n\uD800-\uDFFF]/u.test(value)) {
    throw new Error('Enter a single line of text up to 200 characters.')
  }
  return value
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
  if (scope.rootPath !== root) throw new Error('The workspace changed during search.')
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
        if (limit || signal.aborted || scope.rootPath !== root) break
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
    if (scope.rootPath !== root) stop()
    const [code] = await closed
    signal.throwIfAborted()
    if (scope.rootPath !== root) throw new Error('The workspace changed during search.')
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
