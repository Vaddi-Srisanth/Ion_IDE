import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SourceControlBridge, SourceControlBrowse, SourceControlComparison, SourceControlComparisonRequest } from '../../shared/source-control'
import { errorMessage } from '../documents'
import { Icon } from '../icons'

type View = 'commits' | 'branches' | 'cachedRemoteBranches' | 'tags' | 'remotes' | 'stash'
const views: Record<View, string> = {
  commits: 'Commit history', branches: 'Local branches', cachedRemoteBranches: 'Cached remote branches',
  tags: 'Tags', remotes: 'Remotes', stash: 'Latest stash',
}
const empty: Record<View, string> = {
  commits: 'No commits yet.', branches: 'No local branches.', cachedRemoteBranches: 'No cached remote branches.',
  tags: 'No tags.', remotes: 'No remotes.', stash: 'No stash saved.',
}
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

  function createRef(kind: 'branch' | 'tag', name: string, from: string) {
    void perform(async () => {
      const id = request.current
      setFeedback(undefined)
      try {
        if (kind === 'branch') await bridge.createBranch({ name, from })
        else await bridge.createTag({ name, from })
        if (id !== request.current) return
        setFeedback({ message: 'Created ' + (kind === 'branch' ? 'local branch ' : 'lightweight tag ') + name + '.' })
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
        {view === 'tags' && <RefForm key={state.revision} kind="tag" busy={busy} from={state.data.commits[0]?.oid} create={createRef}/>}
        {view === 'branches' || view === 'cachedRemoteBranches' || view === 'stash'
          ? <ComparisonView key={view + state.revision} {...{ view, bridge, busy, perform, currentBranch, createRef }} data={state.data}/>
          : !state.data[view].length ? <p className="source-control-empty" role="status">{empty[view]}</p>
          : view === 'commits' ? <CommitList commits={state.data.commits}/>
            : <ul className="git-browser-list" aria-label={views[view]} tabIndex={0}>
              {state.data[view].map(ref => <li key={ref.name} className="git-browser-ref">
                <span className="git-browser-name" dir="auto">{ref.name}</span>
                {'oid' in ref ? <code title={ref.oid}>{ref.oid.slice(0, 10)}</code>
                  : ref.repository && <span className="git-browser-remote-repo" dir="ltr">{ref.repository}</span>}
              </li>)}
            </ul>}
        {state.data.truncated && <p className="source-control-empty">Some repository details exceed the display limit.</p>}
      </>}
    </div>
  </section>
}

type Preview = { label: string } & (
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; result: SourceControlComparison }
)
type ComparisonProps = {
  view: 'branches' | 'cachedRemoteBranches' | 'stash'; bridge: SourceControlBridge; data: SourceControlBrowse; busy: boolean; currentBranch?: string
  perform(task: () => Promise<void>): Promise<void>
  createRef(kind: 'branch' | 'tag', name: string, from: string): void
}

function ComparisonView({ view, bridge, data, busy, currentBranch, perform, createRef }: ComparisonProps) {
  const [preview, setPreview] = useState<Preview>()
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [bridge])
  const head = data.commits[0]?.oid
  const cached = view === 'cachedRemoteBranches'
  const offlineNote = cached && <p className="source-control-empty">Comparisons use the Git refs stored on this computer and run offline.</p>
  function compare(kind: SourceControlComparisonRequest['kind'], name: string, to: string) {
    if (!head) return
    void perform(async () => {
      const id = ++request.current
      const label = kind === 'stash' ? views.stash : name
      setPreview({ kind: 'loading', label })
      try {
        const result = await bridge.previewComparison({ kind, name, from: head, to })
        if (id === request.current) setPreview({ kind: 'ready', label, result })
      } catch (reason) {
        if (id === request.current) setPreview({ kind: 'error', label, message: errorMessage(reason) })
      }
    })
  }

  if (preview) return <section className="source-control-group" aria-label="Comparison preview">
    <div className="git-browser-create">
      <button type="button" className="button" onClick={() => { request.current++; setPreview(undefined) }}>
        Close preview
      </button>
    </div>
    <h3><bdi className="git-browser-name">{preview.label}</bdi></h3>
    {offlineNote}
    {preview.kind === 'loading' && <p className="source-control-empty" role="status">Comparing revisions…</p>}
    {preview.kind === 'error' && <p className="source-control-notice" role="alert">{preview.message}</p>}
    {preview.kind === 'ready' && <ComparisonResult result={preview.result}/>}
  </section>

  const stash = data.stash
  if (view === 'stash') return stash ? <div className="git-browser-create">
    <p>Latest stash <code title={stash.oid}>{stash.oid.slice(0, 10)}</code></p>
    <button className="button" type="button" disabled={!head || busy} onClick={() => compare('stash', 'refs/stash', stash.oid)}>
      Preview latest stash
    </button>
  </div> : <p className="source-control-empty" role="status">{empty.stash}</p>

  const branches = data[view]
  return <>
    {offlineNote}
    {!cached && <RefForm kind="branch" busy={busy} from={head} create={createRef}/>}
    {branches.length ? <ul className="git-browser-list" aria-label={views[view]} tabIndex={0}>
      {branches.map(branch => <li key={branch.name} className="git-browser-ref">
        <span className="git-browser-name" dir="auto">{branch.name}</span>
        {!cached && branch.name === currentBranch && <small>Current</small>}
        <code title={branch.oid}>{branch.oid.slice(0, 10)}</code>
        <button type="button" className="button" aria-label={'Compare ' + branch.name + ' with HEAD'} disabled={!head || busy}
          onClick={() => compare(cached ? 'cached-remote-branch' : 'branch', branch.name, branch.oid)}>Compare</button>
      </li>)}
    </ul> : <p className="source-control-empty" role="status">{empty[view]}</p>}
  </>
}

