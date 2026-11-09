import { useEffect, useRef, useState } from 'react'
import {
  diagnosticTitles, type ConceptId, type LearningBridge, type LearningConcept, type LearningDiagnostic,
  type LearningFeedback, type LearningHistory,
} from '../../shared/learning'
import type { LearningPacksBridge, PackLesson, PackLibrary, PackSummary, PackTopic } from '../../shared/learning-packs'
import { errorMessage } from '../documents'
import { Icon } from '../icons'
import './learning.css'

interface Props {
  bridge: LearningBridge
  feedback?: LearningFeedback
  packs: LearningPacksBridge
  library: PackLibrary | null
  loadError?: string
  onRetry?(): void
  onLibraryChange(library: PackLibrary): void
  onMarketplace(): void
  onClose(): void
}

type View = 'result' | 'topics' | 'history'
type Load<T> = { value: T } | { error: string }

function locationLabel(location: LearningDiagnostic['location']): string {
  if (!location) return ''
  const name = location.file.split(/[/\\]/).at(-1) ?? location.file
  return name + ':' + location.line + (location.column ? ':' + location.column : '')
}

function Description({ diagnostic, encourage, onExplain }: {
  diagnostic: LearningDiagnostic
  encourage: boolean
  onExplain(id: ConceptId): void
}) {
  const concept = diagnostic.concepts[0]
  const title = diagnosticTitles[diagnostic.category]
  return (
    <section className="learning-diagnostic" data-testid="learning-diagnostic" data-category={diagnostic.category}>
      <h3>{title}</h3>
      <p className="learning-meta">
        {diagnostic.compiler === 'unknown' ? 'C' : diagnostic.compiler === 'clang' ? 'Clang' : 'GCC'}
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
      {concept && (
        <>
          {encourage && (
            <p className="learning-encouragement" data-testid="learning-encouragement">Keep going, you've got this. Want to revisit the concept?</p>
          )}
          <button className="button" data-testid="learning-show-explanation" onClick={() => onExplain(concept)}>
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
      <pre>{concept.example}</pre>
      <p>{concept.exampleExplanation}</p>
      <h4>Common misconceptions</h4>
      <ul>{concept.misconceptions.map((item) => <li key={item}>{item}</li>)}</ul>
      <details className="learning-reference">
        <summary>{concept.reference.title}</summary>
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

function PackLessonReader({ packs, packId, topicId, onBack }: {
  packs: LearningPacksBridge
  packId: string
  topicId: string
  onBack(): void
}) {
  const [lesson, setLesson] = useState<Load<PackLesson> | null>(null)
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => { back.current?.focus() }, [])
  useEffect(() => {
    let active = true
    void packs.getLesson(packId, topicId).then(
      (value) => { if (active) setLesson({ value }) },
      (reason: unknown) => { if (active) setLesson({ error: errorMessage(reason) }) },
    )
    return () => { active = false }
  }, [packId, packs, topicId])
  return (
    <>
      <button ref={back} type="button" className="button learning-back" onClick={onBack}>Back to topics</button>
      {!lesson ? <p className="learning-copy" role="status">Opening lesson…</p>
        : 'error' in lesson ? <p className="learning-error" role="alert">{lesson.error}</p>
          : <article className="learning-concept learning-pack-lesson" data-testid="learning-pack-lesson" data-topic={lesson.value.id}>
            <p className="learning-kicker">{lesson.value.section}</p>
            <h3>{lesson.value.title}</h3>
            <p>{lesson.value.explanation}</p>
            <h4>Example</h4>
            <pre><code>{lesson.value.example}</code></pre>
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
            </div>
          </article>}
    </>
  )
}

function PackTopics({ packs, pack, topicId, onTopic }: {
  packs: LearningPacksBridge
  pack: PackSummary
  topicId: string | null
  onTopic(id: string | null): void
}) {
  const [topics, setTopics] = useState<Load<PackTopic[]> | null>(null)
  const index = useRef<HTMLDivElement>(null)
  const previousTopic = useRef<string>(null)
  useEffect(() => {
    let active = true
    void packs.getTopics(pack.id).then(
      (value) => { if (active) setTopics({ value }) },
      (reason: unknown) => { if (active) setTopics({ error: errorMessage(reason) }) },
    )
    return () => { active = false }
  }, [pack.id, packs])
  useEffect(() => {
    if (topicId || !previousTopic.current) return
    index.current?.querySelector<HTMLButtonElement>(`[data-topic="${CSS.escape(previousTopic.current)}"]`)?.focus()
    previousTopic.current = null
  }, [topicId])
  if (topicId) return <PackLessonReader key={topicId} packs={packs} packId={pack.id} topicId={topicId} onBack={() => onTopic(null)}/>
  if (!topics) return <p className="learning-copy" role="status">Opening topics…</p>
  if ('error' in topics) return <p className="learning-error" role="alert">{topics.error}</p>

  const sections = new Map<string, PackTopic[]>()
  for (const topic of topics.value) {
    const group = sections.get(topic.section)
    if (group) group.push(topic)
    else sections.set(topic.section, [topic])
  }
  return (
    <div ref={index}>
      <div className="learning-pack-intro">
        <h3>{pack.name}</h3>
        <span>{topics.value.length} {topics.value.length === 1 ? 'topic' : 'topics'} · Available offline</span>
      </div>
      {[...sections].map(([section, items]) => <section className="learning-topic-section" key={section}>
        <h4>{section}</h4>
        <ul className="learning-topic-list">{items.map(({ id, title }) => (
          <li key={id}><button type="button" className="button learning-topic-button" data-testid="learning-topic" data-topic={id}
            onClick={() => { previousTopic.current = id; onTopic(id) }}><span>{title}</span><Icon name="chevron" size={13}/></button></li>
        ))}</ul>
      </section>)}
    </div>
  )
}

function DiagnosticResults({ bridge, feedback }: { bridge: LearningBridge; feedback?: LearningFeedback }) {
  const [reader, setReader] = useState<{ feedback: LearningFeedback | undefined; result: Load<LearningConcept> | null } | null>(null)
  const [titles, setTitles] = useState(() => new Map<ConceptId, string>())
  const [historyError, setHistoryError] = useState<string | null>(null)
  const request = useRef(0)
  useEffect(() => () => { request.current += 1 }, [])
  const activeReader = reader?.feedback === feedback ? reader : null

  async function readConcept(id: ConceptId, action: 'viewed' | 'selected') {
    const token = ++request.current
    setHistoryError(null)
    setReader({ feedback, result: null })
    try {
      const concept = await bridge.getConcept(id)
      if (request.current !== token) return
      setReader({ feedback, result: { value: concept } })
    } catch (reason) {
      if (request.current === token) setReader({ feedback, result: { error: errorMessage(reason) } })
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
  }

  if (activeReader) return <>
    <button type="button" className="button learning-back" onClick={() => { request.current += 1; setReader(null); setHistoryError(null) }}>Back to latest run</button>
    {historyError && <p className="learning-error" role="alert">{historyError}</p>}
    {!activeReader.result ? <p className="learning-copy" role="status">Opening explanation…</p>
      : 'error' in activeReader.result ? <p className="learning-error" role="alert">{activeReader.result.error}</p>
        : <Concept concept={activeReader.result.value} titles={titles} onRead={(id) => void readConcept(id, 'selected')}/>}
  </>

  const diagnostics = feedback?.diagnostics.filter(({ severity }) => severity !== 'note') ?? []
  const firstErrors = diagnostics.filter(({ severity }) => severity === 'error' || severity === 'fatal error')
  const results = firstErrors.length > 0 ? firstErrors : diagnostics
  const encourageIndex = results.findIndex(({ occurrence, concepts }) => occurrence === 'repeated' && concepts.length > 0)
  return <>
    {feedback?.historyUnavailable && <p className="learning-error" role="status">Local history is unavailable. You can still open explanations for this run.</p>}
    {feedback?.resolved.length ? (
      <div className="learning-resolved" data-testid="learning-resolved" role="status">
        <strong>{feedback.resolved.length === 1 ? 'Diagnostic resolved in this run' : 'Diagnostics resolved in this run'}</strong>
        <ul>{feedback.resolved.map((category) => <li key={category}>{diagnosticTitles[category]}</li>)}</ul>
      </div>
    ) : null}
    {results.length ? results.slice(0, 8).map((diagnostic, index) => (
      <Description key={diagnostic.category + index} diagnostic={diagnostic} encourage={index === encourageIndex}
        onExplain={(id) => void readConcept(id, 'viewed')}/>
    )) : (
      <p className="learning-copy">{feedback
        ? 'This run did not produce a compiler or runtime diagnostic for this file.'
        : 'Run a saved C file in Learn mode to see explanations for compiler or runtime diagnostics.'}</p>
    )}
    {results.length > 8 && <p className="learning-copy">See Output for the complete compiler messages.</p>}
  </>
}

function DiagnosticHistory({ bridge, feedback }: { bridge: LearningBridge; feedback?: LearningFeedback }) {
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
      <div className="learning-history" data-testid="learning-history-content">
        <h3>Diagnostic history</h3>
        {history.categories.length ? <ul>{history.categories.map(({ category, encountered, repeated, resolved }) => (
          <li key={category}><strong>{diagnosticTitles[category]}</strong>
            <span>{encountered} encounters · {repeated} repeats · {resolved} resolved</span></li>
        ))}</ul> : <p className="learning-copy">No diagnostic history yet.</p>}
        <h3>Diagnostic topics viewed</h3>
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

function LearningNav({ view = 'topics', diagnostics = false, hasFeedback = false, onSelect }: {
  view?: View
  diagnostics?: boolean
  hasFeedback?: boolean
  onSelect?(view: View): void
}) {
  const items = [
    { id: 'topics', label: 'Topics' },
    { id: 'result', label: 'Latest run' },
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

function LanguageContent({ bridge, feedback, packs, pack }: {
  bridge: LearningBridge
  feedback?: LearningFeedback
  packs: LearningPacksBridge
  pack: PackSummary
}) {
  const [view, setView] = useState<View>('topics')
  const [topicId, setTopicId] = useState<string | null>(null)
  const seenFeedback = useRef(feedback)
  const scroll = useRef<HTMLDivElement>(null)
  const c = pack.id === 'c'
  const hasFeedback = Boolean(feedback?.diagnostics.length || feedback?.resolved.length)

  useEffect(() => {
    if (!c || !feedback || seenFeedback.current === feedback) return
    seenFeedback.current = feedback
    if (view === 'topics' && !topicId && hasFeedback) setView('result')
  }, [c, feedback, hasFeedback, topicId, view])
  useEffect(() => { scroll.current?.scrollTo(0, 0) }, [view])

  return <>
    <LearningNav view={view} diagnostics={c} hasFeedback={hasFeedback} onSelect={(next) => {
      if (next === 'topics') setTopicId(null)
      setView(next)
    }}/>
    <div ref={scroll} className="learning-scroll">
      {view === 'topics' ? <PackTopics packs={packs} pack={pack} topicId={topicId} onTopic={setTopicId}/>
        : view === 'result' ? <DiagnosticResults bridge={bridge} feedback={feedback}/>
          : <DiagnosticHistory bridge={bridge} feedback={feedback}/>}
    </div>
  </>
}

export function LearningPane({ bridge, feedback, packs, library, loadError, onRetry, onLibraryChange, onMarketplace, onClose }: Props) {
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = library?.installed.find(({ id }) => id === library.selected)
  const installed = library?.installed ?? []

  async function selectLanguage(id: string) {
    setError(null)
    setChanging(true)
    try {
      onLibraryChange(await packs.select(id || null))
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
        bridge={bridge} feedback={selected.id === 'c' ? feedback : undefined}/>
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
