import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Entry, ResourceProfile } from '../../shared/contracts'
import type {
  ManualProgress, ProjectMilestone, ProjectRecord, ProjectSpec, ProjectTest, ProjectsBridge, ProviderSettings, TestEvidence,
} from '../../shared/projects'
import { errorMessage } from '../documents'
import './projects.css'

export interface ProjectsPanelProps {
  root: Entry | null
  resourceProfile: ResourceProfile
  onOpenFolder(): void
  beforeRun?(): Promise<boolean>
  onDirtyChange?(dirty: boolean): void
}

type Draft = { kind: 'new'; title: string; description: string }
  | { kind: 'edit'; json: string; revision: string | null }

const drafts = new Map<string, Draft>()
const maxDrafts = 8
const labels = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  'manually-completed': 'Manually completed',
  'test-verified': 'Test verified',
  'test-failed': 'Test failed',
  'unable-to-verify': 'Unable to verify',
}
const evidenceLabels = {
  behavior: 'Application behavior', environment: 'Environment', configuration: 'Test configuration or compilation',
  interrupted: 'Execution interrupted',
}

export default function ProjectsPanel(props: ProjectsPanelProps) {
  return (
    <section className="projects-panel" aria-label="Project roadmap" data-testid="projects-panel">
      {props.root ? <ProjectFolder key={props.root.path} {...props} root={props.root}/>
        : <div className="projects-empty">
          <h2>Project roadmap</h2>
          <p>Open a folder to create or resume its local project. Project specs and test evidence stay on this device.</p>
          <button className="button primary" onClick={props.onOpenFolder}>Open Folder</button>
        </div>}
    </section>
  )
}

function projectStatus(milestone: ProjectMilestone, record: ProjectRecord): keyof typeof labels {
  const tests = record.spec.tests.filter(test => test.milestoneId === milestone.id)
  if (!tests.length) return milestone.status
  const evidence = tests.map(test => record.evidence.find(item => item.testId === test.id))
  if (evidence.some(item => item?.outcome === 'test-failed' && !item.stale)) return 'test-failed'
  if (evidence.some(item => item?.stale || item?.outcome === 'unable-to-verify')) return 'unable-to-verify'
  if (evidence.every(item => item?.outcome === 'test-verified')) return 'test-verified'
  return milestone.status
}

function initialProject(title: string, description: string): ProjectSpec {
  return {
    version: 1, title: title.trim(), description: description.trim(), goal: description.trim().slice(0, 1000),
    technologies: [], files: [], environment: [], tests: [],
    milestones: [{
      id: 'implement', title: 'Implement the goal', description: '', dependsOn: [],
      acceptance: ['Demonstrate the requested behavior using representative input.'], status: 'not-started',
    }],
  }
}

