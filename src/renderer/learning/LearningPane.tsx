import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  diagnosticConcepts, diagnosticTitles, type ConceptId, type LearningBridge, type LearningConcept, type LearningDiagnostic,
  type LearningFeedback, type LearningHistory,
} from '../../shared/learning'
import { diagnosticPackIds, type LearningPacksBridge, type PackDetails, type PackLesson, type PackLibrary,
  type PackReference, type PackSummary, type PackTopic } from '../../shared/learning-packs'
import { errorMessage } from '../documents'
import { Icon } from '../icons'
import './learning.css'

interface Props {
  bridge: LearningBridge
  feedback?: LearningFeedback
  lensEnabled: boolean
  lensSelection?: LearningLensSelection
  sourceCurrent?: boolean
  canRevealDiagnostic?(diagnostic: LearningDiagnostic): boolean
  onRevealDiagnostic?(diagnostic: LearningDiagnostic): void
  packs: LearningPacksBridge
  library: PackLibrary | null
  includeCatalog: boolean
  loadError?: string
  onRetry?(): void
  onLibraryChange(library: PackLibrary): void
  onMarketplace(): void
  onClose(): void
  onExercise: (result: Awaited<ReturnType<LearningPacksBridge['startExercise']>>) => void
}

interface LearningLensSelection {
  diagnostic: LearningDiagnostic
  request: number
}

type View = 'result' | 'topics' | 'history'
type Load<T> = { value: T } | { error: string }

function locationLabel(location: LearningDiagnostic['location']): string {
  if (!location) return ''
  const name = location.file.split(/[/\\]/).at(-1) ?? location.file
  return name + ':' + location.line + (location.column ? ':' + location.column : '')
}

function Description({ diagnostic, encourage, onExplain, onLesson }: {
  diagnostic: LearningDiagnostic
  encourage: boolean
  onExplain(id: ConceptId): void
  onLesson(id: string): void
}) {
  const concept = diagnostic.concepts[0]
  const title = diagnosticTitles[diagnostic.category]
  return (
    <section className="learning-diagnostic" data-testid="learning-diagnostic" data-category={diagnostic.category}>
      <h3>{title}</h3>
      <p className="learning-meta">
        {({ clang: 'Clang', gcc: 'GCC', javac: 'javac', python: 'Python', node: 'Node.js' } as Record<string, string>)[diagnostic.compiler]
          ?? 'Run output'}
        {' · '}{diagnostic.phase === 'runtime' ? 'runtime' : diagnostic.severity}
        {diagnostic.location && <> · {locationLabel(diagnostic.location)}</>}
      </p>
      <details open={diagnostic.confidence === 'uncertain' ? true : undefined}>
        <summary>{diagnostic.phase === 'runtime' ? 'Original run message' : 'Original compiler diagnostic'}</summary>
        <pre>{diagnostic.raw}</pre>
      </details>
      {diagnostic.confidence === 'uncertain' && (
        <p className="learning-copy">The available evidence does not point to a single concept. Start with the original message{diagnostic.location ? ' and the first location it reports.' : '.'}</p>
      )}
      {diagnostic.guidance && <p className="learning-copy">{diagnostic.guidance}</p>}
      {(concept || diagnostic.packTopic) && (
        <>
          {encourage && (
            <p className="learning-encouragement" data-testid="learning-encouragement">Keep going, you've got this. Want to revisit the concept?</p>
          )}
          <button className="button" data-testid="learning-show-explanation" onClick={() => {
            if (diagnostic.packTopic) onLesson(diagnostic.packTopic)
            else if (concept) onExplain(concept)
          }}>
            {diagnostic.occurrence === 'repeated' ? 'Show Explanation Again' : 'Show Explanation'}
          </button>
        </>
      )}
    </section>
  )
}

