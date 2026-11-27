import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceControlBlame } from '../../shared/source-control'
import { revision } from '../files'
import { gitObjectId } from './commit'
import { git, readTextFile, type Repository } from './repository'
import { blob, checkLines, textLimit } from './text-preview'

const rangeLimit = 200
type Range = SourceControlBlame['ranges'][number]
type Author = Pick<Range, 'author' | 'time' | 'subject'>

function rangesFrom(output: string, lines: number, oidLength: number) {
  const ranges: Range[] = [], commits = new Map<string, Author>()
  const rows = output.split('\n')
  const invalid = () => new Error('Git returned incomplete blame metadata.')
  if (rows.pop() !== '') throw invalid()
  let truncated = false
  const label = (value: string, max: number) => {
    if (value.length > max) truncated = true
    return value.slice(0, max).replace(/[\ud800-\udbff]$/, '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  }
  // Incremental output omits source lines and repeats commit metadata only on first occurrence.
  // Its hunks arrive in history traversal order, not source order.
  for (let i = 0; i < rows.length;) {
    const header = /^([a-f0-9]+) ([1-9]\d*) ([1-9]\d*) ([1-9]\d*)$/.exec(rows[i++])
    if (!header || header[1].length !== oidLength || /^0+$/.test(header[1])) throw invalid()
    const [, oid, , first, length] = header, start = Number(first), count = Number(length)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start + count - 1 > lines || ranges.length >= lines) throw invalid()
    let author: string | undefined, time: number | undefined, subject: string | undefined
    while (i < rows.length && !rows[i].startsWith('filename ')) {
      const row = rows[i++]
      if (row.startsWith('author ')) author = label(row.slice(7), 256)
      else if (row.startsWith('author-time ')) {
        const date = row.slice(12)
        if (!/^-?\d+$/.test(date) || !Number.isSafeInteger(Number(date))) throw invalid()
        time = Number(date)
      } else if (row.startsWith('summary ')) subject = label(row.slice(8), 512)
    }
    if (i === rows.length) throw invalid()
    i++ // Trust only the selected repository-relative input path. Historical filenames stay private.
    if (author !== undefined || time !== undefined || subject !== undefined) {
      if (author === undefined || time === undefined || subject === undefined) throw invalid()
      commits.set(oid, { author, time, subject })
    }
    const commit = commits.get(oid)
    if (!commit) throw invalid()
    ranges.push({ start, count, oid, ...commit })
  }
  ranges.sort((a, b) => a.start - b.start)
  const ordered: Range[] = []
  let next = 1
  for (const range of ranges) {
    if (range.start !== next) throw invalid()
    next += range.count
    const last = ordered.at(-1)
    if (last?.oid === range.oid) last.count += range.count
    else ordered.push(range)
  }
  if (next !== lines + 1) throw invalid()
  return { ranges: ordered.slice(0, rangeLimit), truncated: truncated || ordered.length > rangeLimit }
}

export async function readBlame(repository: Repository, path: string, head: string, signal: AbortSignal, run: typeof git): Promise<SourceControlBlame> {
  if (!gitObjectId.test(head)) throw new Error('Commit this file before requesting blame.')
  const absolute = join(repository.root, path)
  const file = async () => {
    if (await realpath(absolute).catch(() => null) !== absolute) throw new Error('Blame requires an existing regular file without symbolic links.')
    const info = await lstat(absolute, { bigint: true })
    if (!info.isFile() || info.nlink !== 1n || info.size > textLimit) throw new Error('Blame requires a regular saved file up to 256 KiB.')
    return revision(info)
  }
  const call = async (args: string[], limit: number) => {
    signal.throwIfAborted()
    const { text, complete } = await run(repository, signal, args, { limit, timeout: 8000 })
    if (!complete) throw new Error('Git could not provide complete blame evidence within the limit.')
    return text
  }
  const verifyHead = async () => {
    if ((await call(['rev-parse', '--verify', 'HEAD'], 128)).trim() !== head) throw new Error('HEAD changed. Refresh before requesting blame.')
  }
  const readIndex = () => call(['ls-files', '--stage', '-z', '--', path], 16384)
  await verifyHead()
  const identity = await file()
  await readTextFile(absolute, textLimit, identity)
  const index = await readIndex()
  const suffix = '\t' + path + '\0'
  if (!index.endsWith(suffix) || !/^100(?:644|755) (?:[0-9a-f]{40}|[0-9a-f]{64}) 0$/.test(index.slice(0, -suffix.length))) {
    throw new Error('Blame requires a tracked, regular file with a resolved index entry.')
  }
  const tree = await call(['ls-tree', '-z', head, '--', path], 16384)
  const entry = tree.endsWith(suffix) && /^(100644|100755) blob ([a-f0-9]+)$/.exec(tree.slice(0, -suffix.length))
  if (!entry || entry[2].length !== head.length) throw new Error('This path has no regular committed file at HEAD.')
  const content = await blob(repository, signal, entry[1], entry[2], run)
  checkLines(content)
  const lineCount = content ? content.split('\n').length - Number(content.endsWith('\n')) : 0
  const metadata = lineCount ? await call(['blame', '--incremental', '--root', '--no-progress', '--no-ext-diff', '--no-textconv',
    '--ignore-revs-file', '', head, '--', path], 2 * 1024 * 1024) : ''
  const result = rangesFrom(metadata, lineCount, head.length)
  if (identity !== await file() || index !== await readIndex()) throw new Error('The selected file or index changed during blame. Refresh to try again.')
  await verifyHead()
  signal.throwIfAborted()
  return { path, head, ...result }
}
