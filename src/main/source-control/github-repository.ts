import type { SourceControlGitHubCreatePullRequestRequest, SourceControlGitHubPullRequestRequest } from '../../shared/source-control'

export const accountName = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,37}[A-Za-z0-9])?$/

export function checkRepository(input: unknown) {
  if (typeof input !== 'string' || input.length > 140) throw new Error('Enter a GitHub repository as owner/name.')
  const [owner, name, ...extra] = input.split('/')
  if (!accountName.test(owner) || !name || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..' || extra.length) {
    throw new Error('Enter a GitHub repository as owner/name.')
  }
  return input
}

export function checkPullRequestRequest(input: unknown): SourceControlGitHubPullRequestRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'repository') || !Object.hasOwn(input, 'number')) {
    throw new Error('Choose a pull request from the loaded GitHub repository.')
  }
  const { repository, number } = input as Record<string, unknown>
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    throw new Error('Choose a pull request from the loaded GitHub repository.')
  }
  return { repository: checkRepository(repository), number }
}

export function pullRequestUrl({ repository, number }: SourceControlGitHubPullRequestRequest): string {
  return 'https://github.com/' + repository + '/pull/' + number
}

function branchName(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 255 && value.length > 0
    && !/[\x00-\x20\x7f\u202a-\u202e\u2066-\u2069~^:?*\[\\<>"|]/u.test(value)
    && !value.includes('..') && !value.includes('@{') && !value.startsWith('/') && !value.endsWith('/')
    && !value.endsWith('.') && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.')
      && !/\.lock$/i.test(part))
}

export function checkCreatePullRequestRequest(input: unknown): SourceControlGitHubCreatePullRequestRequest {
  const fields = ['repository', 'title', 'head', 'base', 'body', 'draft']
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))) {
    throw new Error('Review the pull request details before creating it.')
  }
  const { repository, title, head, base, body, draft } = input as Record<string, unknown>
  if (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 256 || /[\r\n\x00-\x1f\x7f]/u.test(title)
    || typeof body !== 'string' || Buffer.byteLength(body) > 8192 || /\x00/u.test(body)
    || typeof draft !== 'boolean' || !branchName(base)) {
    throw new Error('Enter a title, branch names, and a description up to 8 KiB.')
  }
  let checkedHead: string | undefined
  if (typeof head === 'string') {
    const colon = head.indexOf(':')
    if (colon > 0 && head.indexOf(':', colon + 1) === -1) {
      const owner = head.slice(0, colon), branch = head.slice(colon + 1)
      if (accountName.test(owner) && branchName(branch)) checkedHead = owner + ':' + branch
    } else if (branchName(head)) checkedHead = head
  }
  if (!checkedHead) throw new Error('Enter a valid head branch, optionally prefixed with its GitHub owner.')
  return { repository: checkRepository(repository), title: title.trim(), head: checkedHead, base, body, draft }
}
