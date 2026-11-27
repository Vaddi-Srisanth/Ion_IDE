import { useEffect, useRef, useState } from 'react'
import type { TaskDefinition, TaskRecord, TasksBridge } from '../../shared/tasks'
import { Modal } from '../Dialogs'
import { errorMessage } from '../documents'
import './tasks.css'

interface TaskPickerProps {
  api: TasksBridge
  root: string
  onRun(record: TaskRecord, task: TaskDefinition): void
  onClose(): void
}

export default function TaskPicker({ api, root, onRun, onClose }: TaskPickerProps) {
  const [record, setRecord] = useState<TaskRecord | null>()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = useRef(true)

  useEffect(() => {
    current.current = true
    setBusy(true)
    void api.list(root).then(value => value ?? api.discover(root)).then(value => {
      if (current.current) setRecord(value)
    }, reason => {
      if (current.current) setError(errorMessage(reason))
    }).finally(() => { if (current.current) setBusy(false) })
    return () => { current.current = false }
  }, [api, root])

  function refresh() {
    if (busy) return
    setBusy(true)
    setError('')
    void api.discover(root).then(value => {
      if (current.current) setRecord(value)
    }, reason => {
      if (current.current) setError(errorMessage(reason))
    }).finally(() => { if (current.current) setBusy(false) })
  }

  const needle = query.trim().toLocaleLowerCase()
  const tasks = (record?.tasks ?? []).filter(task => !needle
    || `${task.label} ${task.adapter} ${task.selector}`.toLocaleLowerCase().includes(needle))

  return <Modal title="Run Task" className="task-picker" onClose={onClose}>
    <div className="task-picker-toolbar">
      <input className="picker-input" aria-label="Filter tasks" placeholder="Filter build tasks…" value={query}
        onChange={event => setQuery(event.target.value)} autoFocus spellCheck={false} maxLength={120}/>
      <button className="button" type="button" onClick={refresh} disabled={busy}>Refresh</button>
    </div>
    <p className="task-picker-note">Tasks are discovered from top-level project manifests. Ion shows the exact executable and arguments for approval before anything runs.</p>
    <div className="task-picker-list" role="list" aria-label="Available tasks">
      {tasks.map(task => <button key={task.id} type="button" role="listitem" disabled={busy || !record}
        onClick={() => record && onRun(record, task)}>
        <span><strong>{task.label}</strong><small>{task.adapter} · {task.selector}</small></span>
        {task.dependsOn.length > 0 && <i>{task.dependsOn.length} prerequisite{task.dependsOn.length === 1 ? '' : 's'}</i>}
      </button>)}
    </div>
    <p className={error ? 'form-error' : 'picker-note'} role="status">
      {error || (busy ? 'Inspecting project manifests…' : record && !tasks.length
        ? (record.tasks.length ? 'No tasks match this filter.' : 'No supported top-level build manifests were found.') : '')}
    </p>
  </Modal>
}
