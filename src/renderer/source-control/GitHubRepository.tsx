import { useEffect, useRef, useState } from 'react'
import type { SourceControlBridge, SourceControlGitHub } from '../../shared/source-control'
import './github-repository.css'

export function GitHubRepository({ bridge }: { bridge: SourceControlBridge }) {
  const [open, setOpen] = useState(false)
  const [repository, setRepository] = useState('')
  const [overview, setOverview] = useState<SourceControlGitHub>()
  const [operation, setOperation] = useState<'load' | 'clone'>()
  const busy = Boolean(operation)
  const [error, setError] = useState('')
  const [cloned, setCloned] = useState('')
  const generation = useRef(0)
  const requested = useRef(false)

  function closeRequest() {
    generation.current++
    if (requested.current) void bridge.closeGitHub().catch(() => {})
    requested.current = false
  }
  useEffect(() => () => { closeRequest() }, [bridge])

  async function load() {
    const selected = repository.trim()
    if (!selected || busy) return
    const current = ++generation.current
    requested.current = true
    setOperation('load')
    setOverview(undefined)
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
    if (!overview || busy) return
    const current = generation.current
    setOperation('clone')
    setCloned('')
    setError('')
    try {
      const path = await bridge.cloneGitHub(overview.repository)
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
  return <section className="git-hosted" aria-label="GitHub">
    <button type="button" className="button" aria-expanded={open} onClick={() => {
      if (open) { closeRequest(); setOverview(undefined); setOperation(undefined); setError(''); setCloned('') }
      setOpen(!open)
    }}>GitHub</button>
    {open && <>
      <form onSubmit={event => { event.preventDefault(); void load() }}>
        <label>GitHub repository<input aria-label="GitHub repository" placeholder="owner/repository" autoComplete="off"
          spellCheck={false} value={repository} maxLength={140} onChange={event => setRepository(event.target.value)}/></label>
        <button className="button" type="submit" disabled={!repository.trim() || busy}>{operation === 'load' ? 'Loading…' : 'Load from GitHub'}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {overview && <div className="git-hosted-results">
        <button type="button" onClick={() => void openPage('https://github.com/' + overview.repository)}>{overview.repository}</button>
        <small>Signed in as {overview.login}</small>
        <button type="button" onClick={() => void openPage('https://github.com/' + overview.repository + '/compare?expand=1')}>
          Prepare pull request on GitHub…
        </button>
        <button type="button" disabled={busy} onClick={() => void clone()}>{operation === 'clone' ? 'Cloning…' : 'Clone public repository…'}</button>
        <small>Downloads the latest revision into a new folder.</small>
        {cloned && <p role="status">Cloned to {cloned}</p>}
        {([['Open pull requests', overview.pullRequests], ['Open issues', overview.issues]] as const).map(([label, items]) =>
          <section aria-label={label} key={label}><h3>{label}</h3>
            {items.length ? <ul>{items.map(item => <li key={item.number}>
              <button type="button" onClick={() => void openPage(item.url)}>#{item.number} {item.title}</button>
            </li>)}</ul> : <p>None returned.</p>}
          </section>)}
      </div>}
    </>}
  </section>
}
