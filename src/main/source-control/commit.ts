import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absent, git, type Repository } from './repository'
import { safeGitPath, type ParsedStatus } from './status'

export const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const indexMode = /^(?:100644|100755|120000|160000)$/
const inProgress = ['MERGE_HEAD', 'MERGE_MSG', 'SQUASH_MSG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
  'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']

async function checkOperationState(repository: Repository): Promise<void> {
  for (const name of inProgress) {
    const found = await lstat(join(repository.directory, name)).then(() => true, (error: unknown) => {
      if (absent(error)) return false
      throw error
    })
    if (found) throw new Error('Finish the active Git operation in your terminal before committing from Ion.')
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
  await checkOperationState(repository)
  const scratch = await mkdtemp(join(tmpdir(), 'ion-git-commit-'))
  try {
    const indexFile = join(scratch, 'index')
    await run(repository, signal, ['read-tree', status.unborn ? '--empty' : status.head], { indexFile })
    const objectLength = status.unborn
      ? [...status.entries.values()].find(({ indexObject }) => indexObject && gitObjectId.test(indexObject))?.indexObject?.length
      : status.head.length
    if (!objectLength) throw new Error('Git returned no staged objects for the first commit.')
    await run(repository, signal, ['update-index', '-z', '--index-info'], { indexFile, input: indexUpdates(status, objectLength) })
    const tree = (await run(repository, signal, ['write-tree'], { indexFile })).text.trim()
    if (!gitObjectId.test(tree) || tree.length !== objectLength) throw new Error('Git returned an invalid tree.')
    const parent = status.unborn ? [] : ['-p', status.head]
    const commit = (await run(repository, signal, ['commit-tree', tree, ...parent, '--no-gpg-sign', '-F', '-'],
      { input: message })).text.trim()
    if (!gitObjectId.test(commit) || commit.length !== objectLength) throw new Error('Git returned an invalid commit.')
    await checkOperationState(repository)
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
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}
