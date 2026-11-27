import { lstat, mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absent, git, type Repository } from './repository'
import { safeGitPath, type ParsedStatus } from './status'

export const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const indexMode = /^(?:100644|100755|120000|160000)$/
const inProgress = ['MERGE_HEAD', 'MERGE_MSG', 'SQUASH_MSG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
  'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']

async function mergeState(repository: Repository, objectLength: number): Promise<{ parent?: string; markers: Map<string, Buffer> }> {
  const markers = new Map<string, Buffer>()
  for (const name of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE']) {
    const path = join(repository.directory, name)
    const info = await lstat(path).then(value => value, (error: unknown) => {
      if (absent(error)) return undefined
      throw error
    })
    if (!info) continue
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('Git merge metadata is not a safe regular file.')
    markers.set(name, await readFile(path))
  }
  let parent: string | undefined
  if (markers.has('MERGE_HEAD')) {
    const value = markers.get('MERGE_HEAD')!.toString('ascii').trim()
    if (!new RegExp('^[0-9a-f]{' + objectLength + '}$').test(value)) {
      throw new Error('Ion can commit only a single merge parent. Finish this merge in your terminal.')
    }
    parent = value
    if (!markers.has('MERGE_MSG')) throw new Error('Finish the active Git operation in your terminal; Git merge metadata is incomplete.')
  } else if (markers.has('MERGE_MSG') || markers.has('MERGE_MODE') || markers.has('AUTO_MERGE')) {
    throw new Error('Finish the active Git operation in your terminal; Git merge metadata is incomplete.')
  }
  for (const name of inProgress.filter(name => !['MERGE_HEAD', 'MERGE_MSG'].includes(name))) {
    const found = await lstat(join(repository.directory, name)).then(() => true, (error: unknown) => {
      if (absent(error)) return false
      throw error
    })
    if (found) throw new Error('Finish the active Git operation in your terminal before committing from Ion.')
  }
  return { parent, markers }
}

async function verifyMergeMetadata(repository: Repository, markers: Map<string, Buffer>): Promise<void> {
  for (const [name, expected] of markers) {
    const path = join(repository.directory, name)
    const info = await lstat(path).catch((error: unknown) => {
      if (absent(error)) return undefined
      throw error
    })
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('Git merge state changed. Refresh before committing.')
    if (!(await readFile(path)).equals(expected)) throw new Error('Git merge state changed. Refresh before committing.')
  }
}

async function clearMergeMetadata(repository: Repository, markers: Map<string, Buffer>): Promise<void> {
  for (const [name, expected] of markers) {
    try {
      const path = join(repository.directory, name)
      const info = await lstat(path)
      if (info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024 && (await readFile(path)).equals(expected)) await unlink(path)
    } catch { /* Keep changed metadata; the commit is already published. */ }
  }
}

function indexUpdates(status: ParsedStatus, objectLength: number): string {
  const removed: string[] = []
  const updated: string[] = []
  const zeros = '0'.repeat(objectLength)
  for (const entry of status.entries.values()) {
    if (!entry.index) continue
    if (!safeGitPath(entry.path)) throw new Error('Git returned an invalid staged path.')
    if (entry.index === 'D') {
      removed.push(`0 ${zeros}\t${entry.path}\0`)
      continue
    }
    if (entry.index === 'R') {
      if (!entry.previousPath || !safeGitPath(entry.previousPath)) throw new Error('Git returned an invalid rename.')
      removed.push(`0 ${zeros}\t${entry.previousPath}\0`)
    }
    if (!entry.indexMode || !indexMode.test(entry.indexMode) || !entry.indexObject
      || !gitObjectId.test(entry.indexObject) || entry.indexObject.length !== objectLength) {
      throw new Error('Git returned an invalid staged object.')
    }
    updated.push(`${entry.indexMode} ${entry.indexObject}\t${entry.path}\0`)
  }
  // File-to-directory changes and overlapping renames require removals first.
  return removed.join('') + updated.join('')
}

export async function commitReviewedChanges(repository: Repository, status: ParsedStatus, message: string,
  signal: AbortSignal, run: typeof git = git): Promise<void> {
  if (status.detached) throw new Error('Switch to a branch in your terminal before committing from Ion.')
  if (!status.unborn && !gitObjectId.test(status.head)) throw new Error('Git returned an invalid parent commit.')
  const ref = 'refs/heads/' + status.branch
  if (/[\x00-\x20\x7f]/.test(ref)) throw new Error('Git returned an invalid branch name.')
  const merge = await mergeState(repository, status.head.length)
  const scratch = await mkdtemp(join(tmpdir(), 'ion-git-commit-'))
  try {
    const indexFile = join(scratch, 'index')
    await run(repository, signal, ['read-tree', status.unborn ? '--empty' : status.head], { indexFile })
    const objectLength = status.unborn
      ? [...status.entries.values()].find(({ indexObject }) => indexObject && gitObjectId.test(indexObject))?.indexObject?.length
      : status.head.length
    if (!objectLength) throw new Error('Git returned no staged objects for the first commit.')
    if (merge.parent && (await run(repository, signal, ['cat-file', '-t', merge.parent], { limit: 64 })).text.trim() !== 'commit') {
      throw new Error('Git returned an invalid merge parent. Refresh the repository before committing.')
    }
    await run(repository, signal, ['update-index', '-z', '--index-info'], { indexFile, input: indexUpdates(status, objectLength) })
    const tree = (await run(repository, signal, ['write-tree'], { indexFile })).text.trim()
    if (!gitObjectId.test(tree) || tree.length !== objectLength) throw new Error('Git returned an invalid tree.')
    const parents = status.unborn ? [] : ['-p', status.head, ...(merge.parent ? ['-p', merge.parent] : [])]
    const commit = (await run(repository, signal, ['commit-tree', tree, ...parents, '--no-gpg-sign', '-F', '-'],
      { input: message })).text.trim()
    if (!gitObjectId.test(commit) || commit.length !== objectLength) throw new Error('Git returned an invalid commit.')
    const currentMerge = await mergeState(repository, status.head.length)
    if (currentMerge.parent !== merge.parent || currentMerge.markers.size !== merge.markers.size
      || [...merge.markers].some(([name, content]) => !currentMerge.markers.get(name)?.equals(content))) {
      throw new Error('Git merge state changed. Refresh before committing.')
    }
    await verifyMergeMetadata(repository, merge.markers)
    const selected = (await run(repository, signal, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'],
      { allowNotFound: true })).text.trim()
    if (selected !== ref) throw new Error('The checked-out branch changed. Refresh before committing.')
    // Name the reviewed branch, never HEAD. Git can compare-and-swap the ref
    // even if an external Git process stages files or changes branches.
    const old = status.unborn ? '0'.repeat(objectLength) : status.head
    signal.throwIfAborted()
    // Once publication starts, closing the panel waits for this bounded CAS.
    // Killing the writer here could strand a real ref lock or obscure success.
    await run(repository, new AbortController().signal,
      ['update-ref', '--no-deref', '-m', 'commit: Ion Source Control', ref, commit, old])
    if (merge.parent) await clearMergeMetadata(repository, merge.markers)
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}