function Concept({ concept, titles, onRead }: {
  concept: LearningConcept
  titles: Map<ConceptId, string>
  onRead(id: ConceptId): void
}) {
  return (
    <article className="learning-concept" data-testid="learning-concept" data-concept={concept.id}>
      <h3>{concept.title}</h3>
      <p>{concept.explanation}</p>
      <h4>Example</h4>
      <pre><code>{concept.example}</code></pre>
      <p>{concept.exampleExplanation}</p>
      <details className="learning-reference">
        <summary>More about this concept</summary>
        <h4>Common misconceptions</h4>
        <ul>{concept.misconceptions.map((item) => <li key={item}>{item}</li>)}</ul>
        <h4>{concept.reference.title}</h4>
        <p>{concept.reference.text}</p>
      </details>
      <h4>Related topics</h4>
      <div className="learning-related">
        {concept.related.map((id) => (
          <button className="button" key={id} onClick={() => onRead(id)}>{titles.get(id) ?? id}</button>
        ))}
      </div>
    </article>
  )
}

function LensDiagnostic({ diagnostic, selected, sourceCurrent, onReveal, onExplain, onLesson, children }: {
  diagnostic: LearningDiagnostic
  selected: boolean
  sourceCurrent: boolean
  onReveal?: () => void
  onExplain(): void
  onLesson?: () => void
  children?: ReactNode
}) {
  const known = diagnostic.confidence === 'high' && diagnostic.concepts.length > 0
  const repeated = known && diagnostic.occurrence === 'repeated'
  const location = locationLabel(diagnostic.location)
  const severity = diagnostic.phase === 'runtime' ? 'Runtime' : diagnostic.severity === 'warning' ? 'Warning' : 'Compiler error'
  return (
    <section className="learning-diagnostic lens-diagnostic" data-testid="learning-diagnostic"
      data-category={diagnostic.category} data-selected={selected || undefined} data-known={known}>
      <div className="lens-diagnostic-context">
        <span className="lens-severity" data-warning={diagnostic.severity === 'warning'}>
          <Icon name={known ? 'warning' : 'info'} size={12}/>{severity}
        </span>
        {location && (onReveal && sourceCurrent
          ? <button type="button" className="lens-location" data-testid="learning-lens-location"
            title={diagnostic.location?.file} aria-label={'Go to ' + location} onClick={onReveal}>
            <span>{location}</span><Icon name="diagonal" size={11}/>
          </button>
          : <span className="lens-location" title={diagnostic.location?.file}>{location}</span>)}
      </div>
      <h3>{diagnosticTitles[diagnostic.category]}</h3>
      {repeated && <p className="lens-repeat" data-testid="learning-encouragement"><Icon name="refresh" size={12}/>Seen again after an edit</p>}
      {known && diagnostic.guidance && <p className="learning-copy lens-guidance">{diagnostic.guidance}</p>}
      {!known && <p className="learning-copy lens-uncertain">No reliable explanation is available for this diagnostic. Start with the original message.</p>}
      <details open={!known || undefined}>
        <summary>{diagnostic.phase === 'runtime' ? 'Original run message' : 'Original compiler diagnostic'}</summary>
        <pre>{diagnostic.raw}</pre>
      </details>
      {known && <div className="lens-actions">
        <button type="button" className="button lens-explain" data-testid="learning-show-explanation"
          aria-expanded={Boolean(children)} onClick={onExplain}>
          <Icon name={repeated ? 'refresh' : 'book'} size={13}/>
          {children ? 'Hide explanation' : repeated ? 'Explain Again' : 'Explain'}
        </button>
        {onLesson && <button type="button" className="button" data-testid="learning-lens-lesson" onClick={onLesson}>
          Offline lesson <Icon name="chevron" size={12}/>
        </button>}
      </div>}
      {children}
    </section>
  )
}

function References({ references }: { references: PackReference[] }) {
  const [error, setError] = useState<string>()
  if (!references.length) return null
  return <details className="learning-reference">
    <summary>Online references</summary>
    <ul>{references.map(({ title, url }) => <li key={url}>
      <button type="button" className="button" title={url} onClick={() => {
        setError(undefined)
        void window.ion.markdown.openLink(null, url).catch((reason: unknown) => setError(errorMessage(reason)))
      }}>{title}</button>
    </li>)}</ul>
    {error && <p role="alert" className="learning-error">{error}</p>}
  </details>
}