function ProjectFolder({ root, beforeRun, onDirtyChange, resourceProfile }: ProjectsPanelProps & { root: Entry }) {
  const api = window.ion.projects
  const [record, setRecord] = useState<ProjectRecord | null | undefined>(undefined)
  const [draft, setDraft] = useState(() => drafts.get(root.path))
  const [editing, setEditing] = useState(() => drafts.get(root.path)?.kind === 'edit')
  const [newTest, setNewTest] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const revisionRef = useRef<string | null>(null)
  const mounted = useRef(false)
  const request = useRef(0)
  const pendingRefresh = useRef(false)
  const refreshRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    mounted.current = true
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (busyRef.current) {
        pendingRefresh.current = true
        return
      }
      pendingRefresh.current = false
      const id = ++request.current
      void api.open(root.path).then(value => {
        if (!mounted.current || request.current !== id || busyRef.current) return
        revisionRef.current = value?.revision ?? null
        setRecord(value)
      }, reason => {
        if (mounted.current && request.current === id) setError(errorMessage(reason))
      })
    }
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(refresh, 300)
    }
    refreshRef.current = refresh
    refresh()
    const unsubscribe = api.onSourceSaved?.(scheduleRefresh)
    window.addEventListener('focus', scheduleRefresh)
    return () => {
      mounted.current = false
      refreshRef.current = null
      clearTimeout(refreshTimer)
      window.removeEventListener('focus', scheduleRefresh)
      unsubscribe?.()
    }
  }, [api, root.path, resourceProfile])

  function setLocalDraft(value: Draft | undefined) {
    if (value && !drafts.has(root.path) && drafts.size >= maxDrafts) {
      setError('Save or discard another project draft before starting a new one.')
      return false
    }
    if (value) drafts.set(root.path, value)
    else drafts.delete(root.path)
    setDraft(value)
    onDirtyChange?.(drafts.size > 0)
    return true
  }

  async function perform<T>(operation: () => Promise<T>, complete: (value: T) => void) {
    if (busyRef.current) return
    busyRef.current = true
    request.current++
    setBusy(true)
    setError(null)
    try {
      const result = await operation()
      if (mounted.current) complete(result)
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      busyRef.current = false
      if (mounted.current) {
        setBusy(false)
        if (pendingRefresh.current) refreshRef.current?.()
      }
    }
  }

  function apply(value: ProjectRecord | null) {
    revisionRef.current = value?.revision ?? null
    setRecord(value)
  }

  function save(spec: ProjectSpec, revision = revisionRef.current, consumeDraft = false) {
    void perform(() => api.save(root.path, spec, revision), value => {
      apply(value)
      if (consumeDraft) {
        setLocalDraft(undefined)
        setEditing(false)
      }
      setNewTest(false)
    })
  }

  function saveEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (draft?.kind !== 'edit') { setEditing(false); return }
    try {
      save(JSON.parse(draft.json) as ProjectSpec, draft.revision, true)
    } catch {
      setError('The specification must be valid JSON.')
    }
  }

  const start = draft?.kind === 'new' ? draft : { kind: 'new' as const, title: '', description: '' }
  const description = record?.spec.description ?? start.description
  function propose() {
    void perform(() => api.propose(description), value => {
      if (value && setLocalDraft({ kind: 'edit', json: JSON.stringify(value, null, 2), revision: revisionRef.current })) {
        setEditing(true)
      }
    })
  }

  if (record === undefined) {
    return <div className="projects-empty">
      <h2>Project roadmap</h2>
      {error ? <><p role="alert">{error}</p><button className="button"
        onClick={() => void perform(() => api.open(root.path), apply)}>Retry</button></> : <p role="status">Loading project…</p>}
    </div>
  }

  const draftIsProposal = !record && draft?.kind === 'edit'
  return (
    <div className="projects-stack">
      <header className="projects-heading">
        <div className="projects-eyebrow">LOCAL ROADMAP</div>
        <h2>{record?.spec.title ?? 'Project roadmap'}</h2>
        <p>{root.name}</p>
        <div className="project-actions">
          <button className="button" data-testid="project-refresh" disabled={busy}
            onClick={() => void perform(() => api.open(root.path), apply)}>Refresh</button>
        </div>
      </header>
      {error && <div className="project-error" role="alert">{error}</div>}
      {busy && <p className="project-muted" role="status">Working…</p>}
      {!record && !draftIsProposal && (
        <form className="project-form project-card" onSubmit={event => {
          event.preventDefault()
          save(initialProject(start.title, start.description), null, true)
        }}>
          <h3>Create a local project</h3>
          <label>Project title
            <input data-testid="project-title" value={start.title} maxLength={120} required disabled={busy}
              onChange={event => setLocalDraft({ ...start, title: event.target.value })}/>
          </label>
          <label>What will it do?
            <textarea data-testid="project-description" value={start.description} maxLength={4000} required disabled={busy}
              onChange={event => setLocalDraft({ ...start, description: event.target.value })}/>
          </label>
          <div className="project-actions">
            <button className="button primary" data-testid="project-create" disabled={busy} type="submit">Create Offline</button>
            {draft && <button className="button" type="button" disabled={busy} onClick={() => setLocalDraft(undefined)}>Discard Draft</button>}
          </div>
        </form>
      )}
      {editing && (record || draftIsProposal) && (
        <form className="project-form project-card" onSubmit={saveEditor}>
          <h3>{draftIsProposal ? 'Review proposed project' : 'Edit project specification'}</h3>
          <p className="project-muted">Version 1 JSON. Saving a changed test requires fresh approval. Source files are your own.</p>
          <label>Project specification
            <textarea className="project-json" data-testid="project-spec-json" spellCheck={false} maxLength={128 * 1024}
              value={draft?.kind === 'edit' ? draft.json : JSON.stringify(record?.spec, null, 2)} disabled={busy}
              onChange={event => setLocalDraft({ kind: 'edit', json: event.target.value,
                revision: draft?.kind === 'edit' ? draft.revision : revisionRef.current })}/>
          </label>
          <div className="project-actions">
            <button className="button primary" data-testid="project-save" type="submit" disabled={busy || draft?.kind !== 'edit'}>Save Project</button>
            <button className="button" type="button" disabled={busy} onClick={() => {
              setLocalDraft(undefined)
              setEditing(false)
            }}>{draft?.kind === 'edit' ? 'Discard Changes' : 'Close Editor'}</button>
          </div>
        </form>
      )}
      {record && !editing && <>
        <div className="project-card">
          <h3>Goal</h3>
          <p>{record.spec.goal}</p>
          <div className="project-actions">
            <button className="button" data-testid="project-edit" onClick={() => setEditing(true)} disabled={busy}>Edit Specification</button>
          </div>
          {(record.spec.technologies.length > 0 || record.spec.environment.length > 0 || record.spec.files.length > 0) && (
            <details className="project-details">
              <summary>Technology, files, and environment</summary>
              {record.spec.technologies.length > 0 && <p>{record.spec.technologies.join(', ')}</p>}
              <ul>
                {record.spec.files.map(file => <li key={file.path}><code>{file.path}</code> · {file.required ? 'Required' : 'Optional'} · {file.purpose}</li>)}
                {record.spec.environment.map((requirement, index) => <li key={index}>{requirement}</li>)}
              </ul>
            </details>
          )}
        </div>
        <div className="project-card">
          <h3>Milestones</h3>
          <p className="project-muted">Test status reflects the last approved checks against saved source.</p>
          {record.spec.milestones.map(milestone => (
            <div className="project-milestone" key={milestone.id}>
              <strong>{milestone.title}</strong>
              <span className="project-status" data-status={projectStatus(milestone, record)}>{labels[projectStatus(milestone, record)]}</span>
              {milestone.description && <p>{milestone.description}</p>}
              {milestone.dependsOn.length > 0 && <p className="project-muted">Prerequisites · {milestone.dependsOn.map(id =>
                record.spec.milestones.find(item => item.id === id)?.title ?? id).join(', ')}</p>}
              <ul>{milestone.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul>
              <label className="project-manual-status">Manual progress
                <select aria-label={'Manual progress for ' + milestone.title} value={milestone.status} disabled={busy}
                  onChange={event => save({ ...record.spec, milestones: record.spec.milestones.map(item =>
                    item.id === milestone.id ? { ...item, status: event.target.value as ManualProgress } : item) })}>
                  <option value="not-started">Not started</option>
                  <option value="in-progress">In progress</option>
                  <option value="manually-completed">Manually completed</option>
                </select>
              </label>
            </div>
          ))}
        </div>
        <div className="project-card">
          <h3>Local behavior tests</h3>
          <p className="project-muted">One saved C file per test. Review each test before approving it. Rerun checks after changing headers or other dependencies.</p>
          {record.spec.tests.map(test => (
            <ProjectTestRow key={test.id} test={test} approved={record.approved.includes(test.id)} busy={busy}
              evidence={record.evidence.find(item => item.testId === test.id)}
              automatic={record.automatic?.includes(test.id) ?? false}
              onAutomatic={resourceProfile === 'full' && record.approved.includes(test.id)
                ? () => void perform(() => api.setAutomatic(root.path, test.id, record.revision,
                    !record.automatic?.includes(test.id)), apply)
                : undefined}
              onApprove={() => void perform(() => api.approve(root.path, test.id, record.revision), apply)}
              onRun={() => void perform(async () => {
                if (beforeRun && !await beforeRun()) return record
                return api.run(root.path, test.id, record.revision)
              }, apply)}/>
          ))}
          {newTest ? <NewTestForm spec={record.spec} disabled={busy} onSave={test =>
            save({ ...record.spec, tests: [...record.spec.tests, test] })} onCancel={() => setNewTest(false)}/>
            : <button className="button" data-testid="project-add-test" disabled={busy || record.spec.tests.length >= 16}
              onClick={() => setNewTest(true)}>Add Test</button>}
        </div>
      </>}
      {!editing && resourceProfile === 'full' && <OnlinePlanner api={api} busy={busy} canPropose={Boolean(description.trim())} onPropose={propose}/>}
    </div>
  )
}

