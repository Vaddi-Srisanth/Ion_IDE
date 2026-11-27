import type { SourceControlConflict } from '../../shared/source-control'
import { gitObjectId } from './commit'
import { git, type Repository } from './repository'
import type { StatusEntry } from './status'
import { blob, checkLines } from './text-preview'

export async function readConflict(repository: Repository, entry: StatusEntry, signal: AbortSignal, run: typeof git): Promise<SourceControlConflict> {
  const { stages, path, absolutePath } = entry
  if (!entry.unmerged || !stages) throw new Error('Refresh to review the current merge conflict.')
  const expected = stages.map(({ mode, oid }, index) => {
    if (!gitObjectId.test(oid) || oid.length !== stages[0].oid.length || /^0+$/.test(oid) !== (mode === '000000')) {
      throw new Error('Git returned invalid conflict stage metadata.')
    }
    if (mode === '000000') return ''
    if (mode !== '100644' && mode !== '100755') throw new Error('Only regular files have a text conflict preview.')
    return `${mode} ${oid} ${index + 1}\t${path}\0`
  }).join('')
  if (!expected) throw new Error('Git returned a conflict without any index stages.')
  const verifyStages = async () => {
    const { text, complete } = await run(repository, signal, ['ls-files', '--unmerged', '-z', '--', path], { limit: 64 * 1024 })
    if (!complete || text !== expected) throw new Error('The conflict stages changed or could not be verified. Refresh before reviewing.')
  }
  await verifyStages()
  const contents: Array<string | null> = []
  for (const { mode, oid } of stages) {
    signal.throwIfAborted()
    if (mode === '000000') { contents.push(null); continue }
    const text = await blob(repository, signal, mode, oid, run)
    checkLines(text)
    contents.push(text)
  }
  await verifyStages()
  return { path, absolutePath, base: contents[0], ours: contents[1], theirs: contents[2] }
}
