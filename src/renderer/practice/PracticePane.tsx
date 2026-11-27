import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import type { Entry } from '../../shared/contracts'
import type { RunLanguage } from '../../shared/run-console'
import {
  catalogDifficulties, maxPracticeSamples, practiceCompletion, practiceDifficulties, practiceLanguages, practiceTopics,
  type CatalogDifficulty, type PracticeChallenge, type PracticeChallengeSummary, type PracticeTopic,
  type PracticeBridge, type PracticeDraft, type PracticeFields,
  type PracticeLibrary, type PracticeProblem, type PracticeSample,
} from '../../shared/practice'
import { EntryDialog, Modal } from '../Dialogs'
import { errorMessage } from '../documents'
import { Icon } from '../icons'
import { CatalogProgress } from './CatalogProgress'
import { PracticeResults, SubmissionHistory } from './PracticeResults'
import './practice.css'

const BinarySearchWalkthrough = lazy(() => import('./BinarySearchWalkthrough'))
const BreadthFirstSearchWalkthrough = lazy(() => import('./BreadthFirstSearchWalkthrough'))
const DepthFirstSearchWalkthrough = lazy(() => import('./DepthFirstSearchWalkthrough'))
const DijkstraWalkthrough = lazy(() => import('./DijkstraWalkthrough'))
const MergeSortWalkthrough = lazy(() => import('./MergeSortWalkthrough'))
const TreeTraversalWalkthrough = lazy(() => import('./TreeTraversalWalkthrough'))