function ProjectTestRow({ test, evidence, approved, busy, automatic, onAutomatic, onApprove, onRun }: {
  test: ProjectTest; evidence?: TestEvidence; approved: boolean; busy: boolean; automatic: boolean;
  onAutomatic?(): void; onApprove(): void; onRun(): void;
}) {
  return (
    <details className="project-test">
      <summary>{test.title} <span className="project-muted">· {approved ? 'Approved' : 'Review required'}</span></summary>
      <div className="project-test-content">
        <p>Source <code>{test.source}</code></p>
        <p>Expected exit code <code>{test.exitCode}</code></p>
        <label>Standard input<pre>{test.stdin || '(empty)'}</pre></label>
        <label>Expected standard output ({test.match})<pre>{test.expectedOutput || '(empty)'}</pre></label>
        {evidence && <div className="project-evidence" data-testid="project-evidence"
          data-status={evidence.stale ? 'unable-to-verify' : evidence.outcome}>
          <strong>{evidence.stale ? 'Stale evidence' : labels[evidence.outcome]}</strong>
          <p>{evidenceLabels[evidence.kind]} · {new Date(evidence.checkedAt).toLocaleString()} · {evidence.durationMs} ms</p>
          <p>{evidence.message}</p>
          {evidence.exitCode !== null && <p>Observed exit code <code>{evidence.exitCode}</code></p>}
          {evidence.captured && <pre>{evidence.captured}</pre>}
          {evidence.compilerOutput && <pre>{evidence.compilerOutput}</pre>}
        </div>}
        <div className="project-actions">
          {onAutomatic && <button className="button" data-testid="project-auto-test" disabled={busy}
            aria-pressed={automatic} onClick={onAutomatic}>{automatic ? 'Run on Save On' : 'Run on Save Off'}</button>}
          {approved
            ? <button className="button primary" data-testid="project-run-test" disabled={busy} onClick={onRun}>Run Test</button>
            : <button className="button" data-testid="project-approve-test" disabled={busy} onClick={onApprove}>Approve Test…</button>}
        </div>
      </div>
    </details>
  )
}

