import { useEffect, useRef, useState } from 'react'
import type { SourceControlBridge, SourceControlGitHub, SourceControlGitHubCreatePullRequestRequest,
  SourceControlGitHubCreatedPullRequest, SourceControlGitHubIssue, SourceControlGitHubPullRequest } from '../../shared/source-control'
import './github-repository.css'

export function GitHubRepository({ bridge }: { bridge: SourceControlBridge }) {
  const [open, setOpen] = useState(false)
  const [repository, setRepository] = useState('')
  const [overview, setOverview] = useState<SourceControlGitHub>()
  const [operation, setOperation] = useState<'load' | 'clone' | 'pull-request' | 'issue' | 'create-pull-request' | 'sign-in' | 'sign-out'>()
  const [pullRequest, setPullRequest] = useState<SourceControlGitHubPullRequest>()
  const [issue, setIssue] = useState<SourceControlGitHubIssue>()
  const [createOpen, setCreateOpen] = useState(false)
  const [createDraft, setCreateDraft] = useState<SourceControlGitHubCreatePullRequestRequest>()
  const [createReview, setCreateReview] = useState<SourceControlGitHubCreatePullRequestRequest>()
  const [created, setCreated] = useState<SourceControlGitHubCreatedPullRequest>()
  const busy = Boolean(operation)
  const [error, setError] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [deviceCode, setDeviceCode] = useState('')
  const [cloned, setCloned] = useState('')
  const generation = useRef(0)
  const requested = useRef(false)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const pullRequestLink = useRef<HTMLButtonElement>(null)
  const issueLink = useRef<HTMLButtonElement>(null)

  function closeRequest() {
    generation.current++
    if (requested.current) void bridge.closeGitHub().catch(() => {})
    requested.current = false
  }
  useEffect(() => () => { closeRequest() }, [bridge])
  useEffect(() => bridge.onGitHubAuthEvent(event => setDeviceCode(event.code)), [bridge])
  useEffect(() => { if (pullRequest || issue) detailHeading.current?.focus() }, [pullRequest, issue])

  async function load() {
    const selected = repository.trim()
    if (!selected || busy) return
    const current = ++generation.current
    requested.current = true
    setOperation('load')
    setOverview(undefined)
    setPullRequest(undefined)
    setIssue(undefined)
    setCreateOpen(false)
    setCreateDraft(undefined)
    setCreateReview(undefined)
    setCreated(undefined)
    setCloned('')
    setError('')
    setAuthMessage('')
    setDeviceCode('')
    try {
      const result = await bridge.github(selected)
      if (generation.current === current) setOverview(result)
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'GitHub could not load this repository.')
    } finally {
      if (generation.current === current) setOperation(undefined)
    }
  }
  async function clone(access: 'public' | 'authenticated') {
    const selected = repository.trim()
    if (!selected || busy) return
    const slug = overview?.repository.toLowerCase() === selected.toLowerCase() ? overview.repository : selected
    requested.current = true
    const current = ++generation.current
    setOperation('clone')
    setCloned('')
    setError('')
    try {
      const path = await bridge.cloneGitHub(slug, access)
      if (path && generation.current === current) setCloned(path)
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'The clone failed.')
    } finally { if (generation.current === current) setOperation(undefined) }
  }
  async function signIn() {
    if (busy) return
    const current = ++generation.current
    requested.current = true
    setOperation('sign-in'); setError(''); setAuthMessage(''); setDeviceCode('')
    try {
      const complete = await bridge.githubSignIn()
      if (generation.current === current && complete) setAuthMessage('GitHub sign-in completed. Load a repository to confirm your account.')
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'GitHub sign-in did not complete.')
    } finally { if (generation.current === current) setOperation(undefined) }
  }
  async function signOut() {
    if (busy || !overview) return
    const current = ++generation.current
    requested.current = true
    setOperation('sign-out'); setError(''); setAuthMessage('')
    try {
      const complete = await bridge.githubSignOut()
      if (generation.current === current && complete) {
        setOverview(undefined); setPullRequest(undefined); setIssue(undefined); setCreateOpen(false)
        setCreateDraft(undefined); setCreateReview(undefined); setCreated(undefined); setCloned('')
        setAuthMessage('Signed out of GitHub on this computer.')
      }
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'GitHub sign-out did not complete.')
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
    setIssue(undefined)
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
  async function viewIssue(number: number) {
    if (busy || !overview?.issues.some(item => item.number === number)) return
    const current = ++generation.current
    setOperation('issue')
    setPullRequest(undefined)
    setIssue(undefined)
    setError('')
    try {
      const detail = await bridge.githubIssue({ repository: overview.repository, number })
      if (generation.current === current) setIssue(detail)
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'The issue could not be loaded.')
    } finally {
      if (generation.current === current) setOperation(undefined)
    }
  }
  async function submitPullRequest() {
    if (!createReview || !overview || busy) return
    const current = ++generation.current
    requested.current = true
    setOperation('create-pull-request')
    setError('')
    try {
      const result = await bridge.createGitHubPullRequest(createReview)
      if (generation.current !== current) return
      if (result) {
        setCreated(result)
        setCreateOpen(false)
        setCreateReview(undefined)
      }
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error
        ? reason.message : 'GitHub could not confirm the pull request result. Load the repository before retrying.')
    } finally {
      if (generation.current === current) setOperation(undefined)
    }
  }
  return <section className="git-hosted" aria-label="GitHub">
    <button type="button" className="button" aria-expanded={open} onClick={() => {
      if (open) { closeRequest(); setOverview(undefined); setPullRequest(undefined); setIssue(undefined); setCreateOpen(false); setCreateDraft(undefined);
        setCreateReview(undefined); setCreated(undefined); setOperation(undefined); setError(''); setCloned(''); setAuthMessage(''); setDeviceCode('') }
      setOpen(!open)
    }}>GitHub</button>
    {open && <>
      <form onSubmit={event => { event.preventDefault(); void load() }}>
        <label>GitHub repository<input aria-label="GitHub repository" placeholder="owner/repository" autoComplete="off"
          spellCheck={false} value={repository} maxLength={140} disabled={busy} onChange={event => {
            setRepository(event.target.value); setOverview(undefined); setPullRequest(undefined); setIssue(undefined); setCreateOpen(false);
            setCreateDraft(undefined); setCreateReview(undefined); setCreated(undefined); setError(''); setCloned(''); setAuthMessage('')
          }}/></label>
        <button className="button" type="submit" disabled={!repository.trim() || busy}>{operation === 'load' ? 'Loading…' : 'Load from GitHub'}</button>
        <button className="button" type="button" disabled={!repository.trim() || busy} onClick={() => void clone('public')}>
          {operation === 'clone' ? 'Cloning…' : 'Clone public repository…'}
        </button>
        {!overview && <button className="button" type="button" disabled={busy} onClick={() => void signIn()}>
          {operation === 'sign-in' ? 'Waiting for GitHub approval…' : 'Sign in with GitHub…'}
        </button>}
      </form>
      {deviceCode && <section className="git-created-pull-request" role="status" aria-label="GitHub device sign-in">
        <p>Enter this one-time code in the GitHub browser window:</p><code>{deviceCode}</code>
        <button type="button" onClick={() => void openPage('https://github.com/login/device')}>Open GitHub device page</button>
      </section>}
      {authMessage && <p role="status">{authMessage}</p>}
      {cloned && <p role="status">Cloned to {cloned}</p>}
      {operation === 'pull-request' && <p role="status">Loading pull request…</p>}
      {operation === 'issue' && <p role="status">Loading issue…</p>}
      {error && <p role="alert">{error}</p>}
      {created && <section className="git-created-pull-request" role="status" aria-label="Created pull request">
        <p>Created #{created.number}: {created.title}{created.draft ? ' · Draft' : ''}</p>
        <button type="button" onClick={() => void openPage(created.url)}>Open pull request on GitHub</button>
      </section>}
      {overview && <div className="git-hosted-results">
        <button type="button" onClick={() => void openPage('https://github.com/' + overview.repository)}>{overview.repository}</button>
        <small>Signed in as {overview.login}</small>
        <button className="button" type="button" disabled={busy} onClick={() => void signOut()}>
          {operation === 'sign-out' ? 'Signing out…' : 'Sign out of GitHub…'}
        </button>
        <button className="button" type="button" disabled={busy} onClick={() => void clone('authenticated')}>
          {operation === 'clone' ? 'Cloning…' : 'Clone with GitHub account…'}
        </button>
        <small>Uses your signed-in GitHub CLI access. Repository files stay in the folder you choose.</small>
        <button type="button" onClick={() => void openPage('https://github.com/' + overview.repository + '/compare?expand=1')}>
          Prepare pull request on GitHub…
        </button>
        <button type="button" disabled={busy} onClick={() => {
          setCreateDraft({ repository: overview.repository, title: '', head: '', base: '', body: '', draft: true })
          setCreateReview(undefined); setCreated(undefined); setCreateOpen(value => !value); setError('')
        }}>{createOpen ? 'Close new pull request' : 'Create pull request…'}</button>
        {createOpen && createDraft && <section className="git-create-pull-request" aria-label="Create pull request">
          <p>Enter branches that already exist on GitHub. Ion will not push commits.</p>
          <label>Title<input aria-label="Pull request title" maxLength={256} disabled={busy} value={createDraft.title}
            onChange={event => { setCreateDraft({ ...createDraft, title: event.target.value }); setCreateReview(undefined) }}/></label>
          <label>Head branch<input aria-label="Head branch" maxLength={255} placeholder="owner:branch or branch" disabled={busy}
            value={createDraft.head} onChange={event => { setCreateDraft({ ...createDraft, head: event.target.value }); setCreateReview(undefined) }}/></label>
          <label>Base branch<input aria-label="Base branch" maxLength={255} placeholder="main" disabled={busy}
            value={createDraft.base} onChange={event => { setCreateDraft({ ...createDraft, base: event.target.value }); setCreateReview(undefined) }}/></label>
          <label>Description<textarea aria-label="Pull request description" maxLength={8192} rows={4} disabled={busy}
            value={createDraft.body} onChange={event => { setCreateDraft({ ...createDraft, body: event.target.value }); setCreateReview(undefined) }}/></label>
          <label className="git-create-draft"><input type="checkbox" disabled={busy} checked={createDraft.draft}
            onChange={event => { setCreateDraft({ ...createDraft, draft: event.target.checked }); setCreateReview(undefined) }}/>Create as a draft</label>
          {!createReview ? <button type="button" disabled={busy || !createDraft.title.trim() || !createDraft.head.trim() || !createDraft.base.trim()}
            onClick={() => setCreateReview({ ...createDraft })}>Review pull request…</button>
            : <div className="git-create-pull-review" role="group" aria-label="Review pull request">
              <strong>{createReview.title}</strong>
              <p>{createReview.head} → {createReview.base}{createReview.draft ? ' · Draft' : ''}</p>
              <pre>{createReview.body || 'No description.'}</pre>
              <p>Submitting creates a pull request and may notify repository participants. No commits will be pushed.</p>
              <button type="button" disabled={busy} onClick={() => void submitPullRequest()}>
                {operation === 'create-pull-request' ? 'Creating…' : 'Create pull request'}
              </button>
              <button type="button" disabled={busy} onClick={() => setCreateReview(undefined)}>Edit details</button>
            </div>}
        </section>}
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
            <button type="button" disabled={busy} aria-controls={issue?.number === item.number ? 'git-hosted-issue-detail' : undefined}
              onClick={event => { issueLink.current = event.currentTarget; void viewIssue(item.number) }}>
              #{item.number} {item.title}
            </button>
          </li>)}</ul> : <p>None returned.</p>}
        </section>
        {issue && <section id="git-hosted-issue-detail" className="git-hosted-pull-detail" aria-label="Issue details">
          <h3 tabIndex={-1} ref={detailHeading}>#{issue.number} {issue.title}</h3>
          <p>{issue.state === 'open' ? 'Open' : 'Closed'}{issue.author && ' by ' + issue.author}</p>
          {issue.body ? <p className="git-hosted-pull-body">{issue.body}</p> : <p>No description provided.</p>}
          {issue.bodyTruncated && <p>Description shortened. Open GitHub to read the rest.</p>}
          <div className="git-hosted-pull-actions">
            <button type="button" onClick={() => void openPage(issue.url)}>Open issue on GitHub</button>
            <button type="button" onClick={() => { setIssue(undefined); issueLink.current?.focus() }}>Hide details</button>
          </div>
        </section>}
      </div>}
    </>}
  </section>
}
