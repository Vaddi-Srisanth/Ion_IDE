import { useEffect, useRef, useState } from 'react'
import type { SourceControlBridge, SourceControlGitHub, SourceControlGitHubPullRequest } from '../../shared/source-control'
import './github-repository.css'

export function GitHubRepository({ bridge }: { bridge: SourceControlBridge }) {
  const [open, setOpen] = useState(false)
  const [repository, setRepository] = useState('')
  const [overview, setOverview] = useState<SourceControlGitHub>()
  const [operation, setOperation] = useState<'load' | 'clone' | 'pull-request'>()
  const [pullRequest, setPullRequest] = useState<SourceControlGitHubPullRequest>()
  const busy = Boolean(operation)
  const [error, setError] = useState('')
  const [cloned, setCloned] = useState('')
  const generation = useRef(0)
  const requested = useRef(false)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const pullRequestLink = useRef<HTMLButtonElement>(null)

  function closeRequest() {
    generation.current++
    if (requested.current) void bridge.closeGitHub().catch(() => {})
    requested.current = false
  }
  useEffect(() => () => { closeRequest() }, [bridge])
  useEffect(() => { if (pullRequest) detailHeading.current?.focus() }, [pullRequest])

  async function load() {
    const selected = repository.trim()
    if (!selected || busy) return
    const current = ++generation.current
    requested.current = true
    setOperation('load')
    setOverview(undefined)
    setPullRequest(undefined)
    setCloned('')
    setError('')
    try {
      const result = await bridge.github(selected)
      if (generation.current === current) setOverview(result)
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'GitHub could not load this repository.')
    } finally {
      if (generation.current === current) setOperation(undefined)
    }
  }
  async function clone() {
    const selected = repository.trim()
    if (!selected || busy) return
    const slug = overview?.repository.toLowerCase() === selected.toLowerCase() ? overview.repository : selected
    requested.current = true
    const current = ++generation.current
    setOperation('clone')
    setCloned('')
    setError('')
    try {
      const path = await bridge.cloneGitHub(slug)
      if (path && generation.current === current) setCloned(path)
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'The clone failed.')
    } finally { if (generation.current === current) setOperation(undefined) }
  }
  async function openPage(url: string) {
    const current = generation.current
    try { await bridge.openGitHubPage(url) }
    catch { if (generation.current === current) setError('The link expired or your browser could not open it. Load the repository again.') }
  }
  async function viewPullRequest(number: number) {
    if (busy || !overview?.pullRequests.some(item => item.number === number)) return
    const current = ++generation.current
    setOperation('pull-request')
    setPullRequest(undefined)
    setError('')
    try {
      const detail = await bridge.githubPullRequest({ repository: overview.repository, number })
      if (generation.current === current) setPullRequest(detail)
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'The pull request could not be loaded.')
    } finally {
      if (generation.current === current) setOperation(undefined)
    }
  }
  return <section className="git-hosted" aria-label="GitHub">
    <button type="button" className="button" aria-expanded={open} onClick={() => {
      if (open) { closeRequest(); setOverview(undefined); setPullRequest(undefined); setOperation(undefined); setError(''); setCloned('') }
      setOpen(!open)
    }}>GitHub</button>
    {open && <>
      <form onSubmit={event => { event.preventDefault(); void load() }}>
        <label>GitHub repository<input aria-label="GitHub repository" placeholder="owner/repository" autoComplete="off"
          spellCheck={false} value={repository} maxLength={140} disabled={busy} onChange={event => {
            setRepository(event.target.value); setOverview(undefined); setPullRequest(undefined); setError(''); setCloned('')
          }}/></label>
        <button className="button" type="submit" disabled={!repository.trim() || busy}>{operation === 'load' ? 'Loading…' : 'Load from GitHub'}</button>
        <button className="button" type="button" disabled={!repository.trim() || busy} onClick={() => void clone()}>
          {operation === 'clone' ? 'Cloning…' : 'Clone public repository…'}
        </button>
      </form>
      {cloned && <p role="status">Cloned to {cloned}</p>}
      {operation === 'pull-request' && <p role="status">Loading pull request…</p>}
      {error && <p role="alert">{error}</p>}
      {overview && <div className="git-hosted-results">
        <button type="button" onClick={() => void openPage('https://github.com/' + overview.repository)}>{overview.repository}</button>
        <small>Signed in as {overview.login}</small>
        <button type="button" onClick={() => void openPage('https://github.com/' + overview.repository + '/compare?expand=1')}>
          Prepare pull request on GitHub…
        </button>
        <section aria-label="Open pull requests"><h3>Open pull requests</h3>
          {overview.pullRequests.length ? <ul>{overview.pullRequests.map(item => <li key={item.number}>
            <button type="button" disabled={busy} aria-controls={pullRequest?.number === item.number ? 'git-hosted-pull-detail' : undefined}
              onClick={event => {
                pullRequestLink.current = event.currentTarget
                void viewPullRequest(item.number)
              }}>#{item.number} {item.title}</button>
          </li>)}</ul> : <p>None returned.</p>}
        </section>
        {pullRequest && <section id="git-hosted-pull-detail" className="git-hosted-pull-detail" aria-label="Pull request details">
          <h3 tabIndex={-1} ref={detailHeading}>#{pullRequest.number} {pullRequest.title}</h3>
          <p>{pullRequest.state === 'merged' ? 'Merged' : pullRequest.state === 'closed' ? 'Closed' : pullRequest.draft ? 'Draft' : 'Open'}
            {pullRequest.author && ' by ' + pullRequest.author}</p>
          <dl><dt>Base</dt><dd>{pullRequest.base}</dd><dt>Head</dt><dd>{pullRequest.head}</dd></dl>
          {pullRequest.body
            ? <p className="git-hosted-pull-body">{pullRequest.body}</p>
            : <p>No description provided.</p>}
          {pullRequest.bodyTruncated && <p>Description shortened. Open GitHub to read the rest.</p>}
          <div className="git-hosted-pull-actions">
            <button type="button" onClick={() => void openPage(pullRequest.url)}>Open pull request on GitHub</button>
            <button type="button" onClick={() => { setPullRequest(undefined); pullRequestLink.current?.focus() }}>Hide details</button>
          </div>
        </section>}
        <section aria-label="Open issues"><h3>Open issues</h3>
          {overview.issues.length ? <ul>{overview.issues.map(item => <li key={item.number}>
            <button type="button" onClick={() => void openPage(item.url)}>#{item.number} {item.title}</button>
          </li>)}</ul> : <p>None returned.</p>}
        </section>
      </div>}
    </>}
  </section>
}