function PackLessonReader({ packs, pack, topicId, topics, onBack, onTopic, onExercise }: {
  packs: LearningPacksBridge
  pack: PackSummary
  topicId: string
  topics: PackTopic[]
  onBack(): void
  onTopic(id: string): void
  onExercise: Props['onExercise']
}) {
  const [lesson, setLesson] = useState<Load<PackLesson> | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string>()
  const mounted = useRef(false)
  const back = useRef<HTMLButtonElement>(null)
  const packId = pack.id
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { back.current?.focus() }, [])
  useEffect(() => {
    let active = true
    void packs.getLesson(packId, topicId).then(
      (value) => { if (active) setLesson({ value }) },
      (reason: unknown) => { if (active) setLesson({ error: errorMessage(reason) }) },
    )
    return () => { active = false }
  }, [packId, packs, topicId])
  const showTopic = (id: string) => topics.find((topic) => topic.id === id)?.title ?? id
  return (
    <>
      <button ref={back} type="button" className="button learning-back" onClick={onBack}>Back to topics</button>
      {!lesson ? <p className="learning-copy" role="status">Opening lesson…</p>
        : 'error' in lesson ? <p className="learning-error" role="alert">{lesson.error}</p>
          : <article className="learning-concept learning-pack-lesson" data-testid="learning-pack-lesson" data-topic={lesson.value.id}>
            <p className="learning-kicker">{lesson.value.section}{lesson.value.difficulty && ' · ' + lesson.value.difficulty}</p>
            <h3>{lesson.value.title}</h3>
            {!!lesson.value.prerequisites?.length && <p className="learning-meta">Before this lesson, read {lesson.value.prerequisites.map(showTopic).join(', ')}.</p>}
            <p>{lesson.value.explanation}</p>
            <h4>Example</h4>
            {lesson.value.exampleFile && <p className="learning-meta">{lesson.value.exampleFile}</p>}
            <pre><code>{lesson.value.example}</code></pre>
            {lesson.value.expectedOutput && <details className="learning-reference"><summary>Expected example output</summary>
              <pre>{lesson.value.expectedOutput}</pre></details>}
            {lesson.value.api.length > 0 && <>
              <h4>Key APIs and syntax</h4>
              <dl className="learning-api-list">
                {lesson.value.api.map(({ name, description }, index) => (
                  <div key={index}><dt><code>{name}</code></dt><dd>{description}</dd></div>
                ))}
              </dl>
            </>}
            {lesson.value.pitfall && <div className="learning-pitfall">
              <h4>Watch for</h4>
              <p>{lesson.value.pitfall}</p>
            </div>}
            <div className="learning-exercise">
              <h4>Try it yourself</h4>
              <p>{lesson.value.practice}</p>
              {lesson.value.exercise && <>
                <h4>Expected behavior</h4><p>{lesson.value.exercise.expected}</p>
                <h4>Completion criteria</h4><p>{lesson.value.exercise.completion}</p>
                {!!lesson.value.exercise.samples?.length && <details>
                  <summary>Sample inputs and outputs</summary>
                  {lesson.value.exercise.samples.map(({ input, expectedOutput }, index) => <div key={index}>
                    <p>Input {index + 1}</p><pre>{input || '(empty)'}</pre><p>Output</p><pre>{expectedOutput || '(empty)'}</pre>
                  </div>)}
                </details>}
                {diagnosticPackIds.some((id) => id === packId) && <button className="button" type="button"
                  data-testid="learning-start-exercise" disabled={starting} onClick={() => {
                    setStarting(true)
                    setStartError(undefined)
                    void packs.startExercise(packId, topicId).then(
                      (result) => { if (mounted.current) onExercise(result) },
                      (reason: unknown) => { if (mounted.current) setStartError(errorMessage(reason)) },
                    ).finally(() => { if (mounted.current) setStarting(false) })
                  }}>{starting ? 'Opening Practice…' : 'Open in Practice'}</button>}
                {startError && <p role="alert" className="learning-error">{startError}</p>}
              </>}
            </div>
            {!!lesson.value.related?.length && <><h4>Related lessons</h4><div className="learning-related">
              {lesson.value.related.map((id) => <button className="button" key={id} onClick={() => onTopic(id)}>{showTopic(id)}</button>)}
            </div></>}
            <References references={lesson.value.references ?? []}/>
          </article>}
    </>
  )
}

