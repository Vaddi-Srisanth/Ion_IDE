import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SourceControlBridge, SourceControlBrowse, SourceControlComparison, SourceControlComparisonRequest,
  SourceControlFetchRequest, SourceControlSwitchRequest } from '../../shared/source-control'
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

export default function RepositoryBrowser({ bridge, busy, perform, currentBranch, refreshStatus, canSnapshotStash, canPopStash, canMergeBranch, dirtyPaths }: {
  bridge: SourceControlBridge
  busy: boolean
  perform(task: () => Promise<void>): Promise<void>
  currentBranch?: string
  refreshStatus(): Promise<void>
  canSnapshotStash: boolean
  canPopStash: boolean
  canMergeBranch: boolean
  dirtyPaths: string[]
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

  function switchBranch(selection: SourceControlSwitchRequest) {
    void perform(async () => {
      const id = request.current
      setFeedback(undefined)
      if (!await bridge.switchBranch(selection) || request.current !== id) return
      await refreshStatus()
      if (request.current !== id) return
      setFeedback({ message: 'Switched to ' + selection.target + '.' })
      await read()
    })
  }

  function fetchGitHub(selection: SourceControlFetchRequest) {
    void perform(async () => {
      const id = request.current
      setFeedback(undefined)
      const result = await bridge.fetchGitHub(selection)
      if (!result || request.current !== id) return
      setFeedback({ message: selection.remote + '/' + selection.branch
        + (result.changed ? ' advanced to ' + result.oid.slice(0, 10) + '.' : ' is already up to date.') })
      await read()
    })
  }

  function saveStashSnapshot() {
    void perform(async () => {
      const id = ++request.current
      setFeedback(undefined)
      try {
        const oid = await bridge.saveStashSnapshot()
        if (!oid || request.current !== id) return
        await refreshStatus()
        if (request.current !== id) return
        await read()
        setFeedback({ message: 'Saved a local stash snapshot. Your index and working files remain in place.' })
      } catch (reason) {
        if (request.current !== id) return
        await refreshStatus().catch(() => {})
        if (request.current !== id) return
        setFeedback({ message: errorMessage(reason), error: true })
        await read()
      }
    })
  }

  function popStash(oid: string) {
    void perform(async () => {
      const id = ++request.current
      setFeedback(undefined)
      try {
        const result = await bridge.popStash({ oid, dirtyPaths })
        if (request.current !== id) return
        if (!result) { await read(); return }
        await refreshStatus()
        if (request.current !== id) return
        await read()
        if (result.conflicts) setFeedback({ message: 'Stash application conflicted. Git kept the stash; resolve the conflicts before continuing.', error: true })
        else setFeedback({ message: 'Applied the stash and removed it from the stash list.' })
      } catch (reason) {
        if (request.current !== id) return
        await refreshStatus().catch(() => {})
        if (request.current !== id) return
        setFeedback({ message: errorMessage(reason), error: true })
        await read()
      }
    })
  }

  function mergeBranch(selection: { current: string; target: string; from: string; to: string }) {
    void perform(async () => {
      const id = ++request.current
      setFeedback(undefined)
      try {
        const result = await bridge.mergeBranch({ ...selection, dirtyPaths })
        if (request.current !== id) return
        if (!result) { await read(); return }
        await refreshStatus()
        if (request.current !== id) return
        await read()
        if (result.conflicts) setFeedback({ message: 'Merge has conflicts. Resolve each conflict, stage the resolutions, then commit the merge.', error: true })
        else if (result.applied) setFeedback({ message: 'Merge applied. Review the staged changes and commit when ready.' })
        else setFeedback({ message: 'The selected branch is already up to date.' })
      } catch (reason) {
        if (request.current !== id) return
        await refreshStatus().catch(() => {})
        if (request.current !== id) return
        setFeedback({ message: errorMessage(reason), error: true })
        await read()
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
          ? <ComparisonView key={view + state.revision} {...{ view, bridge, busy, perform, currentBranch, createRef, switchBranch, mergeBranch, fetchGitHub, canSnapshotStash, canPopStash, canMergeBranch, saveStashSnapshot, popStash }} data={state.data}/>
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
  switchBranch(selection: SourceControlSwitchRequest): void
  fetchGitHub(selection: SourceControlFetchRequest): void
  mergeBranch(selection: { current: string; target: string; from: string; to: string }): void
  canSnapshotStash: boolean
  canPopStash: boolean
  canMergeBranch: boolean
  saveStashSnapshot(): void
  popStash(oid: string): void
}

function ComparisonView({ view, bridge, data, busy, currentBranch, perform, createRef, switchBranch, mergeBranch, fetchGitHub,
  canSnapshotStash, canPopStash, canMergeBranch, saveStashSnapshot, popStash }: ComparisonProps) {
  const [preview, setPreview] = useState<Preview>()
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [bridge])
  const head = data.commits[0]?.oid
  const cached = view === 'cachedRemoteBranches'
  const offlineNote = cached && <p className="source-control-empty">Comparisons use the Git refs stored on this computer and run offline.</p>
  const remote = cached && preview ? data.remotes.filter(row => preview.label.startsWith(row.name + '/'))
    .sort((left, right) => right.name.length - left.name.length)[0] : undefined
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
    {preview.kind === 'ready' && <>
      <ComparisonResult result={preview.result}/>
      {view === 'branches' && currentBranch && currentBranch !== preview.label && (
        !preview.result.truncated && !preview.result.changes.length
          ? <div className="git-browser-create"><button type="button" className="button" disabled={busy}
              onClick={() => switchBranch({ current: currentBranch, target: preview.label, from: preview.result.from, to: preview.result.to })}>
              Review switch…
            </button></div>
          : <p className="source-control-empty">Ion can switch here when both branches have identical file trees.</p>)}
      {view === 'branches' && currentBranch && currentBranch !== preview.label
        && (preview.result.relation === 'ahead' || preview.result.relation === 'diverged') && (
        <div className="git-browser-create">
          <p>Merge applies the selected branch to your current branch without creating a commit. Review the staged result before committing.</p>
          <button type="button" className="button" disabled={!canMergeBranch || busy}
            onClick={() => mergeBranch({ current: currentBranch, target: preview.label, from: preview.result.from, to: preview.result.to })}>
            Review merge…
          </button>
        </div>)}
      {remote?.repository && <div className="git-browser-create">
        <p>Fetch one branch from {remote.repository} and update the local cache.</p>
        <button type="button" className="button" disabled={busy} onClick={() => fetchGitHub({
          repository: remote.repository!, remote: remote.name, branch: preview.label.slice(remote.name.length + 1), previous: preview.result.to,
          access: 'public',
        })}>Review public fetch…</button>
        <button type="button" className="button" disabled={busy} onClick={() => fetchGitHub({
          repository: remote.repository!, remote: remote.name, branch: preview.label.slice(remote.name.length + 1), previous: preview.result.to,
          access: 'authenticated',
        })}>Review fetch with GitHub account…</button>
      </div>}
    </>}
  </section>

  const stash = data.stash
  if (view === 'stash') return <div className="git-browser-create">
    {stash ? <><p>Latest stash <code title={stash.oid}>{stash.oid.slice(0, 10)}</code></p>
      <button className="button" type="button" disabled={!head || busy} onClick={() => compare('stash', 'refs/stash', stash.oid)}>
        Preview latest stash
      </button></> : <p className="source-control-empty" role="status">{empty.stash}</p>}
    {stash && <button className="button" type="button" disabled={!canPopStash || busy} onClick={() => popStash(stash.oid)}>
      Apply and pop latest stash…
    </button>}
    <p className="source-control-empty">Save a snapshot of tracked staged and working changes. Files stay in place; untracked files are excluded. Applying a stash restores file changes to the working tree.</p>
    <button className="button" type="button" disabled={!canSnapshotStash || busy} onClick={saveStashSnapshot}>
      Save tracked changes to stash…
    </button>
  </div>

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
