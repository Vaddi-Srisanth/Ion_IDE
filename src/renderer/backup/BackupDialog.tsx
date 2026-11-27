import { useEffect, useRef, useState } from 'react'
import { backupCategories, backupLabels, type BackupCategory, type BackupFolder, type BackupProgress, type BackupReview } from '../../shared/backup'
import { Modal } from '../Dialogs'
import { errorMessage } from '../documents'
import './backup.css'

const size = (bytes: number) => bytes < 1024 ? bytes + ' B' : (bytes / 1024 ** 2).toFixed(2) + ' MiB'
export function BackupDialog({ mode, checkpoint, onApply, onClose }: {
  mode: 'backup' | 'restore'; checkpoint(): Promise<void>; onApply(token: string): void; onClose(): void
}) {
  const api = window.ion.backup
  const [folders, setFolders] = useState<BackupFolder[]>([])
  const [categories, setCategories] = useState<BackupCategory[]>([...backupCategories])
  const [review, setReview] = useState<BackupReview | null>(null)
  const [replace, setReplace] = useState<BackupCategory[]>([])
  const [copies, setCopies] = useState<string[]>([])
  const [mappings, setMappings] = useState<Record<string, string>>({})
  const [ready, setReady] = useState<{ token: string; rollback: string } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('')
  const [progress, setProgress] = useState<BackupProgress | null>(null), [page, setPage] = useState(0)
  const mounted = useRef(true), handingOff = useRef(false), started = useRef(false)
  const task = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('')
    try { await work() } catch (e) { if (mounted.current) setError(errorMessage(e)) }
    finally { if (mounted.current) { setBusy(false); setProgress(null) } }
  }
  const open = (legacy = false) => task(async () => {
    await checkpoint(); const result = await api.openRestore(legacy)
    if (mounted.current && result) { setReview(result); setReplace([]); setCopies([]); setMappings({}); setReady(null); setPage(0) }
  })
  useEffect(() => {
    mounted.current = true
    const unsubscribe = api.onProgress(setProgress)
    if (!started.current) {
      started.current = true
      void api.folders().then(value => { if (mounted.current) setFolders(value) }, e => { if (mounted.current) setError(errorMessage(e)) })
      if (mode === 'restore') void open()
    }
    return () => { mounted.current = false; unsubscribe(); if (!handingOff.current) void api.cancel().catch(() => {}) }
  }, []) // Each mounted dialog owns exactly one review and one subscription.
  const chooseFolder = () => task(async () => {
    const folder = await api.chooseFolder()
    if (folder && mounted.current) setFolders(previous => previous.some(f => f.id === folder.id) ? previous : [...previous, folder])
  })
  const toggle = <T,>(items: T[], value: T) => items.includes(value) ? items.filter(item => item !== value) : [...items, value]
  const close = () => { void task(async () => { await api.cancel(); onClose() }) }
  const associations = review?.projects.filter(item => replace.includes(item.category)) ?? []
  return <Modal title={mode === 'backup' ? 'Back Up My Ion Data' : 'Restore From Backup'} className="preferences backup-dialog" onClose={close} busy={busy}>
    <p>Local, offline and unencrypted. Credentials, browser data and execution approvals are excluded. Notes, code and drafts may still contain sensitive text.</p>
    {mode === 'backup' && !review && <>
      <fieldset disabled={busy}><legend>Ion data to include</legend>
        {backupCategories.map(category => <label className="backup-check" key={category}><input type="checkbox" checked={categories.includes(category)}
          onChange={() => setCategories(previous => toggle(previous, category))}/>{backupLabels[category]}</label>)}
      </fieldset>
      <fieldset disabled={busy}><legend>Project folders · working files are not copied by default</legend>
        {folders.length ? folders.map(folder => <label className="backup-folder" key={folder.id}><span>{folder.name}</span><select aria-label={folder.name + ' backup policy'} value={folder.mode}
          onChange={event => setFolders(previous => previous.map(f => f.id === folder.id ? { ...f, mode: event.target.value as BackupFolder['mode'] } : f))}>
          <option value="reference">Reference only</option><option value="copy">Copy working files</option><option value="exclude">Exclude</option>
        </select></label>) : <p>No folder selected.</p>}
        <button className="button" onClick={chooseFolder}>Choose Folder…</button>
        <p>Copies exclude dependencies, build output, .git, credential and environment filenames, links and special files. Review the exact included files and exclusions before creating the archive.</p>
      </fieldset>
      <button className="button primary" disabled={busy || !categories.length} onClick={() => void task(async () => {
        await checkpoint(); const result = await api.review({ categories, folders }); if (mounted.current) setReview(result)
      })}>Review Backup</button>
    </>}
    {mode === 'restore' && !review && <div className="backup-actions">
      <button className="button" disabled={busy} onClick={() => void open()}>Choose .ionbackup…</button>
      <button className="button" disabled={busy} onClick={() => void open(true)}>Open Legacy Profile Folder…</button>
    </div>}
    {review && <>
      <p><b>{review.name}</b> · {review.files.toLocaleString()} files · {size(review.bytes)}</p>
      {review.warnings.map(w => <p className="muted" key={w}>{w}</p>)}
      {mode === 'restore' && <fieldset disabled={busy || Boolean(ready)}><legend>Keep current data by default · explicitly select changes</legend>
        {review.categories.map(c => <label className="backup-check" key={c.id}><input type="checkbox" checked={replace.includes(c.id)}
          onChange={() => setReplace(previous => toggle(previous, c.id))}/><span>{c.id === 'recovery' ? 'Import detached drafts; keep current drafts' : (c.conflict ? 'Replace ' : 'Restore ') + backupLabels[c.id]}
          <small>{c.files} files · {size(c.bytes)}{!c.present ? ' · empty category' : ''}</small></span></label>)}
      </fieldset>}
      {mode === 'restore' && review.folders.some(f => f.mode === 'copy') && <fieldset disabled={busy || Boolean(ready)}><legend>Optional copied workspaces · always a NEW destination</legend>
        {review.folders.filter(f => f.mode === 'copy').map(f => <label className="backup-check" key={f.id}><input type="checkbox" checked={copies.includes(f.id)} onChange={() => setCopies(previous => toggle(previous, f.id))}/>{f.name}</label>)}
      </fieldset>}
      {mode === 'restore' && associations.length > 0 && <fieldset disabled={busy || Boolean(ready)}><legend>Relink selected records to a workspace</legend>
        <p>Unmapped records stay preserved. Relinking does not approve tests or grant execution permission.</p>
        {associations.map(p => <label className="backup-folder" key={p.id}><span>{p.title}<small>{p.originalPath || 'Original folder unknown'}</small></span>
          <select aria-label={'Relink ' + p.title} value={mappings[p.id] || ''} onChange={event => setMappings(previous => ({ ...previous, [p.id]: event.target.value }))}>
            <option value="">Keep unmapped</option>
            {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            {review.folders.filter(f => copies.includes(f.id)).map(f => <option key={f.id} value={f.id}>New copy: {f.name}</option>)}
          </select></label>)}
        <button className="button" onClick={chooseFolder}>Choose Relocated Folder…</button>
      </fieldset>}
      <details><summary>Review included files ({review.entries.length})</summary><ol className="backup-files" start={page * 100 + 1}>
        {review.entries.slice(page * 100, page * 100 + 100).map(e => <li key={e.path}><span>{e.path}</span><small>{size(e.bytes)}</small></li>)}
      </ol><div className="backup-actions"><button className="button" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
        <span>Page {page + 1} / {Math.max(1, Math.ceil(review.entries.length / 100))}</span>
        <button className="button" disabled={(page + 1) * 100 >= review.entries.length} onClick={() => setPage(p => p + 1)}>Next</button></div></details>
      <details><summary>Exclusions</summary><ul>{review.exclusions.map((e, i) => <li key={i}><b>{e.name}</b>: {e.reason}</li>)}</ul>
        {review.exclusionsOmitted > 0 && <p>{review.exclusionsOmitted} additional exclusions were omitted from this bounded list.</p>}</details>
      {ready ? <div role="status"><p>A verified rollback backup will be created at:</p><p className="backup-path">{ready.rollback}</p>
        <p>Ion will ask you to Save, Keep Drafts or Cancel. Changes made since review require another review. Stop all tools first. The restore runs before stores open on restart.</p>
        <button className="button primary" disabled={busy} onClick={() => { handingOff.current = true; onApply(ready.token) }}>Continue to Safe Restart</button>
      </div> : mode === 'backup' ? <div className="backup-actions">
        <button className="button" disabled={busy} onClick={() => void task(async () => { await api.cancel(); setReview(null) })}>Change Scope</button>
        <button className="button primary" disabled={busy} onClick={() => void task(async () => {
          const path = await api.create(review.token); if (path && mounted.current) { setStatus('Backup created: ' + path); setReview(null) }
        })}>Create .ionbackup…</button>
      </div> : <button className="button primary" disabled={busy || !replace.length} onClick={() => void task(async () => {
        const result = await api.prepareRestore(review.token, { replace, copyFolders: copies, mappings: Object.entries(mappings).filter(([id, folderId]) => folderId && associations.some(item => item.id === id)).map(([id, folderId]) => ({ id, folderId })) })
        if (mounted.current) setReady(result)
      })}>Review Restart and Rollback</button>}
    </>}
    {progress && <p role="status">{progress.phase} · {progress.files} files · {size(progress.bytes)}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}{status && <p role="status" className="backup-path">{status}</p>}
    <footer className="modal-footer"><button className="button" onClick={close}>{busy ? 'Cancel Operation' : 'Close'}</button></footer>
  </Modal>
}
