import { useEffect, useState } from 'react'
import type { SourceControlBridge, SourceControlConflict } from '../../shared/source-control'
import { Modal } from '../Dialogs'
import { errorMessage } from '../documents'
import './conflict-review.css'

export default function ConflictReview({ path, bridge, onClose }: {
  path: string; bridge: SourceControlBridge; onClose(): void
}) {
  const [review, setReview] = useState<SourceControlConflict>()
  const [error, setError] = useState('')
  const [side, setSide] = useState<'base' | 'ours' | 'theirs'>('ours')
  useEffect(() => {
    let active = true
    setReview(undefined)
    setError('')
    void bridge.conflict({ path }).then(result => {
      if (active) setReview(result)
    }, reason => { if (active) setError(errorMessage(reason)) })
    return () => { active = false }
  }, [path, bridge])
  return <Modal title="Review merge conflict" className="git-conflict-review" onClose={onClose}>
    <p className="git-conflict-path">{path}</p>
    {error && <p role="alert">{error}</p>}
    {!review && !error && <p role="status">Reading the Git index…</p>}
    {review && <>
      <label>Version <select value={side} onChange={event => setSide(event.target.value as typeof side)}>
        <option value="base">Common ancestor</option><option value="ours">Ours · index stage 2</option>
        <option value="theirs">Theirs · index stage 3</option>
      </select></label>
      {review[side] === null ? <p role="status">This file is absent from that version.</p>
        : <pre tabIndex={0} aria-label="File contents">{review[side] || '(empty file)'}</pre>}
      <p>Edit and save the working file, then stage the resolution in Source Control.</p>
    </>}
    <button type="button" className="button" onClick={onClose}>Done</button>
  </Modal>
}

export { ConflictReview }
