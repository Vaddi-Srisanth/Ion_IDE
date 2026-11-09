import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Entry } from '../../shared/contracts'
import type { RunLanguage } from '../../shared/run-console'
import {
  catalogDifficulties, maxPracticeSamples, practiceCompletion, practiceDifficulties, practiceLanguages, practiceTopics,
  type CatalogDifficulty, type PracticeChallenge, type PracticeChallengeSummary, type PracticeTopic,
  type PracticeAttempt, type PracticeBridge, type PracticeDraft, type PracticeFields,
  type PracticeLibrary, type PracticeProblem, type PracticeSample,
} from '../../shared/practice'
import { EntryDialog, Modal } from '../Dialogs'
import { errorMessage } from '../documents'
import { Icon } from '../icons'
import './practice.css'

export interface PracticePaneProps {
  bridge: PracticeBridge
  initialProblem?: string
  onOpenEntry(entry: Entry): void
  onPrepareRun(path: string): Promise<boolean>
  onClose(): void
  onDirtyChange?(dirty: boolean): void
  onStopRun?(): void
}

interface RetainedDraft { value: PracticeDraft; dirty: boolean }
let retainedDraft: RetainedDraft | null = null
let lastProblem: string | null = null

const languageOptions = Object.entries(practiceLanguages).map(([id, label]) =>
  <option key={id} value={id}>{label}</option>)

function emptyDraft(): PracticeDraft {
  return {
    title: '', sourceUrl: '', difficulty: 'Unrated', topic: '', completion: 'Not started',
    statement: '', notes: '', samples: [],
  }
}

function newSample(number: number): PracticeSample {
  return { id: crypto.randomUUID(), label: 'Sample ' + number, input: '', expectedOutput: '' }
}

function PracticeSamples({ samples }: { samples: readonly (Omit<PracticeSample, 'id'> & { id?: string })[] }) {
  if (!samples.length) return null
  return <section className="practice-section" data-testid="practice-sample-definitions">
    <h3>Sample tests</h3>
    {samples.map((sample, index) => <details key={sample.id ?? index} className="practice-sample" open={index === 0 || undefined}>
      <summary>{sample.label}</summary>
      <h4>Standard input</h4><pre>{sample.input || '∅'}</pre>
      <h4>Expected stdout</h4><pre>{sample.expectedOutput || '∅'}</pre>
    </details>)}
  </section>
}

function ChallengePreview({ bridge, id, language, busy, onBack, onStart }: {
  bridge: PracticeBridge
  id: string
  language: RunLanguage | ''
  busy: boolean
  onBack(): void
  onStart(id: string, language: RunLanguage): void
}) {
  const [loaded, setLoaded] = useState<{ challenge: PracticeChallenge } | { error: string }>()
  useEffect(() => {
    let active = true
    void bridge.getChallenge(id).then(
      (challenge) => { if (active) setLoaded({ challenge }) },
      (reason) => { if (active) setLoaded({ error: errorMessage(reason) }) },
    )
    return () => { active = false }
  }, [bridge, id])
  const challenge = loaded && 'challenge' in loaded ? loaded.challenge : undefined
  return <section className="practice-challenge-preview" data-testid="practice-challenge-preview">
    <button className="button practice-back" type="button" onClick={onBack}>Back to matches</button>
    {!loaded && <p className="practice-muted" role="status">Opening the problem…</p>}
    {loaded && 'error' in loaded && <p className="form-error" role="alert">{loaded.error}</p>}
    {challenge && <>
      <div className="practice-preview-heading">
        <h4>{challenge.title}</h4>
        <p className="practice-muted">{challenge.topic} · {challenge.difficulty}</p>
      </div>
      <p className="practice-statement" data-testid="practice-problem-statement">{challenge.statement}</p>
      <PracticeSamples samples={challenge.samples} />
      {!language && <p className="practice-muted">Choose a language above to open a solution file.</p>}
      <button className="button primary" data-testid="practice-start" disabled={busy || !language}
        onClick={() => { if (language) onStart(id, language) }}>Start challenge <Icon name="arrow" size={14} /></button>
    </>}
  </section>
}

