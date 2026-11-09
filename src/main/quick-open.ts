import { opendir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Entry, QuickOpenResult } from '../shared/contracts'
import type { WorkspaceFiles } from './files'

const visitLimit = 5000
const resultLimit = 40
const depthLimit = 12
const ignoredDirectories = new Set(['node_modules', '__pycache__', 'dist', 'target', 'build'])
const temporaryEntry = /^\.ion-[a-f0-9-]{36}\.tmp$/

export function quickOpenQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || value.includes('\0')) {
    throw new Error('Invalid Quick Open search.')
  }
  return value.trim().normalize('NFC').toLowerCase()
}

export async function searchWorkspace(
  scope: WorkspaceFiles, root: string, query: string, signal: AbortSignal,
): Promise<QuickOpenResult> {
  const words = query.split(/\s+/)
  const pending = [{ path: root, depth: 0 }]
  const matches: Array<{ entry: Entry; score: number; relativePath: string }> = []
  let seen = 0
  let truncated = false
  for (let index = 0; index < pending.length; index += 1) {
    signal.throwIfAborted()
    if (scope.rootPath !== root) throw new Error('The workspace changed during Quick Open.')
    const { path, depth } = pending[index]
    const valid = await scope.inspect(path, 'folder').catch((error: unknown) => {
      if (index === 0) throw error
    })
    if (!valid) continue
    const directory = await opendir(valid.path).catch((error: unknown) => {
      if (index === 0) throw error
    })
    if (!directory) continue
    for await (const item of directory) {
      signal.throwIfAborted()
      if (++seen > visitLimit) {
        truncated = true
        break
      }
      const child = join(path, item.name)
      if (item.isDirectory() && !item.name.startsWith('.') && !ignoredDirectories.has(item.name)) {
        if (depth < depthLimit) pending.push({ path: child, depth: depth + 1 })
        else truncated = true
      }
      if (!item.isFile() || temporaryEntry.test(item.name)) continue
      const relativePath = relative(root, child)
      const name = item.name.normalize('NFC').toLowerCase()
      const normalized = relativePath.normalize('NFC').toLowerCase()
      if (!words.every((word) => normalized.includes(word))) continue
      const score = name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : 3
      matches.push({ entry: { kind: 'file', name: item.name, path: child }, score, relativePath })
    }
    if (seen > visitLimit) break
  }
  signal.throwIfAborted()
  if (scope.rootPath !== root) throw new Error('The workspace changed during Quick Open.')
  matches.sort((left, right) => left.score - right.score || left.relativePath.localeCompare(right.relativePath))
  return { entries: matches.slice(0, resultLimit).map(({ entry }) => entry), truncated: truncated || matches.length > resultLimit }
}
