import type { PracticeAttempt, PracticeSubmission } from '../../shared/practice'

const statusLabel = {
  passed: 'Passed', failed: 'Failed', unavailable: 'Unable to verify', skipped: 'Skipped',
}

export function PracticeResults({ attempt }: { attempt?: PracticeAttempt }) {
  const report = attempt?.lastRun
  if (!report) return null
  const passed = report.results.filter(({ status }) => status === 'passed').length
  return (
    <section className="practice-section" aria-label="Sample results" data-testid="practice-results">
      <div className="practice-section-heading"><h3>Last sample run</h3><span>{passed} of {report.results.length} passed</span></div>
      <p className="practice-muted">
        {report.current ? 'Results refer to the saved file at the time of this run.' : 'Saved source or samples changed since this run.'}
      </p>
      {report.results.map((result) => (
        <details key={result.id} className="practice-sample" data-status={result.status}>
          <summary><span>{result.label}</span><b>{statusLabel[result.status]}</b></summary>
          <p>{result.message}</p>
          <h4>Expected stdout</h4><pre>{result.expected || '∅'}</pre>
          <h4>Captured stdout</h4><pre>{result.stdout || '∅'}</pre>
          {result.stderr && <><h4>Captured diagnostics or stderr</h4><pre>{result.stderr}</pre></>}
        </details>
      ))}
    </section>
  )
}

const verdictLabel: Record<PracticeSubmission['verdict'], string> = {
  accepted: 'Accepted', 'wrong-answer': 'Wrong answer', 'compile-error': 'Compile error',
  'runtime-error': 'Runtime error', timeout: 'Time limit exceeded', 'output-limit': 'Output limit exceeded',
}

export function SubmissionHistory({ attempt, busy, onRefresh }: {
  attempt?: PracticeAttempt
  busy: boolean
  onRefresh(): void
}) {
  if (!attempt?.submissions?.length) return null
  const recent = attempt.submissions.slice(-10).reverse()
  return <section className="practice-section" aria-label="Local submission history" data-testid="practice-submissions">
    <div className="practice-section-heading">
      <h3>Local submission history</h3>
      <button type="button" className="button" disabled={busy} onClick={onRefresh}>Refresh history</button>
    </div>
    <ol className="practice-submissions">
      {recent.map((row, index) => <li key={row.judgedAt + ':' + index} data-verdict={row.verdict}>
        <div className="practice-section-heading"><strong>{verdictLabel[row.verdict]}</strong>
          <span>{row.passed} of {row.total} passed</span></div>
        <p className="practice-muted"><time>{new Date(row.judgedAt).toLocaleString()}</time> · {row.runtimeMs} ms</p>
        <p className="practice-muted">{row.current ? 'Matched the saved file at last check.' : 'Historical result. Submit again to verify the saved file.'}</p>
      </li>)}
    </ol>
  </section>
}