export interface PracticePaneProps {
  bridge: PracticeBridge
  initialProblem?: string
  onOpenEntry(entry: Entry): void
  onPrepareRun(path: string): Promise<boolean>
  onClose(): void
  onLearn?(): void
  onDirtyChange?(dirty: boolean): void
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

function ProgressiveHints({ hints }: { hints?: readonly string[] }) {
  const [revealed, setRevealed] = useState(0)
  if (!hints?.length) return null
  return <section className="practice-section practice-hints" aria-label="Progressive hints">
    <h3>Need a nudge?</h3>
    <p className="practice-muted">Reveal one hint at a time when you want help.</p>
    {revealed > 0 && <ol>{hints.slice(0, revealed).map((hint, index) => <li key={index}>{hint}</li>)}</ol>}
    {revealed < hints.length && <button className="button" type="button" onClick={() => setRevealed(value => value + 1)}>
      Reveal hint {revealed + 1}
    </button>}
  </section>
}

function ChallengePreview({ bridge, id, language, busy, backLabel, onBack, onStart }: {
  bridge: PracticeBridge
  id: string
  language: RunLanguage | ''
  busy: boolean
  backLabel?: string
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
    <button className="button practice-back" type="button" autoFocus={Boolean(backLabel)} onClick={onBack}>
      {backLabel ?? 'Back to matches'}
    </button>
    {!loaded && <p className="practice-muted" role="status">Opening the problem…</p>}
    {loaded && 'error' in loaded && <p className="form-error" role="alert">{loaded.error}</p>}
    {challenge && <>
      <div className="practice-preview-heading">
        <h4>{challenge.title}</h4>
        <p className="practice-muted">{challenge.topic} · {challenge.difficulty}</p>
      </div>
      <p className="practice-statement" data-testid="practice-problem-statement">{challenge.statement}</p>
      <ProgressiveHints hints={challenge.hints}/>
      <PracticeSamples samples={challenge.samples} />
      {!language && <p className="practice-muted">Choose a language above to open a solution file.</p>}
      <button className="button primary" data-testid="practice-start" disabled={busy || !language}
        onClick={() => { if (language) onStart(id, language) }}>Start challenge <Icon name="arrow" size={14} /></button>
    </>}
  </section>
}

function ProgressPractice({ bridge, busy, onStart, onLearnLesson }: {
  bridge: PracticeBridge
  busy: boolean
  onStart(id: string, language: RunLanguage): void
  onLearnLesson(topic: PracticeTopic): void
}) {
  const [previewId, setPreviewId] = useState('')
  const [language, setLanguage] = useState<RunLanguage | ''>('')
  return <>
    <CatalogProgress bridge={bridge} hidden={Boolean(previewId)} onViewChallenge={setPreviewId} onLearnLesson={onLearnLesson} />
    {previewId && <section className="practice-discovery" aria-label="Suggested practice challenge">
      <label className="practice-label">Language
        <select value={language} onChange={(event) => setLanguage(event.target.value as RunLanguage | '')}>
          <option value="">Choose language</option>
          {languageOptions}
        </select>
      </label>
      <ChallengePreview key={previewId} bridge={bridge} id={previewId} language={language} busy={busy}
        backLabel="Back to progress" onBack={() => setPreviewId('')} onStart={onStart} />
    </section>}
  </>
}

function BrowsePractice({ bridge, hidden, busy, walkthroughEntry, breadthFirstEntry, depthFirstEntry, dijkstraEntry, mergeSortEntry, treeTraversalEntry, onWalkthrough, onStart }: {
  bridge: PracticeBridge
  hidden: boolean
  busy: boolean
  walkthroughEntry: RefObject<HTMLButtonElement | null>
  breadthFirstEntry: RefObject<HTMLButtonElement | null>
  depthFirstEntry: RefObject<HTMLButtonElement | null>
  dijkstraEntry: RefObject<HTMLButtonElement | null>
  mergeSortEntry: RefObject<HTMLButtonElement | null>
  treeTraversalEntry: RefObject<HTMLButtonElement | null>
  onWalkthrough(kind: 'binary-search' | 'breadth-first-search' | 'depth-first-search' | 'dijkstra' | 'merge-sort' | 'tree-traversal'): void
  onStart(id: string, language: RunLanguage): void
}) {
  const [language, setLanguage] = useState<RunLanguage | ''>('')
  const [topic, setTopic] = useState<PracticeTopic | ''>('')
  const [difficulty, setDifficulty] = useState<CatalogDifficulty | ''>('')
  const [solved, setSolved] = useState<'solved' | 'unsolved' | ''>('')
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState('')
  const [previewId, setPreviewId] = useState('')
  const [retry, setRetry] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; matches: PracticeChallengeSummary[]; error?: string }>()
  const section = useRef<HTMLElement>(null)
  const query = search || solved || (difficulty && (language || topic))
    ? JSON.stringify([language, topic, difficulty, search, solved, retry]) : ''
  const result = query && loaded?.key === query ? loaded : undefined

  useEffect(() => {
    if (hidden || !query || loaded?.key === query) return
    let active = true
    void bridge.browse({ language: language || undefined, topic: topic || undefined,
      difficulty: difficulty || undefined, search: search || undefined, solved: solved || undefined }).then(
      (matches) => { if (active) setLoaded({ key: query, matches }) },
      (reason) => { if (active) setLoaded({ key: query, matches: [], error: errorMessage(reason) }) },
    )
    return () => { active = false }
  }, [bridge, difficulty, hidden, language, loaded?.key, query, search, topic])

  useEffect(() => { section.current?.parentElement?.scrollTo(0, 0) }, [previewId])

  function clearSearch() {
    setSearchText('')
    setSearch('')
    setPreviewId('')
  }

  if (hidden) return null
  return (
    <section ref={section} className="practice-discovery" aria-label="Browse practice problems">
      <div className="practice-intro">
        <h3>Find a challenge</h3>
        <span className="practice-catalog-badge">Offline catalog</span>
      </div>
      <button ref={walkthroughEntry} className="button practice-walkthrough-entry" type="button" onClick={() => onWalkthrough('binary-search')}>
        <Icon name="book" size={14} /> Walk through binary search
      </button>
      <button ref={breadthFirstEntry} className="button practice-walkthrough-entry" type="button"
        onClick={() => onWalkthrough('breadth-first-search')}>
        <Icon name="book" size={14} /> Walk through breadth-first search
      </button>
      <button ref={depthFirstEntry} className="button practice-walkthrough-entry" type="button"
        onClick={() => onWalkthrough('depth-first-search')}>
        <Icon name="book" size={14} /> Walk through depth-first search
      </button>
      <button ref={dijkstraEntry} className="button practice-walkthrough-entry" type="button"
        onClick={() => onWalkthrough('dijkstra')}>
        <Icon name="book" size={14} /> Walk through Dijkstra’s algorithm
      </button>
      <button ref={mergeSortEntry} className="button practice-walkthrough-entry" type="button"
        onClick={() => onWalkthrough('merge-sort')}>
        <Icon name="book" size={14} /> Walk through merge sort
      </button>
      <button ref={treeTraversalEntry} className="button practice-walkthrough-entry" type="button"
        onClick={() => onWalkthrough('tree-traversal')}>
        <Icon name="book" size={14} /> Walk through binary-tree traversals
      </button>
      <form className="practice-search" role="search" aria-label="Practice catalog" onSubmit={(event) => {
        event.preventDefault()
        setSearch(searchText.trim())
        setPreviewId('')
      }}>
        <label className="practice-label">Search by title or topic
          <input type="search" maxLength={100} value={searchText} onChange={(event) => {
            if (!event.target.value) clearSearch()
            else setSearchText(event.target.value)
          }}/>
        </label>
        <button className="button" type="submit" disabled={!searchText.trim()}>Search</button>
        {(searchText || search) && <button className="button" type="button" onClick={clearSearch} aria-label="Clear search">Clear</button>}
      </form>
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
        <label className="practice-label">Solved status
          <select data-testid="practice-solved" value={solved}
            onChange={(event) => { setSolved(event.target.value as 'solved' | 'unsolved' | ''); setPreviewId('') }}>
            <option value="">Any status</option>
            <option value="solved">Solved</option>
            <option value="unsolved">Not solved</option>
          </select>
        </label>
      </div>
      {previewId ? (
        <ChallengePreview key={previewId} bridge={bridge} id={previewId} language={language} busy={busy}
          onBack={() => setPreviewId('')} onStart={onStart} />
      ) : !query ? (
        <div className="practice-catalog-state">
          <Icon name="search" size={17} />
          <p>To browse with filters, choose a difficulty and a language or topic.</p>
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
          <p role="status">No matches. Try different search terms or filters.</p>
        </div>
      ) : (
        <div className="practice-matches">
          <div className="practice-section-heading">
            <h4>{search ? 'Matches for “' + search + '”' : 'Matching challenges'}</h4>
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


export function PracticePane({ bridge, initialProblem, onOpenEntry, onPrepareRun, onClose, onDirtyChange, onLearn }: PracticePaneProps) {
  const [view, setView] = useState<'browse' | 'saved' | 'progress' | 'binary-search' | 'breadth-first-search' | 'depth-first-search' | 'dijkstra' | 'merge-sort' | 'tree-traversal'>(initialProblem ? 'saved' : 'browse')
  const [library, setLibrary] = useState<PracticeLibrary>()
  const [problem, setProblem] = useState<PracticeProblem>()
  const [attemptId, setAttemptId] = useState('')
  const [draft, setDraft] = useState(retainedDraft)
  const [editing, setEditing] = useState(false)
  const [attemptDialog, setAttemptDialog] = useState(false)
  const [pending, setPending] = useState<'load' | 'save' | 'open' | 'run' | 'submit' | 'refresh' | 'start' | null>('load')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const activeRun = useRef<{ started: boolean; stopped: boolean } | null>(null)
  const [stopping, setStopping] = useState(false)
  const mounted = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const walkthroughEntry = useRef<HTMLButtonElement>(null)
  const breadthFirstEntry = useRef<HTMLButtonElement>(null)
  const depthFirstEntry = useRef<HTMLButtonElement>(null)
  const dijkstraEntry = useRef<HTMLButtonElement>(null)
  const mergeSortEntry = useRef<HTMLButtonElement>(null)
  const treeTraversalEntry = useRef<HTMLButtonElement>(null)
  const walkthroughKind = useRef<'binary-search' | 'breadth-first-search' | 'depth-first-search' | 'dijkstra' | 'merge-sort' | 'tree-traversal'>('binary-search')
  const returningFromWalkthrough = useRef(false)

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
  useEffect(() => {
    if (view === 'browse' && returningFromWalkthrough.current) {
      returningFromWalkthrough.current = false;
      (walkthroughKind.current === 'binary-search' ? walkthroughEntry.current
        : walkthroughKind.current === 'breadth-first-search' ? breadthFirstEntry.current
          : walkthroughKind.current === 'depth-first-search' ? depthFirstEntry.current
          : walkthroughKind.current === 'dijkstra' ? dijkstraEntry.current
            : walkthroughKind.current === 'merge-sort' ? mergeSortEntry.current : treeTraversalEntry.current)?.focus()
    }
  }, [view])

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

  async function run(action: 'run' | 'submit') {
    if (!problem || !attemptId || pending || activeRun.current || (action === 'submit' && problem.canSubmit !== true)) return
    const request = { started: false, stopped: false }
    activeRun.current = request
    setPending(action)
    setError('')
    setNotice('')
    try {
      const entry = await bridge.openAttempt(problem.id, attemptId)
      if (!mounted.current || request.stopped) return
      const ready = await onPrepareRun(entry.path)
      if (!mounted.current || request.stopped) return
      if (!ready) throw new Error('Save your edits before running this attempt.')
      request.started = true
      const tested = action === 'submit' ? await bridge.submit(problem.id, attemptId) : await bridge.runSamples(problem.id, attemptId)
      if (mounted.current) {
        setProblem(tested)
        setNotice(action === 'submit' ? 'Local submission saved.' : 'Sample run finished. Results are saved locally.')
      }
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      activeRun.current = null
      if (mounted.current) {
        if (request.stopped && !request.started) setNotice('Stopped before running the saved attempt.')
        setStopping(false)
        setPending(null)
      }
    }
  }

  async function stop() {
    const request = activeRun.current
    if (!request || request.stopped) return
    request.stopped = true
    setStopping(true)
    if (request.started) {
      try {
        await bridge.cancelSamples()
      } catch (reason) {
        if (mounted.current && activeRun.current === request) {
          request.stopped = false
          setStopping(false)
          setError(errorMessage(reason))
        }
      }
    }
  }

  async function refreshHistory() {
    if (!problem || pending) return
    setPending('refresh')
    setError('')
    setNotice('')
    try {
      const latest = await bridge.get(problem.id)
      if (mounted.current) setProblem(latest)
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
        {onLearn && <button type="button" className="button" data-testid="practice-return-learn" onClick={onLearn}><Icon name="book" size={13}/> Learn</button>}
        <button className="icon-button" onClick={onClose} aria-label="Hide Practice" title="Hide Practice"><Icon name="x" size={15} /></button>
      </div>
      <nav className="practice-nav" aria-label="Practice views">
        <button data-testid="practice-browse-tab" aria-pressed={view === 'browse' || view === 'binary-search' || view === 'breadth-first-search' || view === 'depth-first-search' || view === 'dijkstra' || view === 'merge-sort' || view === 'tree-traversal'}
          onClick={() => { setView('browse'); setError(''); setNotice('') }}><Icon name="search" size={14} /> Browse</button>
        <button data-testid="practice-saved-tab" aria-pressed={view === 'saved'}
          onClick={() => { setView('saved'); setError(''); setNotice('') }}><Icon name="folder" size={14} /> Saved</button>
        <button data-testid="practice-progress-tab" aria-pressed={view === 'progress'}
          onClick={() => { setView('progress'); setError(''); setNotice('') }}><Icon name="map" size={14} /> Progress</button>
      </nav>
      <div className="practice-scroll" ref={scroll}>
        {!editing && error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="practice-notice" role="status">{notice}</p>}
        {pending === 'start' && <p className="practice-muted" role="status">Opening your challenge…</p>}
        <BrowsePractice bridge={bridge} hidden={view !== 'browse'} busy={Boolean(pending)}
          walkthroughEntry={walkthroughEntry} breadthFirstEntry={breadthFirstEntry} depthFirstEntry={depthFirstEntry}
          dijkstraEntry={dijkstraEntry}
          mergeSortEntry={mergeSortEntry}
          treeTraversalEntry={treeTraversalEntry}
          onWalkthrough={kind => { walkthroughKind.current = kind; setView(kind); setError(''); setNotice('') }}
          onStart={(id, language) => void start(id, language)} />
        {view === 'binary-search' && <div className="practice-discovery practice-walkthrough">
          <button className="button" type="button" autoFocus onClick={() => {
            returningFromWalkthrough.current = true
            setView('browse')
          }}>Back to Browse</button>
          <Suspense fallback={<p className="practice-muted" role="status">Opening walkthrough…</p>}>
            <BinarySearchWalkthrough />
          </Suspense>
        </div>}
        {view === 'breadth-first-search' && <div className="practice-discovery practice-walkthrough">
          <button className="button" type="button" autoFocus onClick={() => {
            returningFromWalkthrough.current = true
            setView('browse')
          }}>Back to Browse</button>
          <Suspense fallback={<p className="practice-muted" role="status">Opening walkthrough…</p>}>
            <BreadthFirstSearchWalkthrough />
          </Suspense>
        </div>}
        {view === 'depth-first-search' && <div className="practice-discovery practice-walkthrough">
          <button className="button" type="button" autoFocus onClick={() => {
            returningFromWalkthrough.current = true
            setView('browse')
          }}>Back to Browse</button>
          <Suspense fallback={<p className="practice-muted" role="status">Opening walkthrough…</p>}>
            <DepthFirstSearchWalkthrough />
          </Suspense>
        </div>}
        {view === 'dijkstra' && <div className="practice-discovery practice-walkthrough">
          <button className="button" type="button" autoFocus onClick={() => {
            returningFromWalkthrough.current = true
            setView('browse')
          }}>Back to Browse</button>
          <Suspense fallback={<p className="practice-muted" role="status">Opening walkthrough…</p>}>
            <DijkstraWalkthrough />
          </Suspense>
        </div>}
        {view === 'merge-sort' && <div className="practice-discovery practice-walkthrough">
          <button className="button" type="button" autoFocus onClick={() => {
            returningFromWalkthrough.current = true
            setView('browse')
          }}>Back to Browse</button>
          <Suspense fallback={<p className="practice-muted" role="status">Opening walkthrough…</p>}>
            <MergeSortWalkthrough />
          </Suspense>
        </div>}
        {view === 'tree-traversal' && <div className="practice-discovery practice-walkthrough">
          <button className="button" type="button" autoFocus onClick={() => {
            returningFromWalkthrough.current = true
            setView('browse')
          }}>Back to Browse</button>
          <Suspense fallback={<p className="practice-muted" role="status">Opening walkthrough…</p>}>
            <TreeTraversalWalkthrough />
          </Suspense>
        </div>}
        {view === 'progress' && <ProgressPractice bridge={bridge} busy={Boolean(pending)}
          onLearnLesson={topic => {
            const kind = topic === 'Search' ? 'binary-search' : topic === 'Sorting' ? 'merge-sort' : 'breadth-first-search'
            walkthroughKind.current = kind
            setView(kind)
            setError('')
            setNotice('')
          }}
          onStart={(id, language) => void start(id, language)} />}
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
                      const { attempts: _attempts, canSubmit: _canSubmit, ...draft } = problem
                      setError('')
                      edit({ value: draft, dirty: false })
                      setEditing(true)
                    }}>Edit problem</button>
                </div>
                <p className="practice-muted">{[practiceLanguages[problem.language], problem.difficulty, problem.topic, problem.canSubmit === true ? 'Manual status · ' + problem.completion : problem.completion].filter(Boolean).join(' · ')}</p>
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
                {(problem.samples.length > 0 || problem.canSubmit === true) && (
                  <div className="practice-run-actions">
                    {problem.samples.length > 0 && <>
                      <button className="button primary" data-testid="practice-run-samples" disabled={Boolean(pending) || !attemptId}
                        onClick={() => void run('run')}>{pending === 'run' ? 'Running…' : 'Run samples'}</button>
                      <span className="practice-muted">{problem.samples.length} sample{problem.samples.length === 1 ? '' : 's'}</span>
                    </>}
                    {problem.canSubmit === true && <button className="button" data-testid="practice-submit"
                      disabled={Boolean(pending) || !attemptId} onClick={() => void run('submit')}>
                      {pending === 'submit' ? 'Submitting…' : 'Local Submit'}
                    </button>}
                    {(pending === 'run' || pending === 'submit') && <button className="button" data-testid="practice-stop"
                      disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop'}</button>}
                  </div>
                )}
                {problem.canSubmit === true && <p className="practice-muted">Local Submit checks the saved file against hidden cases offline. You control completion in Edit problem.</p>}
              </section>
              {problem.canSubmit === true && <SubmissionHistory attempt={attempt} busy={Boolean(pending)}
                onRefresh={() => void refreshHistory()}/>}
              <PracticeResults attempt={attempt} />
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