function PackTopics({ packs, pack, topicId, onTopic, onExercise }: {
  packs: LearningPacksBridge
  pack: PackSummary
  topicId: string | null
  onTopic(id: string | null): void
  onExercise: Props['onExercise']
}) {
  const [details, setDetails] = useState<Load<PackDetails> | null>(null)
  const index = useRef<HTMLDivElement>(null)
  const previousTopic = useRef<string>(null)
  useEffect(() => {
    let active = true
    void packs.getDetails(pack.id).then(
      (value) => { if (active) setDetails({ value }) },
      (reason: unknown) => { if (active) setDetails({ error: errorMessage(reason) }) },
    )
    return () => { active = false }
  }, [pack.id, packs])
  useEffect(() => {
    if (topicId || !previousTopic.current) return
    index.current?.querySelector<HTMLButtonElement>(`[data-topic="${CSS.escape(previousTopic.current)}"]`)?.focus()
    previousTopic.current = null
  }, [topicId])
  if (!details) return <p className="learning-copy" role="status">Opening topics…</p>
  if ('error' in details) return <p className="learning-error" role="alert">{details.error}</p>
  const { topics, prerequisites, references, miniProject } = details.value
  if (topicId) return <PackLessonReader key={topicId} packs={packs} pack={pack} topicId={topicId} topics={topics}
    onBack={() => onTopic(null)} onTopic={onTopic} onExercise={onExercise}/>

  const sections = new Map<string, PackTopic[]>()
  for (const topic of topics) {
    const group = sections.get(topic.section)
    if (group) group.push(topic)
    else sections.set(topic.section, [topic])
  }
  return (
    <div ref={index}>
      <div className="learning-pack-intro">
        <h3>{pack.name}</h3>
        <span>{topics.length} {topics.length === 1 ? 'topic' : 'topics'} · Available offline</span>
      </div>
      {!!prerequisites.length && <details className="learning-reference"><summary>Prerequisites</summary>
        <ul>{prerequisites.map((item) => <li key={item}>{item}</li>)}</ul></details>}
      {[...sections].map(([section, items]) => <section className="learning-topic-section" key={section}>
        <h4>{section}</h4>
        <ul className="learning-topic-list">{items.map(({ id, title }) => (
          <li key={id}><button type="button" className="button learning-topic-button" data-testid="learning-topic" data-topic={id}
            onClick={() => { previousTopic.current = id; onTopic(id) }}><span>{title}</span><Icon name="chevron" size={13}/></button></li>
        ))}</ul>
      </section>)}
      {miniProject && <details className="learning-reference"><summary>Mini-project</summary><p>{miniProject}</p></details>}
      <References references={references}/>
    </div>
  )
}

