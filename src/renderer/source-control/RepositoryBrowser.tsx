import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SourceControlBridge, SourceControlBrowse } from '../../shared/source-control'
import { errorMessage } from '../documents'
import { Icon } from '../icons'

type View = 'commits' | 'branches' | 'tags' | 'remotes'
const views: Record<View, string> = { commits: 'Commit history', branches: 'Local branches', tags: 'Tags', remotes: 'Remotes' }
const empty: Record<View, string> = { commits: 'No commits yet.', branches: 'No local branches.', tags: 'No tags.', remotes: 'No remotes.' }
type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SourceControlBrowse; revision: number }

export default function RepositoryBrowser({ bridge, busy, perform, currentBranch }: {
  bridge: SourceControlBridge
  busy: boolean
  perform(task: () => Promise<void>): Promise<void>
  currentBranch?: string
}) {
  const [state, setState] = useState<State>()
  const [view, setView] = useState<View>('commits')
  const [feedback, setFeedback] = useState<{ message: string; error?: boolean }>()
  const request = useRef(0)
  const contentId = useId()

  useEffect(() => {
    setState(undefined)
    setFeedback(undefined)
    return () => { request.current++ }
  }, [bridge])

  async function read() {
    const id = ++request.current
    setState({ kind: 'loading' })
    try {
      const data = await bridge.browse()
      if (request.current === id) setState({ kind: 'ready', data, revision: id })
    } catch (reason) {
      if (request.current === id) setState({ kind: 'error', message: errorMessage(reason) })
    }
  }

  function load() {
    setFeedback(undefined)
    void perform(read)
  }

  function createBranch(name: string, from: string) {
    void perform(async () => {
      const id = request.current
      setFeedback(undefined)
      try {
        await bridge.createBranch({ name, from })
        if (id !== request.current) return
        setFeedback({ message: 'Created local branch ' + name + '.' })
        await read()
      } catch (reason) {
        if (id === request.current) setFeedback({ message: errorMessage(reason), error: true })
      }
    })
  }

  function toggle() {
    if (!state) { load(); return }
    request.current++
    setState(undefined)
  }

  return <section className="git-browser" aria-label="Repository browser">
    <div className="git-browser-heading">
      <button type="button" className="git-browser-toggle" aria-expanded={Boolean(state)} aria-controls={contentId}
        disabled={!state && busy} onClick={toggle} data-testid="git-browse">
        <Icon name={state ? 'down' : 'chevron'} size={13}/>Browse repository
      </button>
      {state && <button type="button" className="icon-button" disabled={busy} onClick={load}
        aria-label="Refresh repository browser" title="Refresh repository browser"><Icon name="refresh" size={13}/></button>}
    </div>
    <div id={contentId} hidden={!state}>
      {state && <select className="git-browser-view" aria-label="Repository view" value={view}
        onChange={event => setView(event.target.value as View)}>
        {(Object.keys(views) as View[]).map(name => <option key={name} value={name}>{views[name]}</option>)}
      </select>}
      {state?.kind === 'loading' && <p className="source-control-empty" role="status">Loading repository…</p>}
      {state?.kind === 'error' && <p className="source-control-notice" role="alert">{state.message}</p>}
      {state && feedback && <p className="source-control-notice" role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
      {state?.kind === 'ready' && <>
        {view === 'branches' && <BranchForm key={state.revision} busy={busy} from={state.data.commits[0]?.oid} create={createBranch}/>}
        {!state.data[view].length ? <p className="source-control-empty" role="status">{empty[view]}</p>
          : view === 'commits' ? <CommitList commits={state.data.commits}/>
            : <ul className="git-browser-list" aria-label={views[view]} tabIndex={0}>
              {state.data[view].map(ref => <li key={ref.name} className="git-browser-ref">
                <span className="git-browser-name" dir="auto">{ref.name}</span>
                {view === 'branches' && ref.name === currentBranch && <small>Current</small>}
                {'oid' in ref ? <code title={ref.oid}>{ref.oid.slice(0, 10)}</code>
                  : ref.repository && <span className="git-browser-remote-repo" dir="ltr">{ref.repository}</span>}
              </li>)}
            </ul>}
        {state.data.truncated && <p className="source-control-empty">Some repository details exceed the display limit.</p>}
      </>}
    </div>
  </section>
}

function BranchForm({ busy, from, create }: { busy: boolean; from?: string; create(name: string, from: string): void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  return <div className="git-browser-create">
    {!open ? <button className="button" type="button" disabled={busy || !from} onClick={() => setOpen(true)}>
      <Icon name="plus" size={12}/>New branch…
    </button> : from && <form onSubmit={event => {
      event.preventDefault()
      if (!busy && name.trim()) create(name, from)
    }}>
      <label>Branch name<input autoFocus required value={name} onChange={event => setName(event.target.value)}
        spellCheck={false} autoCapitalize="none" autoComplete="off" disabled={busy}/></label>
      <p>Create from HEAD <code title={from}>{from.slice(0, 10)}</code>. Your current checkout stays in place.</p>
      <div className="git-browser-form-actions">
        <button className="button" type="submit" disabled={busy || !name.trim()}>Create branch</button>
        <button className="button" type="button" disabled={busy} onClick={() => { setName(''); setOpen(false) }}>Cancel</button>
      </div>
    </form>}
    {!from && <p>Create a commit first to start a new branch.</p>}
  </div>
}

function CommitList({ commits }: Pick<SourceControlBrowse, 'commits'>) {
  const dates = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }), [])
  return <ol className="git-browser-list" aria-label={views.commits} tabIndex={0}>
    {commits.map(commit => {
      const date = new Date(commit.time * 1000)
      return <li key={commit.oid} className="git-browser-commit">
        <span className="git-browser-name" dir="auto">{commit.subject || '(No subject)'}</span>
        <div className="git-browser-metadata">
          <code title={commit.oid}>{commit.oid.slice(0, 10)}</code>
          {commit.author && <span dir="auto">{commit.author}</span>}
          {Number.isFinite(date.getTime()) && <time dateTime={date.toISOString()}>{dates.format(date)}</time>}
        </div>
      </li>
    })}
  </ol>
}
