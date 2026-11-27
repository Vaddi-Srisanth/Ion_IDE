import type { SourceControlBrowse } from '../../shared/source-control'
import { configurationEntries } from './configuration'
import { checkRepository } from './github-repository'

const remoteLimit = 100
const urlLimit = 200

function githubIdentity(url: string): string | null {
  const https = /^https:\/\/github\.com(?::443)?\//i.exec(url)
  const ssh = 'git@github.com:'
  const slug = https ? url.slice(https[0].length).replace(/\/$/, '') : url.startsWith(ssh) ? url.slice(ssh.length) : ''
  try { return checkRepository(slug.replace(/\.git$/, '')) } catch { return null }
}

function reviewedIdentity(url: string, rewrites: Map<string, string | null>): string | null {
  const slug = githubIdentity(url)
  if (!slug) return null
  // Git applies the longest matching insteadOf prefix. Keep the identity only when the configured
  // and effective fetch destinations both identify the same GitHub repository without credentials.
  for (let end = url.length; end >= 0; end--) {
    const replacement = rewrites.get(url.slice(0, end))
    if (replacement === undefined) continue
    if (!replacement) return null
    const effective = githubIdentity(replacement + url.slice(end))
    return effective?.toLowerCase() === slug.toLowerCase() ? slug : null
  }
  return slug
}

/** Use only the already-captured, byte-bounded configuration. Raw destinations never leave this projection. */
export function reviewedRemotes(configuration: string): Pick<SourceControlBrowse, 'remotes' | 'truncated'> {
  const candidates = new Map<string, { local: boolean; helper: boolean; url?: string | null }>()
  const rewrites = new Map<string, string | null>()
  let truncated = false
  for (const { scope, section, name, subsection, value } of configurationEntries(configuration)) {
    const key = name.toLowerCase()
    if (section.toLowerCase() === 'url' && key === 'insteadof' && value !== undefined && value.length <= urlLimit) {
      const previous = rewrites.get(value)
      rewrites.set(value, subsection && subsection.length <= urlLimit && (previous === undefined || previous === subsection) ? subsection : null)
    }
    if (section.toLowerCase() !== 'remote' || !subsection) continue
    const local = scope === 'local' || scope === 'worktree'
    // Section names can contain whole URLs or control text as well. Only display ordinary short remote identifiers.
    if (subsection.length > 100 || !/^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u.test(subsection)) {
      if (local) truncated = true
      continue
    }
    const remote = candidates.get(subsection) ?? { local: false, helper: false }
    remote.local ||= local
    if (key === 'vcs') remote.helper = true
    if (key === 'url') remote.url = remote.url === undefined && value && value.length <= urlLimit ? value : null
    candidates.set(subsection, remote)
  }
  const names = [...candidates.keys()].filter(name => candidates.get(name)!.local).sort()
  const remotes = names.slice(0, remoteLimit).map(name => {
    const { url, helper } = candidates.get(name)!
    return { name, repository: url && !helper ? reviewedIdentity(url, rewrites) : null }
  })
  return { remotes, truncated: truncated || names.length > remoteLimit }
}

/** Ensure Ion's canonical HTTPS endpoint is not redirected by repository URL rewrite rules. */
export function reviewedGitHubEndpoint(configuration: string, repository: string): boolean {
  const rewrites = new Map<string, string | null>()
  for (const { section, name, subsection, value } of configurationEntries(configuration)) {
    if (section.toLowerCase() !== 'url' || name.toLowerCase() !== 'insteadof' || value === undefined || value.length > urlLimit) continue
    const previous = rewrites.get(value)
    rewrites.set(value, subsection && subsection.length <= urlLimit && (previous === undefined || previous === subsection) ? subsection : null)
  }
  const endpoint = 'https://github.com/' + repository + '.git'
  return reviewedIdentity(endpoint, rewrites)?.toLowerCase() === repository.toLowerCase()
}
