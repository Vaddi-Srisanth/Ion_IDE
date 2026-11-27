import { useEffect, useRef, useState } from 'react'
import type { PracticeBridge, PracticeProgress, PracticeSuggestion } from '../../shared/practice'
import { errorMessage } from '../documents'

const states = { opened: 'Opened', submitted: 'Submitted', accepted: 'Accepted' }
const reasons: Record<PracticeSuggestion['reason'], string> = {
  submitted: 'Revisit a challenge with a saved local submission.',
  opened: 'Continue with a saved attempt.',
  related: 'Try a new challenge in a topic with recorded local activity.',
  new: 'Try a challenge with no saved attempt in your progress.',
}

export function CatalogProgress({ bridge, hidden, onViewChallenge }: {
  bridge: PracticeBridge
  hidden: boolean
  onViewChallenge(id: string): void
}) {
  const [result, setResult] = useState<{ data: PracticeProgress } | { error: string }>()
  const [refresh, setRefresh] = useState(0)
  const suggestionButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    let pending = true
    void bridge.progress().then(
      data => { if (pending) { pending = false; setResult({ data }) } },
      reason => { if (pending) { pending = false; setResult({ error: errorMessage(reason) }) } },
    )
    return () => {
      if (pending) {
        pending = false
        void bridge.cancelProgress().catch(() => {})
      }
    }
  }, [bridge, refresh])
  useEffect(() => {
    if (hidden) restoreFocus.current = true
    else if (restoreFocus.current) {
      restoreFocus.current = false
      suggestionButton.current?.focus()
    }
  }, [hidden])

  const progress = result && 'data' in result ? result.data : undefined
  const suggestion = progress?.suggestion
  if (hidden) return null
  return <section className="practice-progress" aria-label="Catalog progress">
    <div className="practice-section-heading">
      <h3>Catalog progress</h3>
      {result && <button className="button" type="button" onClick={() => {
        setResult(undefined)
        setRefresh(value => value + 1)
      }}>{progress ? 'Refresh' : 'Try again'}</button>}
    </div>
    {!result && <p className="practice-muted" role="status">Reading saved progress…</p>}
    {result && 'error' in result && <p className="form-error" role="alert">{result.error}</p>}
    {progress && <>
      <p className="practice-muted">Each of the {progress.catalogSize} catalog challenges counts once across languages. Counts use saved attempts and retained submission verdicts. You set manual completion in Saved.</p>
      <dl className="practice-progress-counts">
        <div><dt>Opened</dt><dd>{progress.opened}</dd></div>
        <div><dt>Submitted</dt><dd>{progress.submitted}</dd></div>
        <div><dt>Accepted</dt><dd>{progress.accepted}</dd></div>
      </dl>
      {progress.unavailable > 0 && <p className="practice-muted" role="status">
        {progress.unavailable} saved {progress.unavailable === 1 ? 'record' : 'records'} could not be fully read. Counts may be incomplete.
      </p>}
      {suggestion && <section className="practice-suggestion" aria-label="Suggested next practice">
        <h4>Suggested next practice</h4>
        <div className="practice-challenge">
          <div>
            <h5>{suggestion.title}</h5>
            <p className="practice-muted">{suggestion.topic} · {suggestion.difficulty}</p>
            <p className="practice-muted">{reasons[suggestion.reason]}</p>
          </div>
          <button ref={suggestionButton} className="button" type="button" aria-label={'View challenge ' + suggestion.title}
            onClick={() => onViewChallenge(suggestion.id)}>View challenge</button>
        </div>
      </section>}
      {progress.challenges.length ? <ul className="practice-challenge-list" aria-label="Saved catalog challenges">
        {progress.challenges.map(challenge => <li key={challenge.id} className="practice-challenge">
          <div><h5>{challenge.title}</h5>
            {challenge.importedOnly && <p className="practice-muted">Imported history</p>}
          </div>
          <span>{states[challenge.state]}</span>
        </li>)}
      </ul> : <p className="practice-muted">{progress.unavailable
        ? 'No catalog attempts found in the readable records.'
        : 'Open a catalog challenge to start tracking progress.'}</p>}
    </>}
  </section>
}
