import type { SourceControlGitHubPullRequestRequest } from '../../shared/source-control'

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
