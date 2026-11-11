import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../../shared/contracts'
import type { ProjectRecord, ProjectTest, TestEvidence } from '../../shared/projects'
import { Modal } from '../Dialogs'
import { errorMessage } from '../documents'
import './projects.css'

interface ProjectTestsDialogProps {
  root: Entry
  beforeRun?(): Promise<boolean>
  onNavigate(path: string, line: number, column: number): void
  onConfigure(): void
  onClose(): void
}

const states = { 'test-verified': 'Passed', 'test-failed': 'Failed', 'unable-to-verify': 'Unable to verify' }

export default function ProjectTestsDialog({ root, beforeRun, onNavigate, onConfigure, onClose }: ProjectTestsDialogProps) {
  const api = window.ion.projects
  const [record, setRecord] = useState<ProjectRecord | null>()
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState<'review' | 'run' | 'stop' | 'load'>()
  const [error, setError] = useState('')
  const [summary, setSummary] = useState('')
  const mounted = useRef(false)
  const action = useRef(false)
  const liveSuite = useRef(false)

  useEffect(() => {
    mounted.current = true
    let current = true
    void api.open(root.path).then(value => { if (current) setRecord(value) }, reason => {
      if (current) setError(errorMessage(reason))
    })
    return () => {
      current = false
      mounted.current = false
      if (liveSuite.current) void api.cancelSuite(root.path).catch(() => undefined)
    }
  }, [api, root.path])

  async function perform<T>(kind: 'review' | 'run' | 'load', operation: () => Promise<T>, apply: (result: T) => void) {
    if (action.current) return
    action.current = true
    setBusy(kind)
    setError('')
    setSummary('')
    try {
      const result = await operation()
      if (mounted.current) apply(result)
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      action.current = false
      if (mounted.current) setBusy(undefined)
    }
  }

  function refresh() {
    void perform('load', () => api.open(root.path), value => {
      setRecord(value)
      if (!value?.spec.tests.some(test => test.id === selected)) setSelected('')
    })
  }

  function run(ids: string[]) {
    if (!record || !ids.length) return
    void perform('run', async () => {
      if (beforeRun && !await beforeRun()) throw new Error('Save or resolve unsaved project files before running the saved tests.')
      if (!mounted.current) return
      liveSuite.current = true
      try { return await api.runSuite(root.path, ids, record.revision) }
      finally { liveSuite.current = false }
    }, result => {
      if (!result) return
      setRecord(result.record)
      const outcomes = result.record.evidence.filter(item => result.completed.includes(item.testId))
      const passed = outcomes.filter(item => !item.stale && item.outcome === 'test-verified').length
      const failed = outcomes.filter(item => !item.stale && item.outcome === 'test-failed').length
      const unavailable = outcomes.length - passed - failed
      const counts = `${passed} passed · ${failed} failed · ${unavailable} unable to verify`
      setSummary(result.cancelled ? `Stopped after ${outcomes.length} of ${ids.length} · ${counts}` : counts)
    })
  }

  function stop() {
    if (!liveSuite.current) return
    setBusy('stop')
    void api.cancelSuite(root.path).catch(reason => {
      if (mounted.current) setError(errorMessage(reason))
    })
  }

  const tests = record?.spec.tests ?? []
  const approved = record?.approved ?? []
  const visible = selected ? tests.filter(test => test.id === selected) : tests
  const chosen = selected ? approved.filter(id => id === selected) : tests.map(test => test.id).filter(id => approved.includes(id))
  const failed = record?.evidence.filter(item => item.outcome !== 'test-verified' && approved.includes(item.testId))
    .map(item => item.testId) ?? []
  const pending = busy === 'run' || busy === 'stop'

  return <Modal title="Run Tests" className="project-tests-dialog" busy={Boolean(busy)} onClose={onClose}>
    <div className="project-tests-content" data-testid="project-tests">
      {record && <div className="project-tests-intro"><strong>{record.spec.title}</strong><span>{root.name}</span></div>}
      {error && <p className="project-error" role="alert">{error}</p>}
      {!error && record === undefined && <p role="status">Loading saved tests…</p>}
      {record !== undefined && tests.length === 0 && <p>Save a C behavior test in Projects to run it here.</p>}
      {tests.length > 0 && <>
        <div className="project-tests-toolbar">
          <label className="project-manual-status">Test selection
            <select data-testid="project-test-selection" value={selected} disabled={Boolean(busy)} onChange={event => {
              setSelected(event.target.value)
              setSummary('')
            }}>
              <option value="">Approved suite ({approved.length})</option>
              {tests.map(test => <option key={test.id} value={test.id}>{test.title}</option>)}
            </select>
          </label>
          <div className="project-actions">
            {pending ? <button type="button" className="button" data-testid="project-stop-suite" disabled={busy === 'stop'} onClick={stop}>
              {busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button> : <button type="button" className="button primary" data-testid="project-run-suite" disabled={Boolean(busy) || !chosen.length}
              onClick={() => run(chosen)}>{selected ? 'Run Selected' : 'Run Approved Suite'}</button>}
            <button type="button" className="button" data-testid="project-rerun-failed" disabled={Boolean(busy) || !failed.length}
              onClick={() => { setSelected(''); run(failed) }}>Rerun Failed</button>
          </div>
        </div>
        <p className="project-muted">Approved tests compile and execute saved C files with your local toolchain. Run code you trust.</p>
        <p className="project-tests-status" data-testid="project-suite-status" role="status">
          {pending ? busy === 'stop' ? 'Stopping the test process…' : 'Running selected tests…' : summary}
        </p>
        <div className="project-tests-results">
          {visible.map(test => <TestRow key={test.id} test={test} evidence={record?.evidence.find(item => item.testId === test.id)}
            approved={approved.includes(test.id)} busy={Boolean(busy)} onNavigate={onNavigate}
            onApprove={() => record && void perform('review', () => api.approve(root.path, test.id, record.revision), setRecord)}/>)}
        </div>
      </>}
      <div className="modal-footer">
        <button type="button" className="button" disabled={Boolean(busy)} onClick={refresh}>Refresh</button>
        <button type="button" className="button" disabled={Boolean(busy)} onClick={onConfigure}>Configure in Projects</button>
        <button type="button" className="button" disabled={Boolean(busy)} onClick={onClose}>Done</button>
      </div>
    </div>
  </Modal>
}

function TestRow({ test, evidence, approved, busy, onApprove, onNavigate }: {
  test: ProjectTest; evidence?: TestEvidence; approved: boolean; busy: boolean; onApprove(): void
  onNavigate(path: string, line: number, column: number): void
}) {
  const status = evidence?.stale ? 'unable-to-verify' : evidence?.outcome
  const position = evidence?.location
  const label = evidence ? evidence.stale ? 'Source changed' : states[evidence.outcome] : approved ? 'Ready' : 'Review required'
  return <details className="project-test project-suite-case" data-testid="project-suite-case" data-case={test.id}>
    <summary><span>{test.title}</span><span className="project-status" data-status={status}>{label}</span></summary>
    <div className="project-test-content">
      <p>Source <code>{test.source}</code></p>
      <p>Expected exit code <code>{test.exitCode}</code>
        {evidence && evidence.exitCode !== null && <> · {evidence.programMs === undefined && evidence.compilerOutput
          ? 'Compiler' : 'Observed'} exit code <code>{evidence.exitCode}</code></>}
      </p>
      {evidence && <p>{evidence.programMs === undefined ? `${evidence.durationMs} ms elapsed`
        : `${evidence.programMs} ms execution · ${evidence.durationMs} ms elapsed`}</p>}
      <div className="project-test-output">
        <div><b>Expected standard output</b><pre>{test.expectedOutput || '(empty)'}</pre></div>
        <div><b>Observed standard output</b><pre>{evidence ? evidence.captured || '(empty)' : 'No result yet'}</pre></div>
      </div>
      <div><b>Standard input</b><pre>{test.stdin || '(empty)'}</pre></div>
      {evidence && <p>{evidence.message}</p>}
      {evidence?.stderr && <div><b>Standard error</b><pre>{evidence.stderr}</pre></div>}
      {evidence?.compilerOutput && <div><b>Compiler output</b><pre>{evidence.compilerOutput}</pre></div>}
      {position && <button type="button" className="button" data-testid="project-test-location" disabled={busy}
        onClick={() => onNavigate(position.path, position.line, position.column)}>Go to line {position.line}</button>}
      {!approved && <button type="button" className="button" data-testid="project-suite-approve" disabled={busy} onClick={onApprove}>Review and Approve…</button>}
    </div>
  </details>
}
