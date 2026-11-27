import { useEffect, useRef, useState } from 'react'
import type { ExplanationAction, ExplanationBridge, ExplanationCitation, ExplanationOpenResult, ExplanationReply,
  ExplanationRequest, ExplanationReview } from '../../shared/explanations'
import type { ProviderSettings, ProviderUpdate } from '../../shared/projects'
import { Modal } from '../Dialogs'
import { Icon } from '../icons'
import { ProviderConfiguration } from './ProviderConfiguration'
import './explanations.css'

export interface ExplanationDialogProps {
  initialRequest: ExplanationRequest
  bridge: ExplanationBridge
  onClose(): void
  onOpenCitation(result: ExplanationOpenResult): void
  subscribeInvalidation?(callback: () => void): () => void
  refreshContext?(request: ExplanationRequest): Promise<ExplanationRequest>
  onRecommendations?(reply: ExplanationReply, review: ExplanationReview): void
}
export interface ExplanationSelection {
  lesson: boolean; code: boolean; diagnostic: boolean; structure: boolean; refs: number[]
}
const tutorActions: Array<[ExplanationAction, string]> = [['hint', 'Hint'], ['concept', 'Explain a concept'], ['debug', 'Understand an error'],
  ['walkthrough', 'Walk through code'], ['review-attempt', 'Review my attempt'], ['quiz', 'Ask me a question'],
  ['complexity', 'Analyze time and space complexity'], ['explain-file', 'Explain this file'], ['explain-selection', 'Explain selected code'], ['find-bug', 'Find a likely bug'],
  ['design-tests', 'Design test cases']]
const codeActions = new Set<ExplanationAction>(['complexity', 'explain-file', 'explain-selection', 'find-bug', 'design-tests'])
const projectActions: Array<[ExplanationAction, string]> = [['understand', 'Understand this project'], ['architecture', 'Explain architecture'],
  ['health', 'Review project health'], ['teach-project', 'Teach through this project'], ['next-steps', 'Suggest next steps'], ['ask-codebase', 'Ask about the codebase']]

/** Only explicitly selected context crosses the review boundary. */
export function selectedExplanationRequest(request: ExplanationRequest, selection: ExplanationSelection,
  action: ExplanationAction, question: string, stream = false): ExplanationRequest {
  return { purpose: request.purpose, action, question, ...(stream && { stream: true }),
    ...(selection.lesson && request.lesson ? { lesson: request.lesson } : {}),
    ...(selection.code && request.code ? { code: request.code } : {}),
    ...(selection.diagnostic && request.diagnostic ? { diagnostic: request.diagnostic } : {}),
    ...(selection.structure && request.project ? { project: { root: request.project.root,
      refs: [...new Set(selection.refs)].filter(index => Number.isInteger(index) && index >= 0 && index < request.project!.refs.length)
        .slice(0, 4).map(index => request.project!.refs[index]) } } : {}),
  }
}

