import { gitObjectId } from './commit'
import { git, type Repository } from './repository'

function localBranchName(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 240 || value === '@'
    || value.startsWith('-') || value.startsWith('refs/') || value.toUpperCase() === 'HEAD'
    || /[\x00-\x20\x7f~^:?*\[\\<>"|]/u.test(value) || value.includes('..') || value.includes('@{')
    || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || /\.lock$/i.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Choose a valid local branch name, such as feature/assignment.')
  }
  return value
}

export async function createLocalBranch(repository: Repository, signal: AbortSignal, value: unknown, head: string) {
  if (!value || typeof value !== 'object' || !('name' in value) || !('from' in value)
    || !gitObjectId.test(head) || value.from !== head) {
    throw new Error('Refresh and review the starting commit before creating a branch.')
  }
  const name = localBranchName(value.name)
  signal.throwIfAborted()
  // A zero expected OID requires a new ref. Once the lock transaction begins,
  // allow Git to finish on its existing bounded deadline, as with commit.
  await git(repository, new AbortController().signal, [
    'update-ref', '--no-deref', '-m', 'branch: created in Ion', 'refs/heads/' + name, head, '0'.repeat(head.length),
  ])
}
