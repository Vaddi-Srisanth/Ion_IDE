import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Entry } from '../../shared/contracts'
import type { TestAdapter, TestCaseResult, TestExplorerBridge, TestNode, TestOperationResult, TestSnapshot } from '../../shared/test-explorer'
import { Modal } from '../Dialogs'
import { errorMessage } from '../documents'
import './test-explorer.css'

interface TestExplorerProps {
  api: TestExplorerBridge
  roots: Entry[]
  beforeRun(root: string): Promise<boolean>
  onNavigate(root: string, path: string, line: number): void
  onSavedTests(root: Entry): void
  onClose(): void
}

type Busy = 'load' | 'discover' | 'run' | 'stop' | 'close'
const outcomeLabel = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', error: 'Error', cancelled: 'Cancelled' }
const duration = (ms: number) => ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(2)} s`

export default function TestExplorer({ api, roots, beforeRun, onNavigate, onSavedTests, onClose }: TestExplorerProps) {
  const [rootPath, setRootPath] = useState(roots[0]?.path ?? '')
  const [snapshot, setSnapshot] = useState<TestSnapshot | null>()
  const [adapter, setAdapter] = useState<TestAdapter>('pytest')
  const [selectedId, setSelectedId] = useState('')
  const [historyId, setHistoryId] = useState('')
  const [historicalCaseId, setHistoricalCaseId] = useState('')
  const [busy, setBusy] = useState<Busy>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const generation = useRef(0)
  const operation = useRef<{ cancelled: boolean } | null>(null)
  const closing = useRef(false)
  const root = roots.find(item => item.path === rootPath)

  useEffect(() => {
    if (!roots.some(item => item.path === rootPath)) setRootPath(roots[0]?.path ?? '')
  }, [roots, rootPath])

  useEffect(() => {
    const epoch = ++generation.current
    let current = true
    setSnapshot(undefined)
    setSelectedId('')
    setHistoryId('')
    setHistoricalCaseId('')
    setError('')
    setMessage('')
    setBusy('load')
    const read = rootPath ? api.list(rootPath) : Promise.resolve(null)
    void read.then(value => {
      if (current && epoch === generation.current) { setSnapshot(value); setAdapter(value?.adapter ?? 'pytest') }
    }, reason => {
      if (current && epoch === generation.current) setError(errorMessage(reason))
    }).finally(() => {
      if (current && epoch === generation.current) setBusy(undefined)
    })
    return () => {
      current = false
      generation.current++
      if (operation.current) {
        operation.current.cancelled = true
        operation.current = null
        void api.cancel().catch(() => undefined)
      }
    }
  }, [api, rootPath])

  async function perform(kind: 'discover' | 'run', request: () => Promise<TestOperationResult>) {
    if (operation.current || busy || !root || closing.current) return
    const owner = { cancelled: false }
    operation.current = owner
    const epoch = generation.current
    setBusy(kind)
    setError('')
    setMessage('')
    try {
      if (!await beforeRun(root.path)) throw new Error('Save or resolve unsaved workspace files before discovering or running tests.')
      if (owner.cancelled || epoch !== generation.current) return
      const result = await request()
      if (epoch !== generation.current || closing.current) return
      setSnapshot(result.snapshot)
      setHistoryId('')
      setHistoricalCaseId('')
      if (result.snapshot && !result.snapshot.nodes.some(node => node.id === selectedId)) setSelectedId('')
      if (result.status === 'failed') setError(result.message || 'The test operation could not be verified.')
      else setMessage(result.message || (result.status === 'cancelled' ? 'Test operation cancelled.' : 'Test operation complete.'))
    } catch (reason) {
      if (epoch === generation.current && !closing.current) setError(errorMessage(reason))
    } finally {
      if (operation.current === owner) operation.current = null
      if (epoch === generation.current && !closing.current) setBusy(undefined)
    }
  }

  function discover() {
    void perform('discover', () => api.discover(rootPath, adapter))
  }

  function run(ids: string[]) {
    if (!snapshot || !ids.length) return
    const revision = snapshot.revision
    void perform('run', () => api.run(rootPath, revision, ids))
  }

  async function stop() {
    if (!operation.current || busy === 'stop') return
    const epoch = generation.current
    operation.current.cancelled = true
    setBusy('stop')
    try { await api.cancel() }
    catch (reason) { if (epoch === generation.current && !closing.current) setError(errorMessage(reason)) }
    // The operation reply owns final state; Stop acknowledgement is not proof
    // that every child has exited or that a report has finished draining.
  }

  async function close() {
    if (closing.current) return
    closing.current = true
    const previousBusy = busy
    setBusy('close')
    try {
      if (operation.current) {
        operation.current.cancelled = true
        await api.cancel()
      }
      generation.current++
      onClose()
    } catch (reason) {
      closing.current = false
      setBusy(operation.current ? previousBusy : undefined)
      setError(errorMessage(reason))
    }
  }

  const nodes = snapshot?.nodes ?? []
  const byParent = useMemo(() => {
    const groups = new Map<string | null, TestNode[]>()
    for (const node of nodes) {
      const children = groups.get(node.parentId)
      if (children) children.push(node)
      else groups.set(node.parentId, [node])
    }
    return groups
  }, [nodes])
  const cases = nodes.filter(node => node.kind === 'test')
  const selected = nodes.find(node => node.id === selectedId)
  const history = useMemo(() => [...(snapshot?.history ?? [])].sort((a, b) => b.checkedAt - a.checkedAt), [snapshot])
  const shownRun = history.find(item => item.id === historyId) ?? history[0]
  const historical = Boolean(shownRun && (snapshot?.stale || shownRun.stale || shownRun.restored || shownRun !== history[0]))
  const results = useMemo(() => new Map(shownRun?.cases.map(item => [item.id, item]) ?? []), [shownRun])
  const historicalCase = !nodes.length ? shownRun?.cases.find(item => item.id === historicalCaseId) : undefined
  const result = selected ? results.get(selected.id) : historicalCase
  const latest = history[0]
  const failedIds = latest?.cases.filter(item => (item.outcome === 'failed' || item.outcome === 'error')
    && cases.some(node => node.id === item.id)).map(item => item.id) ?? []
  const canRun = !busy && !snapshot?.stale && snapshot?.adapter === adapter && cases.length > 0
  const running = busy === 'discover' || busy === 'run' || busy === 'stop'
  const location = result?.location ?? selected?.location
  const status = busy === 'load' ? 'Loading saved test history…' : busy === 'discover' ? 'Reviewing or collecting tests…'
    : busy === 'run' ? 'Reviewing or running selected tests…' : busy === 'stop' ? 'Stopping and cleaning up test processes…'
    : busy === 'close' ? 'Closing Test Explorer…' : message

  function renderNodes(parent: string | null, depth = 0): ReactNode {
    if (depth > 32) return null
    return <ul className="test-explorer-nodes">
      {(byParent.get(parent) ?? []).map(node => <li key={node.id}>
        {node.kind === 'test' ? <button type="button" className="test-explorer-node" aria-pressed={selectedId === node.id}
          onClick={() => setSelectedId(node.id)}>
          <span className="test-explorer-node-label">{node.label}</span>
          <ResultLabel result={results.get(node.id)} historical={historical}/>
        </button> : <details open>
          <summary><span>{node.kind === 'file' ? 'File' : 'Suite'}</span>
            <button type="button" className="test-explorer-node" aria-pressed={selectedId === node.id}
              onClick={event => { event.preventDefault(); setSelectedId(node.id) }}>{node.label}</button>
          </summary>
          {renderNodes(node.id, depth + 1)}
        </details>}
      </li>)}
    </ul>
  }

  return <Modal title="Test Explorer" className="test-explorer" onClose={() => { void close() }} busy={busy === 'close'}>
    <div className="test-explorer-controls">
      <label>Workspace
        <select aria-label="Test workspace" value={rootPath} disabled={Boolean(busy)} onChange={event => setRootPath(event.target.value)}>
          {!roots.length && <option value="">No workspace open</option>}
          {roots.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}
        </select>
      </label>
      <label>Framework
        <select aria-label="Test framework" value={adapter} disabled={Boolean(busy)} onChange={event => setAdapter(event.target.value as TestAdapter)}>
          <option value="pytest">Python · pytest</option>
          <option value="vitest">JavaScript / TypeScript · Vitest</option>
          <option value="junit">Java · JUnit</option>
        </select>
      </label>
      <button type="button" className="button" disabled={!root || Boolean(busy)} onClick={discover}>
        {snapshot ? 'Refresh Discovery…' : 'Discover Tests…'}
      </button>
    </div>
    <p className="test-explorer-note">Discovery imports tests and project configuration. Ion asks you to review the command before discovery or execution. Tests use saved files and local tools. {adapter === 'junit' ? 'Use a JDK and set ION_JUNIT_PLATFORM_JAR to your installed JUnit Platform Console Standalone 1.13.4 jar.' : adapter === 'vitest' ? 'Install Vitest 4.1.x in your project.' : 'Install pytest in your Python environment.'}</p>
    <div className="test-explorer-actions">
      <button type="button" className="button primary" disabled={!canRun || !selected} onClick={() => run([selectedId])}>Run Selected</button>
      <button type="button" className="button" disabled={!canRun} onClick={() => run(cases.map(node => node.id))}>Run All</button>
      <button type="button" className="button" disabled={!canRun || !failedIds.length} onClick={() => run(failedIds)}>Rerun Failed</button>
      <button type="button" className="button" disabled={!running || busy === 'stop'} onClick={() => { void stop() }}>Stop</button>
      <span>{cases.length} {cases.length === 1 ? 'test' : 'tests'}</span>
    </div>
    {error && <p className="test-explorer-error" role="alert">{error}</p>}
    {snapshot?.stale && <p className="test-explorer-warning">Saved discovery or source data changed. Refresh Discovery before running. Previous results remain historical evidence.</p>}
    {snapshot && snapshot.adapter !== adapter && <p className="test-explorer-warning">Discover {adapter} tests to replace the current discovery. Previous results remain in history.</p>}
    <p className="test-explorer-status" role="status" aria-live="polite">{status}</p>
    <div className="test-explorer-body">
      <nav className="test-explorer-tree" aria-label="Discovered test suites">
        {nodes.length ? renderNodes(null) : <div className="test-explorer-empty">
          <strong>{snapshot ? 'No runnable tests in this snapshot' : 'Discover your tests'}</strong>
          <p>{snapshot?.history.length ? 'Saved history is available. Rediscover this workspace to obtain runnable test identities.'
            : 'Discover collects real framework cases, including parameterized tests. Saved C behavior tests remain available below.'}</p>
        </div>}
      </nav>
      <section className="test-explorer-detail" aria-label="Test result details">
        <label className="test-explorer-history">Run history
          <select aria-label="Test run history" value={shownRun?.id ?? ''} disabled={!history.length}
            onChange={event => setHistoryId(event.target.value)}>
            {!history.length && <option value="">No runs yet</option>}
            {history.map((item, index) => <option key={item.id} value={item.id}>
              {index === 0 ? 'Latest · ' : ''}{new Date(item.checkedAt).toLocaleString()} · {item.adapter ?? 'pytest'} · {item.status}{item.restored ? ' · restored' : ''}
            </option>)}
          </select>
        </label>
        {shownRun && <div className="test-explorer-run-summary">
          <span>{shownRun.cases.filter(item => item.outcome === 'passed').length} passed</span>
          <span>{shownRun.cases.filter(item => item.outcome === 'failed' || item.outcome === 'error').length} failed / errors</span>
          <span>{shownRun.cases.filter(item => item.outcome === 'skipped').length} skipped</span>
          {shownRun.cases.some(item => item.outcome === 'cancelled') && <span>{shownRun.cases.filter(item => item.outcome === 'cancelled').length} cancelled</span>}
          <span>{duration(shownRun.durationMs)}</span>
          {historical && <strong>Historical{shownRun.restored ? ' · restored' : ''}</strong>}
        </div>}
        <h3>{selected?.label ?? historicalCase?.label ?? historicalCase?.location?.path ?? 'Select a test or suite'}</h3>
        {selected?.kind !== 'test' && !historicalCase && <p className="test-explorer-note">Select a case to inspect its result, or select a suite or file and choose Run Selected.</p>}
        {(selected?.kind === 'test' || historicalCase) && <>
          <div className="test-explorer-case-state"><ResultLabel result={result} historical={historical}/>
            {result && <span>{duration(result.durationMs)}</span>}</div>
          {result?.message && <pre className="test-explorer-output">{result.message.slice(0, 4096)}</pre>}
          {result?.output && <div><h4>Captured output</h4><pre className="test-explorer-output">{result.output.slice(0, 4096)}</pre></div>}
          {!result && <p className="test-explorer-note">This case has no result in the selected run.</p>}
        </>}
        {location && <button type="button" className="button" disabled={Boolean(busy)} title={location.path}
          onClick={() => onNavigate(rootPath, location.path, location.line)}>Open source · line {location.line}</button>}
        {shownRun && !nodes.length && <ul className="test-explorer-restored-results">
          {shownRun.cases.map(item => <li key={item.id}>
            <button type="button" className="test-explorer-node" aria-pressed={historicalCaseId === item.id}
              onClick={() => setHistoricalCaseId(item.id)}>
              <span className="test-explorer-node-label">{item.label ?? item.location?.path ?? item.id}</span>
              <ResultLabel result={item} historical/>
            </button>
            <span>{duration(item.durationMs)}</span>{item.location && <code>{item.location.path}:{item.location.line}</code>}
          </li>)}
        </ul>}
      </section>
    </div>
    <div className="modal-footer">
      <button type="button" className="button" disabled={!root || Boolean(busy)} onClick={() => root && onSavedTests(root)}>Saved C Tests…</button>
      <span className="test-explorer-note">History never grants execution approval.</span>
      <button type="button" className="button" disabled={busy === 'close'} onClick={() => { void close() }}>Done</button>
    </div>
  </Modal>
}

function ResultLabel({ result, historical }: { result?: TestCaseResult; historical: boolean }) {
  return <span className="test-explorer-result" data-outcome={historical ? 'historical' : result?.outcome}>
    {result ? `${outcomeLabel[result.outcome]}${historical ? ' · historical' : ''}` : 'Not run'}
  </span>
}