export function ExplanationDialog({ initialRequest, bridge, onClose, onOpenCitation, subscribeInvalidation,
  refreshContext, onRecommendations }: ExplanationDialogProps) {
  const purpose = initialRequest.purpose
  const ask = purpose === 'ask'
  const [provider, setProvider] = useState<ProviderSettings | null>(null)
  const [action, setAction] = useState(initialRequest.action)
  const [question, setQuestion] = useState(initialRequest.question)
  const [stream, setStream] = useState(false)
  const [selection, setSelection] = useState<ExplanationSelection>({ lesson: false, code: false, diagnostic: false, structure: false, refs: [] })
  const [review, setReview] = useState<ExplanationReview | null>(null)
  const [reply, setReply] = useState<ExplanationReply | null>(null)
  const [replyReview, setReplyReview] = useState<ExplanationReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const mounted = useRef(false), generation = useRef(0), pending = useRef(false)
  const operation = useRef<Promise<void> | null>(null), stopping = useRef<Promise<void> | null>(null)
  const current = useRef({ review: false, reply: false })
  current.current = { review: !!review, reply: !!reply }
  function start(task: () => Promise<void>) {
    if (pending.current) return
    const owned = task()
    operation.current = owned
    void owned.finally(() => { if (operation.current === owned) operation.current = null }).catch(() => {})
  }
  function cancel(message = 'Request cancelled. Review again before sending.') {
    setStream(false); setReview(null); setReply(null); setReplyReview(null); setFeedback(message)
    if (stopping.current) return
    const epoch = ++generation.current
    pending.current = true; setBusy(true)
    const stopped = Promise.allSettled([operation.current ?? Promise.resolve(), bridge.cancel()]).then(() => {
      if (stopping.current === stopped) stopping.current = null
      if (mounted.current && generation.current === epoch) { pending.current = false; setBusy(false) }
    })
    stopping.current = stopped
  }
  useEffect(() => {
    mounted.current = true
    const epoch = ++generation.current
    void bridge.provider(purpose).then(value => {
      if (mounted.current && generation.current === epoch) setProvider(value)
    }, () => { if (mounted.current && generation.current === epoch) setFeedback('Provider settings are unavailable. Offline features remain available.') })
    const unsubscribe = subscribeInvalidation?.(() => {
      if (mounted.current) cancel('Context changed. The previous review and answer were cleared. Review the current context again.')
    })
    return () => { mounted.current = false; generation.current++; pending.current = false; unsubscribe?.(); void bridge.cancel().catch(() => {}) }
  }, [bridge, purpose, subscribeInvalidation])
  function changed() {
    if (pending.current || current.current.review || current.current.reply) cancel('Request changed. Review again before sending.')
    else setFeedback('')
  }
  async function configureProvider(update: ProviderUpdate): Promise<ProviderSettings> {
    if (pending.current) throw new Error('Wait for the current request to finish.')
    const epoch = ++generation.current
    pending.current = true; setBusy(true); setReview(null); setReply(null); setReplyReview(null); setFeedback('Saving local provider settings…')
    const result = bridge.configure(update)
    const owned = result.then(() => {}, () => {})
    operation.current = owned
    try { return await result }
    finally {
      if (operation.current === owned) operation.current = null
      if (mounted.current && generation.current === epoch) { pending.current = false; setBusy(false) }
    }
  }
  async function reviewRequest() {
    if (pending.current || !question.trim() || new TextEncoder().encode(question).byteLength > 2048) return
    const epoch = ++generation.current
    pending.current = true; setBusy(true); setReview(null); setReply(null); setReplyReview(null); setFeedback('Preparing a local review…')
    const alive = () => mounted.current && generation.current === epoch
    try {
      const settings = await bridge.provider(purpose)
      if (!alive()) return
      setProvider(settings)
      if (!settings.hasKey || !settings.model) { setFeedback('Configure a provider and API key before sending an optional online request.'); return }
      const selected = selectedExplanationRequest(initialRequest, selection, action, question, stream)
      if (codeActions.has(action) && (!selection.code || !selected.code?.text.trim())) {
        setFeedback('Select a nonempty code excerpt before reviewing this action.')
        return
      }
      const request = refreshContext ? await refreshContext(selected) : selected
      if (!alive()) return
      const prepared = await bridge.review(request)
      if (alive()) { setReview(prepared); setFeedback('Nothing has been sent. Check every included excerpt, then choose Send.') }
    } catch { if (alive()) setFeedback('Could not prepare this review. Context may have changed; review again or close and reopen.') }
    finally { if (alive()) { pending.current = false; setBusy(false) } }
  }
  async function send() {
    if (pending.current || !review) return
    const epoch = ++generation.current, token = review.token
    pending.current = true; setBusy(true); setFeedback('Waiting for your configured provider…')
    try {
      const result = await bridge.send(token)
      if (!mounted.current || generation.current !== epoch) return
      setReplyReview(result ? review : null); setReview(null); setReply(result)
      setFeedback(result ? 'AI explanation received. Verify it against your source and offline lessons.' : 'Sending was declined. Nothing was sent.')
    } catch {
      if (mounted.current && generation.current === epoch) { setReview(null); setReplyReview(null); setFeedback('The request failed or its context changed. Your files were not modified. Review again to retry.') }
    } finally { if (mounted.current && generation.current === epoch) { pending.current = false; setBusy(false); setStream(false) } }
  }
  async function openCitation(citation: ExplanationCitation) {
    if (!reply || pending.current) return
    const epoch = ++generation.current
    pending.current = true; setBusy(true)
    try {
      const result = await bridge.openCitation(reply.token, citation.sourceId, { startLine: citation.startLine, endLine: citation.endLine })
      if (mounted.current && generation.current === epoch) onOpenCitation(result)
    } catch { if (mounted.current && generation.current === epoch) setFeedback('This citation is no longer available. Review the current context again.') }
    finally { if (mounted.current && generation.current === epoch) { pending.current = false; setBusy(false) } }
  }
  const actions = purpose === 'tutor' ? tutorActions : projectActions
  const questionBytes = new TextEncoder().encode(question).byteLength
  function check(field: 'lesson' | 'code' | 'diagnostic' | 'structure', value: boolean) {
    changed(); setSelection(previous => ({ ...previous, [field]: value, ...(field === 'structure' && !value ? { refs: [] } : {}) }))
  }
  return <Modal title={ask ? 'Ask Ion' : purpose === 'tutor' ? 'Optional online tutor' : 'Explain this project online'} className="explanation-dialog" onClose={onClose}>
    <div className="explanation-body" data-testid="explanation-dialog">
      <p className="explanation-note">Choose what to share. Ion prepares an exact local review before any online request. AI responses are unverified and cannot change or run your code.</p>
      {!ask && <label>Action<select value={action} disabled={busy} onChange={event => { changed(); setAction(event.target.value as ExplanationAction) }}>
        {actions.map(([value, label]) => <option key={value} value={value}
          disabled={codeActions.has(value) && !initialRequest.code?.text.trim()}>{label}</option>)}</select></label>}
      <label>Your question<textarea rows={3} maxLength={2048} value={question} disabled={busy} aria-describedby="explanation-question-limit"
        onChange={event => { changed(); setQuestion(event.target.value) }}/></label>
      <p id="explanation-question-limit" className="explanation-note">{questionBytes}/2,048 UTF-8 bytes{questionBytes > 2048 ? ' · Shorten your question before reviewing.' : ''}</p>
      <fieldset disabled={busy} className="explanation-inclusions"><legend>Include only what you select</legend>
        {initialRequest.lesson && <label><input type="checkbox" checked={selection.lesson} onChange={event => check('lesson', event.target.checked)}/>Installed lesson: {initialRequest.lesson.lessonId}</label>}
        {initialRequest.code && <label><input type="checkbox" checked={selection.code} onChange={event => check('code', event.target.checked)}/>
          {ask ? 'Editor excerpt: ' : 'Current unsaved code: '}{initialRequest.code.label}{ask ? ' (first 8 KiB)' : ' (off by default)'}</label>}
        {codeActions.has(action) && <p className="explanation-note">This action requires the selected code excerpt. Nothing is sent until you review the exact request and approve Send.</p>}
        {initialRequest.diagnostic && <label><input type="checkbox" checked={selection.diagnostic} onChange={event => check('diagnostic', event.target.checked)}/>Compiler diagnostic</label>}
        {initialRequest.project && <>
          <label><input type="checkbox" checked={selection.structure} onChange={event => check('structure', event.target.checked)}/>Bounded offline project structure</label>
          <p className="explanation-note">Optionally select up to four inspected references. Only excerpts shown in the review will be sent.</p>
          {initialRequest.project.refs.slice(0, 500).map((reference, index) => <label key={index}>
            <input type="checkbox" checked={selection.refs.includes(index)} disabled={!selection.structure || !selection.refs.includes(index) && selection.refs.length >= 4}
              onChange={event => { changed(); const checked = event.target.checked; setSelection(previous => ({ ...previous,
                refs: checked ? [...previous.refs, index].slice(0, 4) : previous.refs.filter(value => value !== index) })) }}/>{reference.path}
          </label>)}
        </>}
        {!initialRequest.lesson && !initialRequest.code && !initialRequest.diagnostic && !initialRequest.project && <p>Only your question will be included.</p>}
      </fieldset>
      <fieldset disabled={busy} className="explanation-inclusions"><legend>Provider response</legend>
        <label><input type="checkbox" checked={stream} aria-describedby="explanation-stream-help"
          onChange={event => { changed(); setStream(event.target.checked) }}/>Stream provider response</label>
        <p id="explanation-stream-help" className="explanation-note">Ion shows the answer after validating the complete response and its citations.</p>
      </fieldset>
      <div className="explanation-actions"><button className="button" data-testid="explanation-review" onClick={() => start(reviewRequest)}
        disabled={busy || !question.trim() || questionBytes > 2048 || codeActions.has(action) && (!selection.code || !initialRequest.code?.text.trim())}><Icon name="eye"/>Review request</button>
        {busy && <button className="button" onClick={() => cancel()}>Cancel request</button>}</div>
      <p role="status" className="explanation-status">{feedback}</p>
      {review && <ExplanationReviewView review={review} disabled={busy} onSend={() => start(send)}/>}
      {reply && <ExplanationAnswer reply={reply} disabled={busy} onCitation={citation => start(() => openCitation(citation))}
        onRecommendations={onRecommendations && replyReview ? value => onRecommendations(value, replyReview) : undefined}/>}
      <details className="explanation-provider-details"><summary>Provider settings{provider && !provider.hasKey ? ' · API key required' : ''}</summary>
        {provider ? <ProviderConfiguration provider={provider} disabled={busy} onConfigure={configureProvider} onChange={settings => {
          cancel('Provider changed. Review again before sending.'); setProvider(settings)
        }}/> : <p>Loading local provider settings…</p>}
      </details>
    </div>
  </Modal>
}