function DiagnosticResults({ bridge, feedback, pack, lensSelection, openedSelection, sourceCurrent, canRevealDiagnostic, onRevealDiagnostic, onLesson }: {
  bridge: LearningBridge
  feedback?: LearningFeedback
  pack: PackSummary
  lensSelection?: LearningLensSelection
  openedSelection: RefObject<number | undefined>
  sourceCurrent: boolean
  canRevealDiagnostic?: Props['canRevealDiagnostic']
  onRevealDiagnostic?: Props['onRevealDiagnostic']
  onLesson(id: string): void
}) {
  const lens = pack.id === 'c'
  const [reader, setReader] = useState<{
    feedback: LearningFeedback | undefined
    diagnostic: LearningDiagnostic
    result: Load<LearningConcept> | null
  } | null>(null)
  const [titles, setTitles] = useState(() => new Map<ConceptId, string>())
  const [historyError, setHistoryError] = useState<string | null>(null)
  const request = useRef(0)
  useEffect(() => () => { request.current += 1 }, [feedback])
  const activeReader = reader?.feedback === feedback ? reader : null

  const readConcept = useCallback(async (diagnostic: LearningDiagnostic, id: ConceptId, action: 'viewed' | 'selected') => {
    const token = ++request.current
    setHistoryError(null)
    setReader({ feedback, diagnostic, result: null })
    try {
      const concept = await bridge.getConcept(id)
      if (request.current !== token) return
      setReader({ feedback, diagnostic, result: { value: concept } })
    } catch (reason) {
      if (request.current === token) setReader({ feedback, diagnostic, result: { error: errorMessage(reason) } })
      return
    }
    if (!titles.size) {
      void bridge.getTopics().then((topics) => {
        if (request.current === token) setTitles(new Map(topics.map(({ id, title }) => [id, title])))
      }).catch(() => {})
    }
    try {
      await bridge.recordTopic(id, action)
    } catch (reason) {
      if (request.current === token) setHistoryError(errorMessage(reason))
    }
  }, [bridge, feedback, titles.size])

  useEffect(() => {
    if (!lensSelection || openedSelection.current === lensSelection.request) return
    openedSelection.current = lensSelection.request
    const { diagnostic } = lensSelection
    if (diagnostic.confidence === 'high' && diagnostic.concepts[0]) {
      void readConcept(diagnostic, diagnostic.concepts[0], 'viewed')
    }
  }, [lensSelection, openedSelection, readConcept])

  function closeExplanation() {
    request.current += 1
    setReader(null)
    setHistoryError(null)
  }

  const explanation = activeReader && <div className="lens-explanation">
    {historyError && <p className="learning-error" role="alert">{historyError}</p>}
    {!activeReader.result ? <p className="learning-copy" role="status">Opening explanation…</p>
      : 'error' in activeReader.result ? <p className="learning-error" role="alert">{activeReader.result.error}</p>
        : <Concept concept={activeReader.result.value} titles={titles}
          onRead={(id) => void readConcept(activeReader.diagnostic, id, 'selected')}/>}
  </div>
  if (!lens && explanation) return <>
    <button type="button" className="button learning-back" onClick={closeExplanation}>Back to latest run</button>
    {explanation}
  </>

  const diagnostics = feedback?.diagnostics.filter(({ severity }) => severity !== 'note') ?? []
  const firstErrors = diagnostics.filter(({ severity }) => severity === 'error' || severity === 'fatal error')
  const selected = lensSelection?.diagnostic
  const prioritized = firstErrors.length > 0 ? firstErrors : diagnostics
  const results = selected ? [selected, ...prioritized.filter((diagnostic) => diagnostic !== selected)] : prioritized
  const encourageIndex = results.findIndex(({ occurrence, concepts, packTopic }) => occurrence === 'repeated' && (concepts.length > 0 || packTopic))
  return <div className={lens ? 'learning-lens' : undefined} data-testid={lens ? 'learning-lens' : undefined}>
    {lens && <header className="lens-heading">
      <Icon name="eye" size={17}/>
      <div><h3>Learning Lens</h3><p>Understand your latest C diagnostics.</p></div>
      <span className="lens-local">Offline</span>
    </header>}
    {lens && !sourceCurrent && results.some(({ location }) => Boolean(location)) && (
      <p className="lens-revision-note" data-testid="learning-lens-stale">
        <Icon name="info" size={13}/>Locations refer to the last compiled version.
      </p>
    )}
    {feedback?.historyUnavailable && <p className="learning-error" role="status">Local history is unavailable. You can still open explanations for this run.</p>}
    {feedback?.resolved.length ? (
      <div className="learning-resolved" data-testid="learning-resolved" role="status">
        <strong>{lens && <Icon name="check" size={14}/>}
          {feedback.resolved.length === 1 ? 'Diagnostic resolved in this run' : 'Diagnostics resolved in this run'}</strong>
        <ul>{feedback.resolved.map((category) => <li key={category}>{diagnosticTitles[category]}</li>)}</ul>
      </div>
    ) : null}
    {results.length ? results.slice(0, 8).map((diagnostic, index) => {
      const key = diagnostic.category + (diagnostic.location ? locationLabel(diagnostic.location) : '') + index
      if (!lens) return <Description key={key} diagnostic={diagnostic} encourage={index === encourageIndex}
        onExplain={(id) => void readConcept(diagnostic, id, 'viewed')} onLesson={onLesson}/>
      const concept = diagnostic.concepts[0]
      const topic = diagnostic.packTopic
      const reading = activeReader?.diagnostic === diagnostic
      return <LensDiagnostic key={key} diagnostic={diagnostic} selected={selected === diagnostic || reading} sourceCurrent={sourceCurrent}
        onReveal={onRevealDiagnostic && canRevealDiagnostic?.(diagnostic) ? () => onRevealDiagnostic(diagnostic) : undefined}
        onExplain={() => {
          if (reading) closeExplanation()
          else if (concept) void readConcept(diagnostic, concept, 'viewed')
        }}
        onLesson={topic ? () => onLesson(topic) : undefined}>
        {reading ? explanation : null}
      </LensDiagnostic>
    }) : !feedback?.resolved.length && (
      <p className="learning-copy">{feedback
        ? 'This run did not produce a compiler or runtime diagnostic for this file.'
        : 'Run a saved ' + pack.name + ' file in Learn mode to see explanations for compiler or runtime diagnostics.'}</p>
    )}
    {results.length > 8 && <p className="learning-copy">See {lens ? 'Problems' : 'Run Console'} for more messages from this run.</p>}
  </div>
}