const relations: Record<SourceControlComparison['relation'], string> = {
  same: 'This branch points to the same commit as HEAD.', ahead: 'This branch is ahead of HEAD.',
  behind: 'This branch is behind HEAD.', diverged: 'This branch and HEAD have diverged.',
  stash: 'Tracked changes since the commit where this stash was created.',
}
const changes = { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed' } as const

function ComparisonResult({ result }: { result: SourceControlComparison }) {
  const visible = result.changes.slice(0, 200)
  const limited = result.truncated || visible.length < result.changes.length
  return <>
    <p className="source-control-empty" role="status">{relations[result.relation]}</p>
    <p className="source-control-empty">{result.relation === 'stash' ? 'Stash base' : 'HEAD'} <code title={result.from}>{result.from.slice(0, 10)}</code>
      {' → '}<code title={result.to}>{result.to.slice(0, 10)}</code>
    </p>
    {visible.length ? <ul className="git-browser-list" aria-label="Changed files" tabIndex={0}>
      {visible.map(change => <li key={change.path} className="git-browser-ref">
        <span className="git-browser-name" dir="auto">{change.path}</span>
        <small>{changes[change.status]}</small>
      </li>)}
    </ul> : <p className="source-control-empty">{limited ? 'No file paths available to display.' : 'No changed files.'}</p>}
    {limited && <p className="source-control-empty">Some changed files are omitted from this preview.</p>}
    {result.includesUntrackedParent && <p className="source-control-empty">This stash also contains untracked files outside this preview.</p>}
  </>
}

function RefForm({ kind, busy, from, create }: {
  kind: 'branch' | 'tag'; busy: boolean; from?: string; create: ComparisonProps['createRef']
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  return <div className="git-browser-create">
    {!open ? <button className="button" type="button" disabled={busy || !from} onClick={() => setOpen(true)}>
      <Icon name="plus" size={12}/>{kind === 'branch' ? 'New branch…' : 'Create lightweight tag…'}
    </button> : from && <form onSubmit={event => {
      event.preventDefault()
      if (!busy && name.trim()) create(kind, name, from)
    }}>
      <label>{kind === 'branch' ? 'Branch name' : 'Tag name'}<input autoFocus required value={name} onChange={event => setName(event.target.value)}
        spellCheck={false} autoCapitalize="none" autoComplete="off" disabled={busy}/></label>
      <p>Create from HEAD <code title={from}>{from.slice(0, 10)}</code>. Your current checkout stays in place.</p>
      <div className="git-browser-form-actions">
        <button className="button" type="submit" disabled={busy || !name.trim()}>{kind === 'branch' ? 'Create branch' : 'Create lightweight tag'}</button>
        <button className="button" type="button" disabled={busy} onClick={() => { setName(''); setOpen(false) }}>Cancel</button>
      </div>
    </form>}
    {!from && <p>{kind === 'branch' ? 'Create a commit first to start a new branch.' : 'Create a commit first to tag it.'}</p>}
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