export function ExplanationReviewView({ review, disabled, onSend }: { review: ExplanationReview; disabled: boolean; onSend(): void }) {
  return <section className="explanation-review" aria-label="Exact request review" data-testid="explanation-review-content">
    <h3>Review before sending</h3>
    <dl><dt>Provider</dt><dd>{review.provider.endpoint}</dd><dt>Model</dt><dd>{review.provider.model}</dd><dt>Request size</dt><dd>{review.bodyBytes.toLocaleString()} bytes</dd>
      <dt>Response mode</dt><dd>{review.stream ? 'Streaming' : 'Single response'}</dd></dl>
    <h4>Question</h4><p className="explanation-prewrap">{review.question}</p>
    {review.sources.map(source => <details key={source.id}><summary>{source.label} · {source.origin} · lines {source.startLine}–{source.endLine}</summary>
      <p className="explanation-note">Revision: {source.revision}</p><pre>{source.text}</pre></details>)}
    {review.exclusions.length > 0 && <><h4>Excluded or limited</h4><ul>{review.exclusions.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    <button className="button primary" data-testid="explanation-send" onClick={onSend} disabled={disabled}>Send reviewed request</button>
  </section>
}

export function ExplanationAnswer({ reply, disabled, onCitation, onRecommendations }: { reply: ExplanationReply; disabled: boolean;
  onCitation(citation: ExplanationCitation): void; onRecommendations?(reply: ExplanationReply): void }) {
  const labels = { observed: 'Observed · AI unverified', inferred: 'Inferred · AI unverified', unknown: 'Unknown', suggestion: 'Suggestion · AI unverified' }
  return <section className="explanation-answer" aria-label="Unverified AI explanation" data-testid="explanation-answer">
    <h3>AI explanation · verify before relying on it</h3><p className="explanation-prewrap">{reply.summary}</p>
    {reply.sections.map((section, index) => <section key={index} className="explanation-answer-section">
      <span className="explanation-kind">{labels[section.kind]}</span><h4>{section.title}</h4><p className="explanation-prewrap">{section.text}</p>
      <div className="explanation-actions">{section.citations.map((citation, number) => <button key={number} className="button" disabled={disabled}
        onClick={() => onCitation(citation)}>Source {citation.sourceId} · {citation.startLine}–{citation.endLine}</button>)}</div>
    </section>)}
    {reply.questions.length > 0 && <><h4>Questions to consider</h4><ul>{reply.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></>}
    {reply.recommendations.length > 0 && <><h4>Suggested next steps · unverified</h4><ul>{reply.recommendations.map(item => <li key={item.id}><strong>{item.title}</strong><p>{item.description}</p></li>)}</ul>
      <button className="button" disabled={disabled || !onRecommendations} onClick={() => onRecommendations?.(reply)}
        title={onRecommendations ? 'Review suggested milestones' : 'Milestone review is not available here'}>Review suggested milestones</button></>}
  </section>
}
