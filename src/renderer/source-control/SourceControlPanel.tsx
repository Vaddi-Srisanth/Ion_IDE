import { useEffect, useRef, useState } from 'react'
import type { GitDiffSide, GitStatusCode, SourceControlBridge, SourceControlDiff, SourceControlEntry,
  SourceControlStatus } from '../../shared/source-control'
import { errorMessage } from '../documents'
import { Icon } from '../icons'
import './source-control.css'

interface Props {
  bridge: SourceControlBridge
  onClose(): void
  onEntries(entries: SourceControlEntry[]): void
  onDiff(diff: SourceControlDiff): void
  isDirty(path: string): boolean
  revision?: number
}

const statusLabels: Record<GitStatusCode, string> = {
  '': '', M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied',
  T: 'Type changed', U: 'Conflict', '?': 'Untracked',
}
const pageSize = 80

export default function SourceControlPanel({ bridge, onClose, onEntries, onDiff, isDirty, revision }: Props) {
  const [status, setStatus] = useState<SourceControlStatus>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selection, setSelection] = useState<string>()
  const mounted = useRef(false)
  const pending = useRef(false)
  const refreshRequested = useRef(false)
  const lastRevision = useRef(revision)
  const listeners = useRef({ onEntries, onDiff })
  listeners.current = { onEntries, onDiff }

  async function loadStatus() {
    const current = await bridge.status()
    if (!mounted.current) return
    setStatus(current)
    listeners.current.onEntries(current.kind === 'repository' ? current.entries : [])
  }

  async function act(task: () => Promise<void>) {
    if (pending.current || !mounted.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try { await task() }
    catch (reason) { if (mounted.current) setError(errorMessage(reason)) }
    finally {
      pending.current = false
      if (mounted.current) {
        setBusy(false)
        if (refreshRequested.current) {
          refreshRequested.current = false
          void act(loadStatus)
        }
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    void act(loadStatus)
    return () => { mounted.current = false; refreshRequested.current = false }
  }, [bridge])

  useEffect(() => {
    if (lastRevision.current === revision) return
    if (status?.kind !== 'repository') return
    lastRevision.current = revision
    const timer = setTimeout(() => {
      // A source-save event while diff/stage/commit is pending must survive
      // the debounce. Drain one coalesced refresh when that operation settles.
      if (pending.current) refreshRequested.current = true
      else void act(loadStatus)
    }, 450)
    return () => clearTimeout(timer)
  }, [revision, bridge, status?.kind])

  const repository = status?.kind === 'repository' ? status : undefined
  const staged = repository?.entries.filter(({ index, unmerged }) => index && !unmerged) ?? []
  const working = repository?.entries.filter(({ worktree, unmerged }) => worktree || unmerged) ?? []
  const conflict = repository?.entries.some(({ unmerged }) => unmerged)
  const review = (entry: SourceControlEntry, side: GitDiffSide) => void act(async () => {
    const diff = await bridge.diff({ path: entry.path, side })
    if (!mounted.current) return
    setSelection(side + ':' + entry.path)
    listeners.current.onDiff(diff)
  })
  const change = (entry: SourceControlEntry, side: GitDiffSide) => void act(async () => {
    await bridge.change({ path: entry.path, action: side === 'staged' ? 'unstage' : 'stage' })
    if (mounted.current) await loadStatus()
  })

  return <aside className="source-control-pane" aria-label="Source Control" data-testid="source-control">
    <div className="pane-title">
      <span>Source Control</span>
      <div className="pane-tools">
        <button type="button" className="icon-button" onClick={() => void act(loadStatus)} disabled={busy}
          title="Refresh Git Status" aria-label="Refresh Git Status" data-testid="git-refresh"><Icon name="refresh" size={14}/></button>
        <button type="button" className="icon-button" onClick={onClose} title="Close Source Control" aria-label="Close Source Control">
          <Icon name="x" size={14}/>
        </button>
      </div>
    </div>
    <div className="source-control-body" aria-busy={busy}>
      {error && <p className="source-control-notice" role="alert">{error}</p>}
      {notice && <p className="source-control-notice" role="status">{notice}</p>}
      {!status && !error && <p className="source-control-empty" role="status">Checking repository…</p>}
      {status?.kind === 'untrusted' ? <section className="source-control-trust" aria-label="Repository trust">
        <p>{status.message}</p>
        <button className="button" type="button" data-testid="git-trust" disabled={busy} onClick={() => void act(async () => {
          if (await bridge.trust() && mounted.current) await loadStatus()
        })}>Trust Repository…</button>
      </section> : status && status.kind !== 'repository' && <p className="source-control-empty">{status.message}</p>}
      {repository && <>
        <div className="source-control-branch" data-testid="git-branch">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="17" cy="6" r="2.5"/>
            <path d="M6 7.5v9m11-8c0 5-7 5-11 5"/>
          </svg>
          <strong title={repository.branch}>{repository.branch}</strong>
          {repository.detached && <span>Detached</span>}
          {repository.unborn && <span>First commit</span>}
        </div>
        <form className="source-control-commit" onSubmit={(event) => {
          event.preventDefault()
          if (!staged.length || conflict || repository.truncated || !message.trim()) return
          void act(async () => {
            await bridge.commit({ message })
            if (!mounted.current) return
            setMessage((current) => current === message ? '' : current)
            await loadStatus()
            if (mounted.current) setNotice('Staged changes committed locally.')
          })
        }}>
          <textarea aria-label="Commit message" placeholder="Commit message" maxLength={4096} rows={2}
            value={message} onChange={(event) => setMessage(event.target.value)} data-testid="git-commit-message"/>
          <button type="submit" className="button" data-testid="git-commit"
            disabled={busy || !message.trim() || !staged.length || conflict || repository.truncated}>
            <Icon name="check" size={13}/>Commit staged changes
          </button>
          {conflict && <p>Resolve conflicts before committing.</p>}
          {repository.truncated && <p role="status">Some changes exceed the status limit. Review and commit in your terminal.</p>}
        </form>
        {staged.length > 0 && <Changes title="Staged" side="staged" entries={staged} {...{ busy, selection, isDirty, review, change }}/>}
        {working.length > 0 && <Changes title="Changes" side="working" entries={working} {...{ busy, selection, isDirty, review, change }}/>}
        {staged.length === 0 && working.length === 0 && <p className="source-control-empty">Working tree is clean.</p>}
      </>}
    </div>
  </aside>
}

function Changes({ title, side, entries, busy, selection, isDirty, review, change }: {
  title: string
  side: GitDiffSide
  entries: SourceControlEntry[]
  busy: boolean
  selection?: string
  isDirty(path: string): boolean
  review(entry: SourceControlEntry, side: GitDiffSide): void
  change(entry: SourceControlEntry, side: GitDiffSide): void
}) {
  const [visible, setVisible] = useState(pageSize)
  return <section aria-label={title} className="source-control-group" data-testid={'git-' + side}>
    <h3>{title}<span>{entries.length}</span></h3>
    <ul>
      {entries.slice(0, visible).map((entry) => {
        const status = entry.unmerged ? 'U' : side === 'staged' ? entry.index : entry.worktree
        const label = statusLabels[status]
        const name = entry.path.split('/').at(-1)
        const folder = entry.path.slice(0, entry.path.lastIndexOf('/') + 1)
        const dirty = side === 'working' && isDirty(entry.absolutePath)
        const action = side === 'staged' ? 'Unstage' : 'Stage'
        const selected = selection === side + ':' + entry.path
        return <li key={entry.path} className="source-control-change" data-selected={selected || undefined}>
          <button className="source-control-change-name" type="button" data-testid="git-open-diff" data-git-path={entry.path}
            title={entry.previousPath ? entry.previousPath + ' → ' + entry.path : entry.path}
            aria-label={`Open ${side === 'staged' ? 'staged' : 'working tree'} diff for ${entry.path} (${label})`}
            disabled={busy} onClick={() => review(entry, side)}>
            <span className="source-control-code" data-code={status} aria-hidden="true">{status}</span>
            <span className="source-control-filename">{name}</span>
            {folder && <span className="source-control-folder">{folder}</span>}
          </button>
          {dirty && <span className="source-control-dirty" aria-label="Unsaved edits" title="Save your edits before staging"><Icon name="warning" size={13}/></span>}
          <button className="icon-button" type="button" disabled={busy || dirty} data-testid={'git-' + action.toLowerCase()}
            data-git-path={entry.path} title={dirty ? 'Save your edits before staging' : `${action} ${entry.path}`}
            aria-label={`${action} ${entry.path}`} onClick={() => change(entry, side)}>
            {side === 'staged' ? <span aria-hidden="true">−</span> : <Icon name="plus" size={14}/>}
          </button>
        </li>
      })}
    </ul>
    {visible < entries.length && <button type="button" className="button source-control-more"
      onClick={() => setVisible((count) => count + pageSize)}>Show more changes</button>}
  </section>
}
