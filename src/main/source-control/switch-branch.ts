import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceControlSwitchRequest } from '../../shared/source-control'
import { absent, git, type Repository } from './repository'
import { gitObjectId } from './commit'
import { verifySingleWorktree } from './worktree-branches'

const operationMarkers = ['MERGE_HEAD', 'MERGE_MSG', 'SQUASH_MSG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
  'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']

function branchName(value: string): boolean {
  return value.length <= 1024 && value !== '@' && !value.startsWith('-')
    && !/[\x00-\x20\x7f~^:?*\[\\<>"|]/u.test(value) && !value.includes('..') && !value.includes('@{')
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !/\.lock$/i.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

async function requireNoOperation(repository: Repository): Promise<void> {
  for (const name of operationMarkers) {
    const found = await lstat(join(repository.directory, name)).then(() => true, (error: unknown) => {
      if (absent(error)) return false
      throw error
    })
    if (found) throw new Error('Finish the active Git operation in your terminal before switching branches from Ion.')
  }
}

async function treeOf(repository: Repository, signal: AbortSignal, oid: string, run: typeof git): Promise<string> {
  const type = (await run(repository, signal, ['cat-file', '-t', oid], { limit: 64 })).text.trim()
  if (type !== 'commit') throw new Error('The selected branch does not point directly to a commit.')
  const tree = (await run(repository, signal, ['rev-parse', '--verify', oid + '^{tree}'], { limit: 128 })).text.trim()
  if (!gitObjectId.test(tree) || tree.length !== oid.length) throw new Error('Git returned an invalid branch tree.')
  return tree
}

/** Change only HEAD after an exact tree match; the index and worktree are never checked out or rewritten. */
export async function switchBranchAtSameTree(repository: Repository, signal: AbortSignal,
  input: SourceControlSwitchRequest, run: typeof git = git): Promise<void> {
  if (!input || typeof input !== 'object' || !branchName(input.current) || !branchName(input.target)
    || input.current === input.target || !gitObjectId.test(input.from) || !gitObjectId.test(input.to)
    || input.from.length !== input.to.length) throw new Error('Choose a reviewed local branch.')
  const currentRef = 'refs/heads/' + input.current
  const targetRef = 'refs/heads/' + input.target
  signal.throwIfAborted()
  await requireNoOperation(repository)
  const [currentTree, targetTree] = await Promise.all([
    treeOf(repository, signal, input.from, run), treeOf(repository, signal, input.to, run),
  ])
  if (currentTree !== targetTree) throw new Error('Ion can switch branches only when their committed file trees match.')
  await verifySingleWorktree(repository, signal, currentRef, input.from)
  await requireNoOperation(repository)
  signal.throwIfAborted()

  // Newer Git provides a single ref transaction for HEAD and both commit refs.
  // This CAS prevents a concurrently changed branch from being checked out with a stale tree.
  const inputText = [
    'start',
    'option no-deref',
    'symref-update HEAD ' + targetRef + ' oid ' + input.from,
    'option no-deref',
    'verify ' + targetRef + ' ' + input.to,
    'prepare',
    'commit',
    '',
  ].join('\n')
  signal.throwIfAborted()
  // Once Git begins the bounded ref transaction, let it finish atomically on close/cancel.
  await run(repository, new AbortController().signal, ['update-ref', '--stdin'], { input: inputText, limit: 4096 })
}
