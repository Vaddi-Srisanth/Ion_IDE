import type { PracticeAttempt } from '../../shared/practice'

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
