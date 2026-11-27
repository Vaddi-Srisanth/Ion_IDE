import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../../shared/contracts'
import type { LearningActivity, LearningBridge, LearningTaskEvidence } from '../../shared/learning'
import { diagnosticPackIds, type LearningPacksBridge, type PackLesson } from '../../shared/learning-packs'
import type { PracticeBridge, PracticeProblem } from '../../shared/practice'
import { errorMessage } from '../documents'
import { PracticeResults } from '../practice/PracticeResults'

export interface PracticalExerciseProps {
  packId: string
  topicId: string
  lesson: PackLesson
  learning: LearningBridge
  packs: LearningPacksBridge
  practice: PracticeBridge
  onExercise(result: Awaited<ReturnType<LearningPacksBridge['startExercise']>>, stayInLearn?: boolean): void
  onPrepareRun(path: string): Promise<boolean>
  onStopRun(): void
}

interface OpenedExercise {
  entry: Entry
  problem: PracticeProblem
  attemptId: string
}

type Operation = 'open' | 'run' | 'refresh'

export function PracticalExercise({ packId, topicId, lesson, learning, packs, practice,
  onExercise, onPrepareRun }: PracticalExerciseProps) {
  const [activity, setActivity] = useState<LearningActivity | null>()
  const [evidence, setEvidence] = useState<LearningTaskEvidence | null>()
  const [opened, setOpened] = useState<OpenedExercise>()
  const [revealed, setRevealed] = useState(0)
  const [hintPending, setHintPending] = useState(false)
  const [busy, setBusy] = useState<Operation | null>(null)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const mounted = useRef(false)
  const generation = useRef(0)
  const identity = packId + ':' + topicId
  const identityRef = useRef(identity)
  identityRef.current = identity
  const recordedOpen = useRef<string | undefined>(undefined)
  const activitySequence = useRef(0)
  const evidenceSequence = useRef(0)
  const busyRef = useRef<Operation | null>(null)
  const hintPendingRef = useRef(false)
  const revealedRef = useRef(0)
  const stoppingRef = useRef(false)
  const ownedSampleRun = useRef<{ cancellation?: Promise<void> } | null>(null)
  const practical = lesson.starter !== undefined && Boolean(lesson.objective)
  const runnable = diagnosticPackIds.some(id => id === packId)

  const current = (token: number) => mounted.current && generation.current === token && identityRef.current === identity

  function cancelOwnedSamples(): Promise<void> {
    const owned = ownedSampleRun.current
    if (!owned) return Promise.resolve()
    if (owned.cancellation) return owned.cancellation
    try {
      const cancellation = practice.cancelSamples()
      owned.cancellation = cancellation
      return cancellation.catch(reason => {
        if (owned.cancellation === cancellation) owned.cancellation = undefined
        throw reason
      })
    } catch (reason) {
      return Promise.reject(reason)
    }
  }

  useEffect(() => {
    mounted.current = true
    const token = ++generation.current
    setActivity(undefined)
    setEvidence(undefined)
    setOpened(undefined)
    setRevealed(0)
    revealedRef.current = 0
    busyRef.current = null
    hintPendingRef.current = false
    stoppingRef.current = false
    setBusy(null)
    setHintPending(false)
    setStopping(false)
    setError(undefined)
    setNotice(undefined)
    const load = async () => {
      const record = recordedOpen.current !== identity
      recordedOpen.current = identity
      const activityRequest = ++activitySequence.current
      const evidenceRequest = ++evidenceSequence.current
      const results = await Promise.allSettled([
        record ? learning.recordLearningActivity(packId, topicId, 'lesson-opened')
          : learning.getLearningActivity(packId, topicId),
        learning.getLearningTaskEvidence(packId, topicId),
      ])
      if (!current(token)) return
      if (activitySequence.current === activityRequest) setActivity(results[0].status === 'fulfilled' ? results[0].value : null)
      if (evidenceSequence.current === evidenceRequest) setEvidence(results[1].status === 'fulfilled' ? results[1].value : null)
      if (results.some(result => result.status === 'rejected')) {
        setError('Some local learning evidence could not be read or saved. Your code is unchanged.')
      }
    }
    void load().catch(reason => { if (current(token)) setError(errorMessage(reason)) })
    return () => {
      mounted.current = false
      ++generation.current
      // Only this component's in-flight sample invocation is owned here.
      // Preflight reads/saves never authorize stopping the separate Run Console.
      void cancelOwnedSamples().catch(() => undefined)
    }
  }, [identity, learning, packId, topicId])

  async function refreshEvidence(token: number) {
    const request = ++evidenceSequence.current
    const next = await learning.getLearningTaskEvidence(packId, topicId)
    if (current(token) && evidenceSequence.current === request) setEvidence(next)
  }

  async function revealHint() {
    if (busyRef.current || hintPendingRef.current || revealedRef.current >= (lesson.hints?.length ?? 0)) return
    const token = generation.current
    hintPendingRef.current = true
    const activityRequest = ++activitySequence.current
    setHintPending(true)
    revealedRef.current++
    setRevealed(revealedRef.current)
    setError(undefined)
    try {
      const next = await learning.recordLearningActivity(packId, topicId, 'hint-revealed')
      if (current(token) && activitySequence.current === activityRequest) setActivity(next)
    } catch (reason) {
      if (current(token)) setError('Hint shown; its local activity could not be saved. ' + errorMessage(reason))
    } finally {
      if (current(token)) { hintPendingRef.current = false; setHintPending(false) }
    }
  }

  async function openExercise() {
    if (busyRef.current || hintPendingRef.current || !lesson.exercise || !runnable) return
    const token = generation.current
    busyRef.current = 'open'
    setBusy('open')
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await packs.startExercise(packId, topicId)
      if (!current(token)) return
      if (!practical) { onExercise(result); return }
      const problem = await practice.get(result.problemId)
      if (!current(token)) return
      const attempt = problem.attempts.at(-1)
      if (!attempt) throw new Error('The saved exercise has no attempt to open.')
      const entry = await practice.openAttempt(problem.id, attempt.id)
      if (!current(token)) return
      if (entry.path !== result.entry.path) throw new Error('The saved exercise changed while opening. Open it again before running samples.')
      setOpened({ entry: result.entry, problem, attemptId: attempt.id })
      onExercise(result, true)
      if (!current(token)) return
      setNotice('Exercise opened beside this lesson. Write your own solution, then run its saved samples.')
      await refreshEvidence(token)
    } catch (reason) {
      if (current(token)) setError(errorMessage(reason))
    } finally {
      if (current(token)) { busyRef.current = null; setBusy(null) }
    }
  }

  async function runSamples() {
    if (busyRef.current || hintPendingRef.current || !opened || !opened.problem.samples.length) return
    const token = generation.current
    const selected = opened
    busyRef.current = 'run'
    stoppingRef.current = false
    setBusy('run')
    setStopping(false)
    setError(undefined)
    setNotice(undefined)
    try {
      const entry = await practice.openAttempt(selected.problem.id, selected.attemptId)
      if (!current(token) || stoppingRef.current) return
      if (entry.path !== selected.entry.path) throw new Error('The saved attempt changed. Open the exercise again before running samples.')
      if (!await onPrepareRun(selected.entry.path)) {
        if (current(token)) setNotice('Save your edits before running the samples.')
        return
      }
      if (!current(token) || stoppingRef.current) return
      const owned = {}
      ownedSampleRun.current = owned
      let tested: PracticeProblem
      try {
        tested = await practice.runSamples(selected.problem.id, selected.attemptId)
      } finally {
        if (ownedSampleRun.current === owned) ownedSampleRun.current = null
      }
      if (!current(token)) return
      setOpened({ ...selected, problem: tested })
      setNotice('Sample run finished. Results are saved locally.')
      await refreshEvidence(token)
    } catch (reason) {
      if (current(token)) setError(errorMessage(reason))
    } finally {
      if (current(token)) { busyRef.current = null; setBusy(null); stoppingRef.current = false; setStopping(false) }
    }
  }

  async function refresh() {
    if (busyRef.current || hintPendingRef.current) return
    const token = generation.current
    busyRef.current = 'refresh'
    setBusy('refresh')
    setError(undefined)
    const activityRequest = ++activitySequence.current
    const evidenceRequest = ++evidenceSequence.current
    try {
      const [nextActivity, nextEvidence, nextProblem] = await Promise.all([
        learning.getLearningActivity(packId, topicId), learning.getLearningTaskEvidence(packId, topicId),
        opened ? practice.get(opened.problem.id) : undefined,
      ])
      if (!current(token)) return
      if (activitySequence.current === activityRequest) setActivity(nextActivity)
      if (evidenceSequence.current === evidenceRequest) setEvidence(nextEvidence)
      if (opened && nextProblem) setOpened({ ...opened, problem: nextProblem })
    } catch (reason) {
      if (current(token)) setError(errorMessage(reason))
    } finally {
      if (current(token)) { busyRef.current = null; setBusy(null) }
    }
  }

  const attempt = opened?.problem.attempts.find(item => item.id === opened.attemptId)
  const samples = evidence?.samples
  return <div className="learning-exercise" data-testid="learning-practical-exercise">
    {lesson.objective && <section className="learning-objective" data-testid="learning-objective">
      <h4>Objective</h4><p>{lesson.objective}</p>
    </section>}
    {opened && <section className="learning-sample-actions">
      <p className="learning-meta">Saved attempt: {attempt?.label ?? 'Unavailable'}</p>
      {opened.problem.samples.length > 0 ? <>
        <button type="button" className="button primary" data-testid="learning-run-samples"
          disabled={Boolean(busy) || hintPending || !attempt} onClick={() => void runSamples()}>
          {busy === 'run' ? 'Running…' : 'Run samples'}
        </button>
        {busy === 'run' && <button type="button" className="button" data-testid="learning-stop-samples" disabled={stopping}
          onClick={() => {
            if (stoppingRef.current) return
            const token = generation.current
            stoppingRef.current = true
            setStopping(true)
            void cancelOwnedSamples().catch(reason => {
              if (!current(token)) return
              setError(errorMessage(reason))
              stoppingRef.current = false
              setStopping(false)
            })
          }}>{stopping ? 'Stopping…' : 'Stop'}</button>}
        <p className="learning-meta">Runs {opened.problem.samples.length} saved samples using your existing save policy. Tests check saved code; unsaved editor changes are not verified.</p>
      </> : <p className="learning-meta">This saved exercise has no sample tests. No verification is available.</p>}
      <PracticeResults attempt={attempt}/>
    </section>}
    <h4>Try it yourself</h4>
    <p>{lesson.practice}</p>
    {lesson.starter !== undefined && <details className="learning-reference" data-testid="learning-starter">
      <summary>Editable starter</summary>
      <p className="learning-meta">Open the exercise to edit this scaffold. Existing attempts keep your code.</p>
      <pre><code>{lesson.starter || '(blank source file)'}</code></pre>
    </details>}
    {lesson.exercise && <>
      <h4>Expected behavior</h4><p>{lesson.exercise.expected}</p>
      <h4>Completion criteria</h4><p>{lesson.exercise.completion}</p>
      {!!lesson.exercise.samples?.length && <details>
        <summary>Sample inputs and outputs</summary>
        {lesson.exercise.samples.map(({ input, expectedOutput }, index) => <div key={index}>
          <p>Input {index + 1}</p><pre>{input || '(empty)'}</pre><p>Output</p><pre>{expectedOutput || '(empty)'}</pre>
        </div>)}
      </details>}
      {!lesson.exercise.samples?.length && <p className="learning-meta" data-testid="learning-no-samples">
        This lesson has no local sample tests. Exploring it does not verify the exercise.
      </p>}
      {runnable && <button className="button" type="button" data-testid="learning-start-exercise"
        disabled={Boolean(busy) || hintPending} onClick={() => void openExercise()}>
        {busy === 'open' ? practical ? 'Opening exercise…' : 'Opening Practice…' : practical ? 'Open exercise' : 'Open in Practice'}
      </button>}
    </>}
    {!!lesson.hints?.length && <section className="learning-hints" data-testid="learning-hints">
      <h4>Hints</h4>
      {revealed > 0 && <ol>{lesson.hints.slice(0, revealed).map((hint, index) => <li key={index}>{hint}</li>)}</ol>}
      <button type="button" className="button" data-testid="learning-reveal-hint"
        disabled={Boolean(busy) || hintPending || revealed >= lesson.hints.length} onClick={() => void revealHint()}>
        {revealed >= lesson.hints.length ? 'All hints shown' : revealed === 0 ? 'Show a hint' : 'Show next hint'}
      </button>
      <span className="learning-meta"> {revealed} of {lesson.hints.length} shown</span>
    </section>}
    {lesson.followUp && <section className="learning-follow-up" data-testid="learning-follow-up">
      <h4>Follow-up · unverified</h4><p>{lesson.followUp}</p>
    </section>}
    <section className="learning-saved-evidence" data-testid="learning-saved-evidence" aria-label="Local lesson evidence">
      <h4>Local evidence</h4>
      <p className="learning-meta" data-testid="learning-activity">
        {activity ? `Exploration: ${activity.opened} lesson opens · Hints viewed: ${activity.hintsRevealed}`
          : activity === null ? 'Local activity unavailable.' : 'Reading local activity…'}
      </p>
      <p className="learning-meta">{evidence
        ? `Saved attempts: ${evidence.attemptCount} · Manual status: ${evidence.manualStatus ?? 'Not set'}`
        : evidence === null ? 'Saved attempt evidence unavailable.' : 'Reading saved attempt evidence…'}</p>
      <p className="learning-meta" data-testid="learning-sample-evidence">{samples
        ? `Last saved attempt: ${samples.passed} of ${samples.total} samples passed · ${samples.failed} failed · ${samples.unavailable} unable to verify · ${samples.skipped} skipped. ${samples.current ? 'Saved source and samples match that run.' : 'Saved source or samples changed since that run.'}`
        : evidence ? 'No saved sample run.' : evidence === null ? 'Saved sample evidence unavailable.' : 'Reading saved sample evidence…'}</p>
      <p className="learning-meta">Activity, manual completion, and sample results are separate evidence. They do not establish mastery.</p>
      <button type="button" className="button" data-testid="learning-refresh-evidence" disabled={Boolean(busy) || hintPending}
        onClick={() => void refresh()}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh saved evidence'}</button>
    </section>
    {notice && <p role="status" className="learning-meta">{notice}</p>}
    {error && <p role="alert" className="learning-error">{error}</p>}
  </div>
}