function BrowsePractice({ bridge, hidden, busy, onStart }: {
  bridge: PracticeBridge
  hidden: boolean
  busy: boolean
  onStart(id: string, language: RunLanguage): void
}) {
  const [language, setLanguage] = useState<RunLanguage | ''>('')
  const [topic, setTopic] = useState<PracticeTopic | ''>('')
  const [difficulty, setDifficulty] = useState<CatalogDifficulty | ''>('')
  const [previewId, setPreviewId] = useState('')
  const [retry, setRetry] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; matches: PracticeChallengeSummary[]; error?: string }>()
  const section = useRef<HTMLElement>(null)
  const query = difficulty && (language || topic) ? [language, topic, difficulty, retry].join(':') : ''
  const result = query && loaded?.key === query ? loaded : undefined

  useEffect(() => {
    if (!query || !difficulty) return
    let active = true
    void bridge.browse({ language: language || undefined, topic: topic || undefined, difficulty }).then(
      (matches) => { if (active) setLoaded({ key: query, matches }) },
      (reason) => { if (active) setLoaded({ key: query, matches: [], error: errorMessage(reason) }) },
    )
    return () => { active = false }
  }, [bridge, difficulty, language, query, topic])

  useEffect(() => { section.current?.parentElement?.scrollTo(0, 0) }, [previewId])

  if (hidden) return null
  return (
    <section ref={section} className="practice-discovery" aria-label="Browse practice problems">
      <div className="practice-intro">
        <h3>Find a challenge</h3>
        <span className="practice-catalog-badge">Offline catalog</span>
        <p className="practice-muted">Choose a language or topic, then a difficulty. Ion brings the problem, examples, and tests.</p>
      </div>
      <div className="practice-filters">
        <label className="practice-label">Language
          <select data-testid="practice-language" value={language}
            onChange={(event) => setLanguage(event.target.value as RunLanguage | '')}>
            <option value="">Any language</option>
            {languageOptions}
          </select>
        </label>
        <label className="practice-label">Topic
          <select data-testid="practice-topic" value={topic}
            onChange={(event) => { setTopic(event.target.value as PracticeTopic | ''); setPreviewId('') }}>
            <option value="">Any topic</option>
            {practiceTopics.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="practice-label">Difficulty
          <select data-testid="practice-difficulty" value={difficulty}
            onChange={(event) => { setDifficulty(event.target.value as CatalogDifficulty | ''); setPreviewId('') }}>
            <option value="">Choose difficulty</option>
            {catalogDifficulties.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
      </div>
      {previewId ? (
        <ChallengePreview key={previewId} bridge={bridge} id={previewId} language={language} busy={busy}
          onBack={() => setPreviewId('')} onStart={onStart} />
      ) : !query ? (
        <div className="practice-catalog-state">
          <Icon name="search" size={17} />
          <p>Matching challenges will appear here as you choose your filters.</p>
        </div>
      ) : !result ? (
        <p className="practice-muted" role="status">Finding challenges…</p>
      ) : result.error ? (
        <div className="practice-catalog-state">
          <p className="form-error" role="alert">{result.error}</p>
          <button className="button" onClick={() => setRetry((value) => value + 1)}>Try again</button>
        </div>
      ) : !result.matches.length ? (
        <div className="practice-catalog-state">
          <Icon name="search" size={17} />
          <p role="status">No matches. Try another topic or difficulty.</p>
        </div>
      ) : (
        <div className="practice-matches">
          <div className="practice-section-heading">
            <h4>Matching challenges</h4>
            <span role="status">{result.matches.length} found</span>
          </div>
          <ul className="practice-challenge-list">
            {result.matches.map(({ id, title, topic, difficulty }) => (
              <li key={id} className="practice-challenge" data-testid="practice-challenge" data-challenge={id}>
                <div>
                  <h5>{title}</h5>
                  <p className="practice-muted">{topic} · {difficulty}</p>
                </div>
                <div className="practice-challenge-actions">
                  <button className="button" data-testid="practice-view-problem" aria-label={'View problem ' + title}
                    onClick={() => setPreviewId(id)}>View problem</button>
                  {language && <button className="button primary" data-testid="practice-start" aria-label={'Start ' + title}
                    disabled={busy} onClick={() => onStart(id, language)}>
                    Start <Icon name="arrow" size={13} />
                  </button>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function ProblemForm({ value, busy, error, onChange, onSubmit, onClose, onDiscard }: {
  value: PracticeDraft
  busy: boolean
  error: string
  onChange(next: PracticeDraft): void
  onSubmit(event: FormEvent): void
  onClose(): void
  onDiscard(): void
}) {
  const update = (patch: Partial<PracticeFields>) => onChange({ ...value, ...patch })
  const updateSample = (id: string, patch: Partial<PracticeSample>) => {
    update({ samples: value.samples.map((sample) => sample.id === id ? { ...sample, ...patch } : sample) })
  }
  return (
    <Modal title={value.id ? 'Edit problem' : 'New practice problem'} className="practice-modal" onClose={onClose} busy={busy}>
      <form className="practice-form" data-testid="practice-form" onSubmit={onSubmit}>
        <div className="practice-form-content">
          <label>Problem title<input data-testid="practice-title" required autoFocus maxLength={120} value={value.title}
            onChange={(event) => update({ title: event.target.value })} /></label>
          <div className="practice-form-grid">
            <label>Difficulty<select value={value.difficulty} onChange={(event) => update({ difficulty: event.target.value as PracticeFields['difficulty'] })}>
              {practiceDifficulties.map((difficulty) => <option key={difficulty}>{difficulty}</option>)}
            </select></label>
            <label>Topic<input maxLength={120} value={value.topic} placeholder="e.g. Arrays"
              onChange={(event) => update({ topic: event.target.value })} /></label>
          </div>
          <label>Language<select value={value.language ?? 'c'} disabled={Boolean(value.id)}
            onChange={(event) => onChange({ ...value, language: event.target.value as RunLanguage })}>
            {languageOptions}
          </select></label>
          <label>Original problem URL<input type="url" maxLength={2048} placeholder="https://…" value={value.sourceUrl}
            onChange={(event) => update({ sourceUrl: event.target.value })} /></label>
          <label>Manual completion status<select value={value.completion}
            onChange={(event) => update({ completion: event.target.value as PracticeFields['completion'] })}>
            {practiceCompletion.map((completion) => <option key={completion}>{completion}</option>)}
          </select></label>
          <label>Problem statement<textarea data-testid="practice-statement" rows={5} required maxLength={20_000} value={value.statement}
            onChange={(event) => update({ statement: event.target.value })} /></label>
          <label>Personal notes<textarea data-testid="practice-notes" rows={3} maxLength={20_000} value={value.notes}
            onChange={(event) => update({ notes: event.target.value })} /></label>
          <div className="practice-form-section">
            <h3>Sample tests</h3>
            <button type="button" className="button" data-testid="practice-add-sample"
              disabled={value.samples.length >= maxPracticeSamples}
              onClick={() => update({ samples: [...value.samples, newSample(value.samples.length + 1)] })}>
              Add sample
            </button>
          </div>
          <p className="practice-muted">Each sample provides stdin and checks stdout. One final line break is optional. Other whitespace matters.</p>
          {value.samples.map((sample) => (
            <fieldset key={sample.id}>
              <legend>{sample.label || 'Sample'}</legend>
              <label>Sample name<input required maxLength={80} value={sample.label}
                onChange={(event) => updateSample(sample.id, { label: event.target.value })} /></label>
              <label>Standard input<textarea data-testid="practice-input" rows={2} maxLength={12_000} value={sample.input}
                spellCheck={false} onChange={(event) => updateSample(sample.id, { input: event.target.value })} /></label>
              <label>Expected standard output<textarea data-testid="practice-expected" rows={2} maxLength={12_000} value={sample.expectedOutput}
                spellCheck={false} onChange={(event) => updateSample(sample.id, { expectedOutput: event.target.value })} /></label>
              <button type="button" className="button danger"
                onClick={() => update({ samples: value.samples.filter(({ id }) => id !== sample.id) })}>Remove sample</button>
            </fieldset>
          ))}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer className="modal-footer">
          <button className="button danger" type="button" disabled={busy} onClick={onDiscard}>Discard draft</button>
          <button className="button" type="button" disabled={busy} onClick={onClose}>Keep draft</button>
          <button className="button primary" data-testid="practice-save" disabled={busy || !value.title.trim() || !value.statement.trim()}>
            {busy ? 'Saving…' : 'Save problem'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

const statusLabel = {
  passed: 'Passed', failed: 'Failed', unavailable: 'Unable to verify', skipped: 'Skipped',
}

function AttemptResults({ attempt }: { attempt?: PracticeAttempt }) {
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

export function PracticePane({ bridge, initialProblem, onOpenEntry, onPrepareRun, onClose, onDirtyChange, onStopRun }: PracticePaneProps) {
  const [view, setView] = useState<'browse' | 'saved'>(initialProblem ? 'saved' : 'browse')
  const [library, setLibrary] = useState<PracticeLibrary>()
  const [problem, setProblem] = useState<PracticeProblem>()
  const [attemptId, setAttemptId] = useState('')
  const [draft, setDraft] = useState(retainedDraft)
  const [editing, setEditing] = useState(false)
  const [attemptDialog, setAttemptDialog] = useState(false)
  const [pending, setPending] = useState<'load' | 'save' | 'open' | 'run' | 'start' | null>('load')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)

  function setSelected(next: PracticeProblem | undefined) {
    setProblem(next)
    lastProblem = next?.id ?? null
    setAttemptId(next?.attempts.at(-1)?.id ?? '')
  }

  useEffect(() => {
    mounted.current = true
    const load = async () => {
      try {
        const next = await bridge.list()
        const id = next.problems.find((item) => item.id === (initialProblem ?? lastProblem))?.id ?? next.problems[0]?.id
        if (!mounted.current) return
        setLibrary(next)
        if (id) {
          const selected = await bridge.get(id)
          if (mounted.current) setSelected(selected)
        }
      } catch (reason) {
        if (mounted.current) setError(errorMessage(reason))
      } finally {
        if (mounted.current) setPending(null)
      }
    }
    void load()
    return () => { mounted.current = false }
  }, [bridge, initialProblem])

  useEffect(() => { onDirtyChange?.(draft?.dirty ?? false) }, [draft?.dirty, onDirtyChange])
  useEffect(() => { scroll.current?.scrollTo(0, 0) }, [view, problem?.id])

  function edit(next: RetainedDraft | null) {
    retainedDraft = next
    setDraft(next)
    onDirtyChange?.(next?.dirty ?? false)
  }

  async function select(id: string) {
    setError('')
    setNotice('')
    setPending('load')
    try {
      const selected = id ? await bridge.get(id) : undefined
      if (mounted.current) setSelected(selected)
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  function saveToLibrary(saved: PracticeProblem) {
    const { id, title, difficulty, topic, completion, language } = saved
    setLibrary((previous) => ({
      problems: [...(previous?.problems.filter((item) => item.id !== id) ?? []), { id, title, difficulty, topic, completion, language }]
        .sort((a, b) => a.title.localeCompare(b.title)),
      unavailable: previous?.unavailable ?? 0,
    }))
  }

  async function start(challengeId: string, language: RunLanguage) {
    if (pending) return
    setPending('start')
    setError('')
    setNotice('')
    try {
      const started = await bridge.start(challengeId, language)
      if (!mounted.current) return
      setSelected(started.problem)
      setAttemptId(started.attempt.id)
      saveToLibrary(started.problem)
      setView('saved')
      setNotice('Attempt opened in the editor.')
      onOpenEntry(started.entry)
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || pending) return
    setPending('save')
    setError('')
    try {
      const saved = await bridge.save(draft.value)
      retainedDraft = null
      onDirtyChange?.(false)
      if (mounted.current) {
        setDraft(null)
        setEditing(false)
        setSelected(saved)
        setView('saved')
        setNotice('Problem saved locally.')
        saveToLibrary(saved)
      }
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  async function open(id: string) {
    if (!problem || !id) return
    setError('')
    setPending('open')
    try {
      const entry = await bridge.openAttempt(problem.id, id)
      if (mounted.current) onOpenEntry(entry)
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  async function createAttempt(label: string) {
    if (!problem) return
    const created = await bridge.createAttempt(problem.id, label)
    setSelected(created.problem)
    setAttemptId(created.attempt.id)
    setAttemptDialog(false)
    setNotice('New attempt created.')
    await open(created.attempt.id)
  }

  async function run() {
    if (!problem || !attemptId || pending) return
    setPending('run')
    setError('')
    setNotice('')
    try {
      const entry = await bridge.openAttempt(problem.id, attemptId)
      if (!await onPrepareRun(entry.path)) throw new Error('Save your edits before running the samples.')
      if (!mounted.current) return
      const tested = await bridge.runSamples(problem.id, attemptId)
      if (mounted.current) {
        setProblem(tested)
        setNotice('Sample run finished. Results are saved locally.')
      }
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  const attempt = problem?.attempts.find(({ id }) => id === attemptId)
  return (
    <aside className="practice-pane" data-testid="practice-pane" aria-label="Coding practice">
      <div className="practice-heading">
        <h2><Icon name="flask" size={16} /> Practice</h2>
        <button className="icon-button" onClick={onClose} aria-label="Hide Practice" title="Hide Practice"><Icon name="x" size={15} /></button>
      </div>
      <nav className="practice-nav" aria-label="Practice views">
        <button data-testid="practice-browse-tab" aria-pressed={view === 'browse'}
          onClick={() => { setView('browse'); setError(''); setNotice('') }}><Icon name="search" size={14} /> Browse</button>
        <button data-testid="practice-saved-tab" aria-pressed={view === 'saved'}
          onClick={() => { setView('saved'); setError(''); setNotice('') }}><Icon name="folder" size={14} /> Saved</button>
      </nav>
      <div className="practice-scroll" ref={scroll}>
        {!editing && error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="practice-notice" role="status">{notice}</p>}
        {pending === 'start' && <p className="practice-muted" role="status">Opening your challenge…</p>}
        <BrowsePractice bridge={bridge} hidden={view !== 'browse'} busy={Boolean(pending)}
          onStart={(id, language) => void start(id, language)} />
        {view === 'saved' && <>
          <div className="practice-library">
            <label className="practice-label">Saved problems
              <select data-testid="practice-problem" disabled={Boolean(pending) || !library?.problems.length}
                value={problem?.id ?? ''} onChange={(event) => void select(event.target.value)}>
                <option value="">{pending === 'load' ? 'Loading…' : 'Choose a problem'}</option>
                {library?.problems.map(({ id, title, language }) =>
                  <option key={id} value={id}>{title} · {practiceLanguages[language]}</option>)}
              </select>
            </label>
          </div>
          {Boolean(library?.unavailable) && <p className="practice-muted">Some saved problems could not be read. Their local files were preserved.</p>}
          {problem ? (
            <>
              <section className="practice-section">
                <div className="practice-section-heading">
                  <h3>{problem.title}</h3>
                  <button className="button" data-testid="practice-edit" disabled={Boolean(pending) || Boolean(draft)}
                    onClick={() => {
                      const { attempts: _attempts, ...draft } = problem
                      setError('')
                      edit({ value: draft, dirty: false })
                      setEditing(true)
                    }}>Edit problem</button>
                </div>
                <p className="practice-muted">{[practiceLanguages[problem.language], problem.difficulty, problem.topic, problem.completion].filter(Boolean).join(' · ')}</p>
                <p className="practice-statement" data-testid="practice-problem-statement">{problem.statement}</p>
                {problem.sourceUrl && <p className="practice-source" title={problem.sourceUrl}>{problem.sourceUrl}</p>}
                {problem.notes && <><h4>Personal notes</h4><p className="practice-statement" data-testid="practice-saved-notes">{problem.notes}</p></>}
              </section>
              <PracticeSamples samples={problem.samples} />
              <section className="practice-section">
                <div className="practice-section-heading"><h3>Saved attempts</h3>
                  <button className="button" data-testid="practice-new-attempt" disabled={Boolean(pending)}
                    onClick={() => setAttemptDialog(true)}>New attempt</button>
                </div>
                {problem.attempts.length === 0
                  ? <p className="practice-muted">Create a solution file. Each attempt keeps your earlier code available.</p>
                  : <div className="practice-attempt">
                      <label className="practice-label">Attempt<select value={attemptId} data-testid="practice-attempt"
                        disabled={Boolean(pending)} onChange={(event) => { setAttemptId(event.target.value); setNotice('') }}>
                        {problem.attempts.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
                      </select></label>
                      <button className="button" data-testid="practice-open-attempt" disabled={Boolean(pending) || !attemptId}
                        onClick={() => void open(attemptId)}>Open in editor</button>
                    </div>}
                {problem.samples.length > 0 && (
                  <div className="practice-run-actions">
                    <button className="button primary" data-testid="practice-run-samples" disabled={Boolean(pending) || !attemptId}
                      onClick={() => void run()}>{pending === 'run' ? 'Running…' : 'Run samples'}</button>
                    {pending === 'run' && onStopRun && <button className="button" onClick={onStopRun}>Stop</button>}
                    <span className="practice-muted">{problem.samples.length} sample{problem.samples.length === 1 ? '' : 's'}</span>
                  </div>
                )}
              </section>
              <AttemptResults attempt={attempt} />
            </>
          ) : pending !== 'load' && <p className="practice-muted">Start a challenge from Browse to save its problem and first attempt here.</p>}
        </>}
      </div>
      <div className="practice-footer">
        <button className="button" data-testid="practice-new" disabled={Boolean(pending)}
          onClick={() => { setError(''); if (!draft) edit({ value: emptyDraft(), dirty: false }); setEditing(true) }}>
          <Icon name="plus" size={13} />{draft ? 'Resume custom draft' : 'Add custom problem'}
        </button>
      </div>
      {draft && editing && <ProblemForm value={draft.value} busy={pending === 'save'} error={error}
        onChange={(value) => edit({ value, dirty: true })} onSubmit={(event) => void save(event)}
        onClose={() => { setError(''); setEditing(false) }}
        onDiscard={() => { setError(''); edit(null); setEditing(false) }} />}
      {attemptDialog && <EntryDialog title="Create attempt" initial={'Attempt ' + ((problem?.attempts.length ?? 0) + 1)}
        onSubmit={createAttempt} onClose={() => setAttemptDialog(false)} />}
    </aside>
  )
}