function DiagnosticHistory({ bridge, feedback, lens }: { bridge: LearningBridge; feedback?: LearningFeedback; lens: boolean }) {
  const [history, setHistory] = useState<LearningHistory | null>(null)
  const [titles, setTitles] = useState(() => new Map<ConceptId, string>())
  const [error, setError] = useState<string | null>(null)
  const [clearPending, setClearPending] = useState(false)
  const [clearing, setClearing] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    let active = true
    void bridge.getHistory().then((data) => {
      if (active) setHistory(data)
    }, (reason: unknown) => {
      if (active) setError(errorMessage(reason))
    })
    return () => { active = false }
  }, [bridge, feedback])
  useEffect(() => {
    let active = true
    void bridge.getTopics().then((topics) => {
      if (active) setTitles(new Map(topics.map(({ id, title }) => [id, title])))
    }).catch(() => {})
    return () => { active = false }
  }, [bridge])

  async function clearHistory() {
    setClearing(true)
    setError(null)
    try {
      await bridge.clearHistory()
      if (!mounted.current) return
      setHistory({ categories: [], topics: [] })
      setClearPending(false)
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      if (mounted.current) setClearing(false)
    }
  }

  return <>
    {error && <p className="learning-error" role="alert">{error}</p>}
    {history ? (
      <div className={lens ? 'learning-history lens-history' : 'learning-history'} data-testid="learning-history-content">
        {lens && <header className="lens-heading">
          <Icon name="clock" size={17}/>
          <div><h3>Learning history</h3><p>Saved on this device from compiler and run results.</p></div>
        </header>}
        <h3>{lens ? 'Encountered concepts and diagnostics' : 'Diagnostic history'}</h3>
        {history.categories.length ? <ul>{history.categories.map(({ category, encountered, repeated, resolved }) => {
          const concept = diagnosticConcepts[category]?.[0]
          return <li key={category}>
            <strong>{diagnosticTitles[category]}</strong>
            {lens && concept && titles.has(concept) && <span>{titles.get(concept)}</span>}
            <span className={lens ? 'lens-history-counts' : undefined}>
              {encountered} encountered · {repeated} repeated{!lens && ' · ' + resolved + ' resolved'}
              {lens && resolved > 0 && <span className="lens-history-resolved"><Icon name="check" size={11}/>{resolved} resolved</span>}
            </span>
          </li>
        })}</ul> : <p className="learning-copy">No diagnostic history yet.</p>}
        {lens && history.categories.some(({ resolved }) => resolved > 0) && (
          <p className="learning-copy lens-history-note">A resolved count means the diagnostic was absent from a later verified result.</p>
        )}
        <h3>{lens ? 'Explanations opened' : 'Diagnostic topics viewed'}</h3>
        {history.topics.length ? <ul>{history.topics.map(({ id, viewed, selected }) => (
          <li key={id}><strong>{titles.get(id) ?? id}</strong>
            <span>{viewed} views · {selected} selected from topics</span></li>
        ))}</ul> : <p className="learning-copy">No diagnostic topics viewed yet.</p>}
      </div>
    ) : !error && <p className="learning-copy" role="status">Opening history…</p>}
    <div className="learning-clear">
      {clearPending ? (
        <>
          <p className="learning-copy">Clear all saved diagnostic and topic history?</p>
          <button type="button" className="button" disabled={clearing} onClick={() => setClearPending(false)}>Cancel</button>
          <button type="button" className="button" data-testid="learning-confirm-clear" disabled={clearing}
            onClick={() => void clearHistory()}>Clear History</button>
        </>
      ) : <button type="button" className="button" data-testid="learning-clear-history" onClick={() => setClearPending(true)}>Clear Learning History</button>}
    </div>
  </>
}