function NewTestForm({ spec, disabled, onSave, onCancel }: {
  spec: ProjectSpec; disabled: boolean; onSave(test: ProjectTest): void; onCancel(): void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const title = String(form.get('title') ?? '').trim()
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
    const used = new Set(spec.tests.map(item => item.id))
    let id = 'test-' + (slug || 'behavior')
    for (let i = 2; used.has(id); i++) id = 'test-' + (slug || 'behavior') + '-' + i
    onSave({
      id, title, milestoneId: String(form.get('milestone')), source: String(form.get('source')).trim(),
      stdin: String(form.get('stdin')), expectedOutput: String(form.get('output')),
      match: form.get('match') === 'contains' ? 'contains' : 'exact', exitCode: Number(form.get('exit')),
    })
  }
  return (
    <form className="project-form project-add-test" onSubmit={submit}>
      <label>Test title<input name="title" data-testid="project-test-title" maxLength={120} required disabled={disabled}/></label>
      <label>Milestone<select name="milestone" disabled={disabled}>{spec.milestones.map(item =>
        <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label>Relative C source<input name="source" data-testid="project-test-source" defaultValue="main.c" maxLength={240} required disabled={disabled}/></label>
      <label>Standard input<textarea name="stdin" maxLength={4096} disabled={disabled}/></label>
      <label>Expected standard output<textarea name="output" data-testid="project-test-output" maxLength={4096} disabled={disabled}/></label>
      <label>Output comparison<select name="match" disabled={disabled}><option value="exact">Exact</option><option value="contains">Contains</option></select></label>
      <label>Expected exit code<input type="number" name="exit" defaultValue={0} min={0} max={255} required disabled={disabled}/></label>
      <div className="project-actions">
        <button className="button primary" data-testid="project-save-test" type="submit" disabled={disabled}>Save Test</button>
        <button className="button" type="button" onClick={onCancel} disabled={disabled}>Cancel</button>
      </div>
    </form>
  )
}

function OnlinePlanner({ api, busy, canPropose, onPropose }: {
  api: ProjectsBridge; busy: boolean; canPropose: boolean; onPropose(): void;
}) {
  const [settings, setSettings] = useState<ProviderSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const keyRef = useRef<HTMLInputElement>(null)
  const endpointRef = useRef<HTMLInputElement>(null)
  const modelRef = useRef<HTMLInputElement>(null)

  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const button = (event.nativeEvent as SubmitEvent).submitter
    const forgetKey = button?.getAttribute('data-forget') === 'true'
    const apiKey = keyRef.current?.value ?? ''
    if (keyRef.current) keyRef.current.value = ''
    setPending(true)
    setError(null)
    try {
      setSettings(await api.configure({
        endpoint: endpointRef.current?.value ?? '', model: modelRef.current?.value ?? '',
        ...(forgetKey ? { forgetKey: true } : apiKey ? { apiKey } : {}),
      }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setPending(false)
    }
  }
  return (
    <details className="project-card project-details" onToggle={event => {
      if (event.currentTarget.open && !settings && !pending) {
        setPending(true)
        void api.provider().then(setSettings, reason => setError(errorMessage(reason))).finally(() => setPending(false))
      } else if (!event.currentTarget.open && keyRef.current) {
        keyRef.current.value = ''
      }
    }}>
      <summary>Optional online planner</summary>
      <p className="project-muted">Generate a draft roadmap from the description. Ion asks before sending it to your configured provider.</p>
      {error && <p className="project-error" role="alert">{error}</p>}
      {settings && <>
        <form className="project-form" onSubmit={configure} key={settings.endpoint + '|' + settings.model}>
          <label>Provider base URL
            <input type="url" ref={endpointRef} defaultValue={settings.endpoint} maxLength={500} required disabled={busy || pending}/>
          </label>
          <label>Model ID<input ref={modelRef} defaultValue={settings.model} maxLength={120} disabled={busy || pending}/></label>
          <label>API key
            <input ref={keyRef} type="password" autoComplete="off" spellCheck={false} maxLength={4096} disabled={busy || pending}
              placeholder={settings.hasKey ? 'Saved using OS-backed encryption' : 'Enter your provider key'}/>
          </label>
          <div className="project-actions">
            <button className="button" type="submit" disabled={busy || pending}>Save Provider</button>
            {settings.hasKey && <button className="button" type="submit" data-forget="true" disabled={busy || pending}>Forget Key</button>}
          </div>
        </form>
        <button className="button" data-testid="project-propose" disabled={!settings.hasKey || !settings.model || !canPropose || busy || pending}
          onClick={onPropose}>Generate Proposal Online…</button>
      </>}
    </details>
  )
}
