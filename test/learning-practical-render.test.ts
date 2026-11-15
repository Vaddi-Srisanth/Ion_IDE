import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import type { LearningBridge } from '../src/shared/learning'
import type { LearningPacksBridge, PackLesson } from '../src/shared/learning-packs'
import type { PracticeAttempt, PracticeBridge } from '../src/shared/practice'
import { PracticalExercise } from '../src/renderer/learning/PracticalExercise'
import { PracticeResults } from '../src/renderer/practice/PracticeResults'

test('shared real sample results retain statuses, stale-source copy and escape untrusted output', () => {
  const attempt: PracticeAttempt = { id: 'attempt', label: 'Attempt 1', createdAt: 1, lastRun: {
    current: false, testedAt: 2, results: [
      { id: 'pass', label: 'Sample 1', status: 'passed', message: 'Matched.', expected: '', stdout: '', stderr: '' },
      { id: 'fail', label: 'Sample 2', status: 'failed', message: 'Different output.', expected: 'value',
        stdout: '<script>unsafe()</script>', stderr: '<img src=x onerror=unsafe()>' },
      { id: 'missing', label: 'Sample 3', status: 'unavailable', message: 'No toolchain.', expected: '1', stdout: '', stderr: '' },
      { id: 'skip', label: 'Sample 4', status: 'skipped', message: 'Stopped.', expected: '2', stdout: '', stderr: '' },
    ],
  } }
  const html = renderToStaticMarkup(createElement(PracticeResults, { attempt }))
  assert.match(html, /data-testid="practice-results"/)
  assert.match(html, /1 of 4 passed/)
  assert.match(html, /Saved source or samples changed since this run\./)
  for (const status of ['passed', 'failed', 'unavailable', 'skipped']) assert.ok(html.includes(`data-status="${status}"`))
  for (const label of ['Expected stdout', 'Captured stdout', 'Captured diagnostics or stderr', 'Unable to verify']) {
    assert.ok(html.includes(label))
  }
  assert.ok(html.includes('&lt;script&gt;unsafe()&lt;/script&gt;'))
  assert.ok(!html.includes('<script>') && !html.includes('<img '))
  assert.equal(renderToStaticMarkup(createElement(PracticeResults, {})), '')
})

test('practical lesson render keeps legacy contracts and hides hints and execution before interaction', () => {
  const lesson: PackLesson = {
    id: 'flow', title: 'Flow', section: 'Syntax', explanation: 'Use loops.', example: 'pass', api: [],
    practice: 'Read a bound.', objective: 'Inspect a sequence.', starter: '# TODO: your loop\n',
    hints: ['Private first hint', 'Private second hint'], followUp: 'Optional and not checked by the samples.',
    exercise: { expected: 'Print a result.', completion: 'Try edge cases.', samples: [{ input: '2', expectedOutput: '1' }] },
  }
  const unavailable = new Proxy({}, { get() { return () => { throw new Error('Unexpected bridge call during render') } } })
  const props = {
    packId: 'python', topicId: 'flow', lesson, learning: unavailable as LearningBridge,
    packs: unavailable as LearningPacksBridge, practice: unavailable as PracticeBridge,
    onExercise() { throw new Error('Unexpected editor action') },
    async onPrepareRun() { throw new Error('Unexpected execution') }, onStopRun() {},
  }
  const html = renderToStaticMarkup(createElement(PracticalExercise, props))
  for (const text of ['Try it yourself', 'Expected behavior', 'Completion criteria', 'Sample inputs and outputs',
    'Open exercise', 'Editable starter', 'Follow-up · unverified', 'Reading saved sample evidence…']) assert.ok(html.includes(text))
  assert.ok(html.includes('data-testid="learning-start-exercise"'))
  assert.ok(!html.includes('learning-run-samples') && !html.includes('Private first hint') && !html.includes('Private second hint'))
  const legacy = renderToStaticMarkup(createElement(PracticalExercise, { ...props, lesson: {
    ...lesson, objective: undefined, starter: undefined, hints: undefined, followUp: undefined,
    exercise: { expected: 'Print a result.', completion: 'Try edge cases.' },
  } }))
  assert.ok(legacy.includes('Open in Practice') && legacy.includes('This lesson has no local sample tests.'))
})
