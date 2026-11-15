import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../../shared/contracts'
import type { ExplanationReply, ExplanationReview } from '../../shared/explanations'
import type { ProjectRecord, ProjectsBridge, ProjectSpec } from '../../shared/projects'
import { mergeProjectRecommendations } from '../../shared/project-recommendations'
import { Modal } from '../Dialogs'
import { errorMessage } from '../documents'
import './projects.css'

interface Props {
  root: Entry
  reply: ExplanationReply
  review: ExplanationReview
  bridge: ProjectsBridge
  onClose(): void
  onSaved(): void
  onDirtyChange?(dirty: boolean): void
}
export function ReviewRecommendations({ root, reply, review, bridge, onClose, onSaved, onDirtyChange }: Props) {
  const [record, setRecord] = useState<ProjectRecord | null>()
  const [draft, setDraft] = useState(() => structuredClone(reply.recommendations))
  const [selected, setSelected] = useState<string[]>([])
  const [title, setTitle] = useState(root.name.slice(0, 120))
  const [goal, setGoal] = useState('Review and implement the selected improvements using evidence from this project.')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [discard, setDiscard] = useState(false)
  const [edited, setEdited] = useState(false)
  const mounted = useRef(false), busy = useRef(false), generation = useRef(0)
  const dirty = selected.length > 0 || edited
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; generation.current++; onDirtyChange?.(false) }
  }, [root.path, bridge])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  async function load() {
    if (busy.current) return
    busy.current = true; setPending(true); setError('')
    const token = ++generation.current
    try {
      const value = await bridge.open(root.path)
      if (mounted.current && token === generation.current) {
        setRecord(value); setNotice('Current roadmap loaded. Your proposal edits are preserved.')
      }
    } catch (reason) { if (mounted.current && token === generation.current) setError(errorMessage(reason)) }
    finally { if (mounted.current && token === generation.current) { busy.current = false; setPending(false) } }
  }
  function update(id: string, patch: Partial<ExplanationReply['recommendations'][number]>) {
    setEdited(true); setDraft(current => current.map(item => item.id === id ? { ...item, ...patch } : item)); setError(''); setNotice('')
  }
  async function save() {
    if (busy.current || record === undefined || !selected.length) return
    busy.current = true; setPending(true); setError('')
    const token = ++generation.current
    try {
      const base: ProjectSpec = record?.spec ?? { version: 1, title: title.trim(), description: 'User-reviewed project improvements.',
        goal: goal.trim(), technologies: [], files: [], milestones: [], environment: [], tests: [] }
      const { spec } = mergeProjectRecommendations(base, draft, selected, review.sources)
      await bridge.save(root.path, spec, record?.revision ?? null)
      if (mounted.current && token === generation.current) { onDirtyChange?.(false); onSaved() }
    } catch (reason) { if (mounted.current && token === generation.current) setError(errorMessage(reason)) }
    finally { if (mounted.current && token === generation.current) { busy.current = false; setPending(false) } }
  }
  const close = () => { if (dirty) setDiscard(true); else onClose() }
  return <Modal title="Review roadmap suggestions" className="preferences" busy={pending} onClose={close}>
    <div className="project-form" data-testid="recommendation-review">
      <p>These are unverified AI suggestions based on the reviewed snapshot. Edit and select what you want to add. Changes since that snapshot may invalidate a suggestion.</p>
      <p className="project-muted">New milestones start Not started. Existing milestones, manual progress, approved tests and evidence are preserved. Nothing runs or becomes verified through this action.</p>
      {record === null && <><label>Project title<input value={title} maxLength={120} onChange={event => { setEdited(true); setTitle(event.target.value) }} disabled={pending}/></label>
        <label>Objective<textarea value={goal} maxLength={1000} onChange={event => { setEdited(true); setGoal(event.target.value) }} disabled={pending}/></label></>}
      {record && <p>Adding to <strong>{record.spec.title}</strong> · {record.spec.milestones.length} existing milestones.</p>}
      {draft.map(item => <section className="project-card" key={item.id} data-recommendation-id={item.id}>
        <label><input type="checkbox" checked={selected.includes(item.id)} disabled={pending}
          onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/> Add this milestone</label>
        <label>Title<input value={item.title} maxLength={120} disabled={pending} onChange={event => update(item.id, { title: event.target.value })}/></label>
        <label>Description<textarea value={item.description} maxLength={800} disabled={pending} onChange={event => update(item.id, { description: event.target.value })}/></label>
        <label>Acceptance criteria (one per line)<textarea value={item.acceptance.join('\n')} disabled={pending} maxLength={3200}
          onChange={event => update(item.id, { acceptance: event.target.value.split('\n') })}/></label>
        {draft.length > 1 && <label>Prerequisites (select explicitly; their milestones must also be selected)
          <select multiple size={Math.min(3, draft.length - 1)} value={item.dependsOn} disabled={pending}
            onChange={event => update(item.id, { dependsOn: Array.from(event.target.selectedOptions, option => option.value) })}>
            {draft.filter(other => other.id !== item.id).map(other => <option value={other.id} key={other.id}>{other.title}</option>)}
          </select></label>}
        {!!item.citations.length && <details><summary>Reviewed evidence · not verification</summary><ul>
          {item.citations.map((citation, index) => <li key={index}>{review.sources.find(source => source.id === citation.sourceId)?.label ?? 'Unavailable source'}: lines {citation.startLine}–{citation.endLine}</li>)}
        </ul></details>}
      </section>)}
      {error && <p className="project-error" role="alert">{error}</p>}
      {notice && <p className="project-muted" role="status">{notice}</p>}
      {discard ? <div className="project-card"><p>Discard these unsaved proposal selections and edits?</p>
        <button type="button" className="button" onClick={() => setDiscard(false)}>Continue reviewing</button>
        <button type="button" className="button" onClick={onClose}>Discard proposals</button></div> : <div className="project-actions">
        <button type="button" className="button primary" data-testid="recommendation-save" disabled={pending || record === undefined || !selected.length}
          onClick={() => void save()}>Add selected milestones</button>
        <button type="button" className="button" disabled={pending} onClick={() => void load()}>Reload current roadmap</button>
        <button type="button" className="button" disabled={pending} onClick={close}>Cancel</button>
      </div>}
    </div>
  </Modal>
}
