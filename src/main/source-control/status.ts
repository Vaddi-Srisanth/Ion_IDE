import { isAbsolute, join } from 'node:path'
import type { GitStatusCode, SourceControlEntry } from '../../shared/source-control'

const codes = new Set(['M', 'A', 'D', 'R', 'C', 'T', 'U', '?'])
const entryLimit = 500

export interface StatusEntry extends SourceControlEntry {
  headMode?: string
  indexMode?: string
  headObject?: string
  indexObject?: string
}

export function safeGitPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !/[\0\uFFFD]/.test(path)
    && path.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'
      && (process.platform !== 'win32' || !/[\\:<>|"*?]|[. ]$/u.test(part)
        && !/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu.test(part)))
}

function code(value: string): GitStatusCode {
  return codes.has(value) ? value as GitStatusCode : ''
}

function splitRecord(record: string, fields: number): string[] {
  const parts: string[] = []
  let start = 0
  for (let index = 0; index < fields; index++) {
    const stop = record.indexOf(' ', start)
    if (stop < 0) return []
    parts.push(record.slice(start, stop))
    start = stop + 1
  }
  parts.push(record.slice(start))
  return parts
}

/** Git porcelain v2 uses NUL delimiters and emits the original path of a rename
 * as its next field. Preserve spaces, newlines and leading dashes literally. */
export function parseStatus(root: string, output: string, complete: boolean) {
  let branch = ''
  let head = ''
  let truncated = !complete
  const entries = new Map<string, StatusEntry>()
  const records = output.split('\0')
  records.pop() // A capped stream can end with a partial record.
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record.startsWith('# branch.head ')) { branch = record.slice(14); continue }
    if (record.startsWith('# branch.oid ')) { head = record.slice(13); continue }
    if (record.startsWith('# ')) continue
    if (entries.size >= entryLimit) { truncated = true; break }
    const type = record[0]
    if (type === '?') {
      const path = record.slice(2)
      if (path.endsWith('/')) continue // Git collapses an embedded repository to its directory.
      if (!safeGitPath(path)) { truncated = true; continue }
      entries.set(path, { path, absolutePath: join(root, path), index: '', worktree: '?', unmerged: false })
      continue
    }
    const fields = type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : 0
    if (!fields) continue
    const parts = splitRecord(record, fields)
    const path = parts[fields]
    const previousPath = type === '2' ? records[++i] : undefined
    if (!path || !safeGitPath(path) || type === '2' && (!previousPath || !safeGitPath(previousPath))) {
      truncated = true
      continue
    }
    const [index, worktree] = parts[1]
    entries.set(path, { path, absolutePath: join(root, path), previousPath, index: code(index), worktree: code(worktree),
      unmerged: type === 'u',
      ...(type === 'u' ? {} : { headMode: parts[3], indexMode: parts[4], headObject: parts[6], indexObject: parts[7] }),
    })
  }
  const detached = branch === '(detached)'
  return { entries, branch: detached ? head.slice(0, 10) || 'Detached HEAD' : branch,
    head, detached, unborn: head === '(initial)', truncated }
}

export type ParsedStatus = ReturnType<typeof parseStatus>