function LearningNav({ view = 'topics', diagnostics = false, lens = false, hasFeedback = false, onSelect }: {
  view?: View
  diagnostics?: boolean
  lens?: boolean
  hasFeedback?: boolean
  onSelect?(view: View): void
}) {
  const items = [
    { id: 'topics', label: 'Topics' },
    { id: 'result', label: lens ? 'Learning Lens' : 'Latest run' },
    { id: 'history', label: 'History' },
  ] as const
  return <nav className="learning-nav" aria-label="Learning panel">
    {(diagnostics ? items : items.slice(0, 1)).map(({ id, label }) => (
      <button type="button" key={id} className="learning-nav-item" aria-pressed={view === id}
        aria-description={id === 'result' && hasFeedback ? 'Compiler feedback available' : undefined}
        data-testid={'learning-' + id} onClick={() => onSelect?.(id)}>{label}
        {id === 'result' && hasFeedback && view !== id && <span className="learning-feedback-dot" aria-hidden="true"/>}
      </button>
    ))}
  </nav>
}

function LanguageContent({ bridge, feedback, packs, pack, lensEnabled, lensSelection, sourceCurrent, canRevealDiagnostic, onRevealDiagnostic, onExercise }: {
  bridge: LearningBridge
  feedback?: LearningFeedback
  packs: LearningPacksBridge
  pack: PackSummary
  lensEnabled: boolean
  lensSelection?: LearningLensSelection
  sourceCurrent: boolean
  canRevealDiagnostic?: Props['canRevealDiagnostic']
  onRevealDiagnostic?: Props['onRevealDiagnostic']
  onExercise: Props['onExercise']
}) {
  const [view, setView] = useState<View>('topics')
  const [topicId, setTopicId] = useState<string | null>(null)
  const seenFeedback = useRef(feedback)
  const openedSelection = useRef<number | undefined>(undefined)
  const scroll = useRef<HTMLDivElement>(null)
  const lens = pack.id === 'c'
  const diagnostics = Boolean(pack.diagnostics) && (!lens || lensEnabled)
  const shownView = diagnostics ? view : 'topics'
  const selected = lens && diagnostics && lensSelection && feedback?.diagnostics.includes(lensSelection.diagnostic)
    ? lensSelection : undefined
  const hasFeedback = Boolean(feedback?.diagnostics.length || feedback?.resolved.length)

  useEffect(() => {
    if (!diagnostics || !feedback || seenFeedback.current === feedback) return
    seenFeedback.current = feedback
    if (view === 'topics' && !topicId && hasFeedback) setView('result')
  }, [diagnostics, feedback, hasFeedback, topicId, view])
  useEffect(() => {
    if (!selected) return
    setView('result')
    scroll.current?.scrollTo(0, 0)
  }, [selected])
  useEffect(() => { scroll.current?.scrollTo(0, 0) }, [shownView])

  return <>
    <LearningNav view={shownView} diagnostics={diagnostics} lens={lens} hasFeedback={hasFeedback} onSelect={(next) => {
      if (next === 'topics') setTopicId(null)
      setView(next)
    }}/>
    <div ref={scroll} className="learning-scroll">
      {shownView === 'topics' ? <PackTopics packs={packs} pack={pack} topicId={topicId} onTopic={setTopicId} onExercise={onExercise}/>
        : shownView === 'result' ? <DiagnosticResults bridge={bridge} feedback={feedback} pack={pack} lensSelection={selected}
          openedSelection={openedSelection} sourceCurrent={sourceCurrent} canRevealDiagnostic={canRevealDiagnostic}
          onRevealDiagnostic={onRevealDiagnostic} onLesson={(id) => {
          setTopicId(id)
          setView('topics')
        }}/>
          : <DiagnosticHistory bridge={bridge} feedback={feedback} lens={lens}/>}
    </div>
  </>
}

