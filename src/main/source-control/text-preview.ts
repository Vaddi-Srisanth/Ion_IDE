import { createHash } from 'node:crypto'
import { gitObjectId } from './commit'
import { git, type Repository, UnavailableDiff } from './repository'

export const textLimit = 256 * 1024

export function checkLines(text: string): void {
  let offset = -1
  for (let line = 1; line <= 12_000; line++) {
    offset = text.indexOf('\n', offset + 1)
    if (offset < 0) return
  }
  throw new UnavailableDiff('This file exceeds the 12,000-line preview limit.')
}

export async function blob(repository: Repository, signal: AbortSignal, mode?: string, object?: string, run: typeof git = git): Promise<string> {
  if (!mode || mode === '000000') return ''
  if (!/^100[0-7]{3}$/.test(mode)) throw new UnavailableDiff('Symlinks and Git links do not have a text preview.')
  if (!object || !gitObjectId.test(object)) throw new Error('Git returned an invalid object identifier.')
  const { text, complete } = await run(repository, signal, ['cat-file', 'blob', object], { limit: textLimit })
  if (!complete) throw new UnavailableDiff('Git object output was incomplete. Refresh before opening the preview.')
  if (text.includes('\0')) throw new UnavailableDiff('This Git object is binary and has no text preview.')
  // Verify the decoded bytes against the exact indexed object. This also distinguishes invalid UTF-8
  // replaced by the process decoder from a valid file that actually contains the replacement character.
  const hash = createHash(object.length === 40 ? 'sha1' : 'sha256')
  hash.update(`blob ${Buffer.byteLength(text)}\0`).update(text)
  if (hash.digest('hex') !== object) throw new UnavailableDiff('The indexed object could not be read as complete UTF-8 text.')
  return text
}
