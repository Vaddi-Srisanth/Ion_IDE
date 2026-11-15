import { useEffect, useRef, useState } from 'react'
import type { ExplanationAction } from '../../shared/explanations'
import type { Entry } from '../../shared/contracts'
import type { ProjectLensBridge, ProjectLensOpenResult, ProjectLensReference, ProjectLensSnapshot } from '../../shared/project-lens'
import { Icon } from '../icons'
import './project-lens.css'

interface Props {
  root: Entry
  bridge: ProjectLensBridge
  onOpen(result: ProjectLensOpenResult): void
  canExplain?: boolean
  onExplain?(action: ExplanationAction, context: { root: string; refs: ProjectLensReference[] }): void
}

export function ProjectLens({ root, bridge, onOpen, canExplain, onExplain }: Props) {
  const [snapshot, setSnapshot] = useState<ProjectLensSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [visibleFiles, setVisibleFiles] = useState(40)
  const [selectedFiles, setSelectedFiles] = useState<ProjectLensReference[]>([])
  const [action, setAction] = useState<ExplanationAction>('understand')
  const generation = useRef(0)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    generation.current++
    setSnapshot(null); setBusy(false); setOpening(null); setError(null); setVisibleFiles(40); setSelectedFiles([])
    return () => {
      mounted.current = false
      generation.current++
      void bridge.cancel().catch(() => {})
    }
  }, [root.path, bridge])

  async function analyze() {
    const request = ++generation.current
    setBusy(true); setOpening(null); setError(null); setSnapshot(null); setVisibleFiles(40); setSelectedFiles([])
    try {
      const value = await bridge.analyze(root.path)
      if (!mounted.current || generation.current !== request) return
      if (value.version !== 1 || value.root !== root.path) throw new Error('The workspace changed. Analyze its current folder again.')
      setSnapshot(value)
    } catch (reason) {
      if (mounted.current && generation.current === request) setError(reason instanceof Error ? reason.message : 'Could not analyze this folder.')
    } finally { if (mounted.current && generation.current === request) setBusy(false) }
  }
  async function cancel() {
    const request = ++generation.current
    setBusy(false); setSnapshot(null); setOpening(null)
    try { await bridge.cancel() }
    catch (reason) { if (mounted.current && generation.current === request) setError(reason instanceof Error ? reason.message : 'Could not cancel analysis.') }
  }
  async function open(reference: ProjectLensReference) {
    if (!snapshot || snapshot.status === 'cancelled' || snapshot.status === 'invalidated' || busy) return
    const request = ++generation.current
    setOpening(reference.path); setError(null)
    try {
      const value = await bridge.openReference(root.path, reference)
      if (mounted.current && generation.current === request) onOpen(value)
    } catch (reason) {
      if (mounted.current && generation.current === request) setError(reason instanceof Error ? reason.message : 'Could not open this evidence.')
    } finally { if (mounted.current && generation.current === request) setOpening(null) }
  }
  const link = (reference: ProjectLensReference, label = reference.path) => <button type="button" className="project-lens-link"
    disabled={busy || opening !== null} title={'Open inspected evidence: ' + reference.path} onClick={() => void open(reference)}>
    <span>{label}</span><Icon name="diagonal" size={11}/></button>
  const ready = snapshot && (snapshot.status === 'complete' || snapshot.status === 'partial')

  return <section className="project-lens" data-testid="project-lens" aria-labelledby="project-lens-heading">
    <header className="project-lens-heading">
      <div><h3 id="project-lens-heading"><Icon name="search" size={14}/> Project Lens</h3><p>Understand the structure of {root.name}, offline.</p></div>
      {busy ? <button type="button" className="button" data-testid="project-lens-cancel" onClick={() => void cancel()}>Cancel</button>
        : <button type="button" className="button" data-testid="project-lens-analyze" onClick={() => void analyze()}>{snapshot ? 'Analyze again' : 'Analyze'}</button>}
    </header>
    {error && <p className="project-lens-error" role="alert">{error}</p>}
    {busy && <p role="status">Inspecting bounded file metadata and local manifests… No scripts are executed.</p>}
    {!snapshot && !busy && <p className="project-lens-note">Analyze only when you need it. Source and document contents stay unread. File presence and declarations do not verify working behavior.</p>}
    {snapshot && !ready && <p role="status">{snapshot.status === 'invalidated' ? 'The workspace changed. Analyze again to view current evidence.' : 'Analysis cancelled.'}</p>}
    {ready && <div className="project-lens-results">
      {onExplain && <section className="project-lens-online" aria-label="Optional project explanations">
        <h4>Ask about this project</h4>
        <p className="project-lens-note">Optional online explanations. Choose evidence, then review exactly what leaves this computer. Nothing is sent automatically.</p>
        <label>Explanation<select aria-label="Project explanation" value={action} onChange={event => setAction(event.currentTarget.value as ExplanationAction)}>
          <option value="understand">Understand my project</option><option value="ask-codebase">Ask my codebase</option>
          <option value="architecture">Explain architecture</option><option value="health">Project health</option>
          <option value="teach-project">Teach me this project</option><option value="next-steps">What should I build next?</option>
        </select></label>
        <label>Optional source evidence (up to four files)<select aria-label="Add project source evidence" value="" disabled={selectedFiles.length >= 4 || !canExplain}
          onChange={event => { const file = snapshot.files.find(file => file.reference.path === event.currentTarget.value)
            if (file && !selectedFiles.some(item => item.path === file.reference.path)) setSelectedFiles(current => [...current, file.reference].slice(0, 4)) }}>
          <option value="">Choose an inspected file…</option>{snapshot.files.filter(file => !selectedFiles.some(item => item.path === file.reference.path))
            .map(file => <option key={file.reference.path} value={file.reference.path}>{file.reference.path}</option>)}
        </select></label>
        {selectedFiles.map(file => <div className="project-lens-selected" key={file.path}><span>{file.path}</span>
          <button type="button" className="icon-button" aria-label={'Exclude ' + file.path} onClick={() => setSelectedFiles(current => current.filter(item => item.path !== file.path))}><Icon name="x" size={12}/></button></div>)}
        <button type="button" className="button" data-testid="project-lens-explain" disabled={!canExplain || busy}
          title={canExplain ? 'Prepare a review; no network request yet' : 'Online explanations are optional in the Full resource profile'}
          onClick={() => onExplain(action, { root: root.path, refs: selectedFiles })}>Review online context…</button>
      </section>}

      <p className="project-lens-summary" role="status" data-testid="project-lens-summary">
        <strong>{snapshot.status === 'partial' ? 'Partial snapshot' : 'Scoped snapshot complete'}</strong>
        <span>{snapshot.counts.filesInspected} eligible files inspected · {snapshot.counts.directoriesInspected} folders · {snapshot.durationMs} ms</span>
      </p>
      {!!snapshot.truncated.length && <p className="project-lens-warning">Limits reached: {snapshot.truncated.join(', ')}. This is not a complete repository inventory.</p>}
      {snapshot.languages.length > 0 && <section><h4>Languages by filename</h4><ul className="project-lens-languages">
        {snapshot.languages.map(language => <li key={language.id}><span>{language.label}</span><span>{language.files}</span></li>)}
      </ul></section>}
      {snapshot.frameworks.length > 0 && <section><h4>Framework and tool evidence</h4><ul className="project-lens-evidence">
        {snapshot.frameworks.map((item, index) => <li key={item.name + ':' + item.reference.path + ':' + index}>
          <div><strong>{item.name}</strong><span className="project-lens-confidence">{item.confidence === 'declared' ? 'Declared' : 'Structure only'}</span></div>
          <p>{item.reason}</p>{link(item.reference)}</li>)}
      </ul></section>}
      {snapshot.entryPoints.length > 0 && <section><h4>Entry candidates and declarations</h4><ul className="project-lens-evidence">
        {snapshot.entryPoints.map((item, index) => <li key={item.path + ':' + index}>{link(item.reference, item.path)}
          <p>{item.kind === 'manifest-reference' ? 'Declared only; opens the manifest evidence. ' : ''}{item.reason}</p></li>)}
      </ul></section>}
      {snapshot.documentation.length > 0 && <details><summary>Documentation paths ({snapshot.documentation.length})</summary>
        <ul className="project-lens-paths">{snapshot.documentation.map(item => <li key={item.path}>{link(item)}</li>)}</ul></details>}
      {snapshot.tests.length > 0 && <details><summary>Test-shaped paths ({snapshot.tests.length})</summary>
        <p className="project-lens-note">These names suggest tests; no tests were run or verified.</p>
        <ul className="project-lens-paths">{snapshot.tests.map(item => <li key={item.path}>{link(item)}</li>)}</ul></details>}
      {snapshot.manifests.length > 0 && <section><h4>Inspected manifests</h4>
        {snapshot.manifests.map(manifest => <details key={manifest.reference.path} data-testid="project-lens-manifest">
          <summary>{manifest.reference.path} · {manifest.status}</summary>{link(manifest.reference)}
          {manifest.dependencies.length > 0 && <><h5>Declared dependencies</h5><ul className="project-lens-dependencies">
            {manifest.dependencies.map((dependency, index) => <li key={dependency.name + ':' + index}><code>{dependency.name}</code> <span>{dependency.version} · {dependency.group}</span></li>)}
          </ul></>}
          {manifest.scripts.length > 0 && <><h5>Scripts — text only</h5><p className="project-lens-note">Nothing here is executed. Obvious credentials are redacted; review before sharing.</p>
            <dl className="project-lens-scripts">{manifest.scripts.map(script => <div key={script.name}><dt>{script.name}</dt><dd><code>{script.command}</code></dd></div>)}</dl></>}
        </details>)}
      </section>}
      <details><summary>Inspected files ({snapshot.counts.returnedFiles} returned)</summary>
        <ul className="project-lens-paths">{snapshot.files.slice(0, visibleFiles).map(file => <li key={file.reference.path}>{link(file.reference)}<small>{file.bytes} bytes</small></li>)}</ul>
        {visibleFiles < snapshot.files.length && <button type="button" className="button" onClick={() => setVisibleFiles(count => Math.min(count + 40, 500))}>Show more files</button>}
      </details>
      <details><summary>Scope, exclusions and uncertainty</summary>
        <p className="project-lens-note">{snapshot.counts.visitedEntries} entries visited · {snapshot.counts.manifestBytesRead} manifest bytes read.</p>
        <ul>{Object.entries(snapshot.exclusions).map(([reason, count]) => <li key={reason}>{reason}: {count}</li>)}</ul>
        <ul>{snapshot.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>
      </details>
      {opening && <p role="status">Checking {opening} before opening…</p>}
    </div>}
  </section>
}