export function LearningPane({ bridge, feedback, packs, library, includeCatalog, loadError, lensEnabled, lensSelection, sourceCurrent = true,
  canRevealDiagnostic, onRevealDiagnostic, onRetry, onLibraryChange, onMarketplace, onClose, onExercise }: Props) {
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = library?.installed.find(({ id }) => id === library.selected)
  const installed = library?.installed ?? []

  async function selectLanguage(id: string) {
    setError(null)
    setChanging(true)
    try {
      onLibraryChange(await packs.select(id || null, includeCatalog))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setChanging(false)
    }
  }

  return (
    <aside className="learning-pane" aria-label="Learn" data-testid="learning-pane">
      <header className="pane-title">
        <h2><Icon name="book" size={14}/> Learn</h2>
        <button type="button" className="icon-button" aria-label="Hide learning panel" onClick={onClose}><Icon name="x" size={15}/></button>
      </header>
      {library && installed.length > 0 && <div className="learning-language-row">
        <label className="learning-language">
          <span>Language</span>
          <select data-testid="learning-language" value={selected?.id ?? ''} disabled={changing}
            onChange={(event) => void selectLanguage(event.currentTarget.value)}>
            <option value="">Choose an installed language</option>
            {installed.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <button type="button" className="icon-button" title="Open Marketplace" aria-label="Open Marketplace"
          data-testid="learning-open-marketplace" onClick={onMarketplace}><Icon name="marketplace" size={16}/></button>
      </div>}
      {error && <p className="learning-error learning-language-error" role="alert">{error}</p>}
      {selected ? <LanguageContent key={selected.id + ':' + selected.version} pack={selected} packs={packs}
        bridge={bridge} feedback={selected.id === feedback?.language ? feedback : undefined} lensEnabled={lensEnabled}
        lensSelection={lensSelection} sourceCurrent={sourceCurrent} canRevealDiagnostic={canRevealDiagnostic}
        onRevealDiagnostic={onRevealDiagnostic} onExercise={onExercise}/>
        : <>
          <LearningNav/>
          <div className="learning-scroll">
            {!library ? (loadError
              ? <><p className="learning-error" role="alert">{loadError}</p>
                {onRetry && <button type="button" className="button" onClick={onRetry}>Retry</button>}</>
              : <p className="learning-copy" role="status">Opening learning packs…</p>)
              : <section className="learning-empty">
                <div className="learning-empty-icon"><Icon name="book" size={20}/></div>
                <h3>{installed.length ? 'Choose what to learn' : 'Start with a language pack'}</h3>
                <p className="learning-copy">{installed.length ? 'Pick an installed language above to see its topics.'
                  : 'Install a pack from Marketplace to get syntax guides, code examples, key APIs, and practice exercises.'}</p>
                {!installed.length && <button type="button" className="button" data-testid="learning-open-marketplace"
                  onClick={onMarketplace}><Icon name="marketplace" size={15}/> Open Marketplace</button>}
              </section>}
          </div>
        </>}
    </aside>
  )
}
