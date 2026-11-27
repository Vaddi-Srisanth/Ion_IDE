import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { ExplanationAnswer, ExplanationDialog, ExplanationReviewView, selectedExplanationRequest } from '../src/renderer/explanations/ExplanationDialog'
import { ProviderConfiguration } from '../src/renderer/explanations/ProviderConfiguration'
import type { ExplanationBridge, ExplanationReply, ExplanationRequest, ExplanationReview } from '../src/shared/explanations'

const provider = { endpoint: 'https://example.invalid/v1', model: 'fixture-model', hasKey: false }
const request: ExplanationRequest = { purpose: 'tutor', action: 'hint', question: 'What does this mean?',
  lesson: { packId: 'python', lessonId: 'variables' },
  code: { label: 'unsaved.py', text: '<script>secret source</script>', version: 2 },
  diagnostic: 'NameError: fixture', project: { root: '/disposable', refs: Array.from({ length: 6 }, (_, index) => ({ path: `source-${index}.py`, revision: `revision-${index}` })) } }

test('context selection excludes source by default, caps explicit references and does not mutate context', () => {
  assert.deepEqual(selectedExplanationRequest(request, { lesson: false, code: false, diagnostic: false, structure: false, refs: [0] }, 'concept', 'Only a question'),
    { purpose: 'tutor', action: 'concept', question: 'Only a question' })
  const selected = selectedExplanationRequest(request, { lesson: true, code: true, diagnostic: true, structure: true, refs: [3, 3, -1, 1.5, 99, 1, 0, 2, 4, 5] }, 'hint', 'Review')
  assert.equal(selected.code?.text, request.code?.text)
  assert.deepEqual(selected.project?.refs.map(reference => reference.path), ['source-3.py', 'source-1.py', 'source-0.py', 'source-2.py'])
  assert.equal(request.project?.refs.length, 6)
})

test('opening renderer is dormant until effects and context is opt-in with six appropriate actions', () => {
  let calls = 0
  const forbidden = async () => { calls++; throw new Error('No bridge operation during rendering') }
  const bridge: ExplanationBridge = { provider: forbidden, configure: forbidden, review: forbidden, send: forbidden, cancel: forbidden, openCitation: forbidden }
  const html = renderToStaticMarkup(createElement(ExplanationDialog, { initialRequest: request, bridge, onClose() {}, onOpenCitation() {} }))
  assert.equal(calls, 0)
  assert.equal((html.match(/<option /g) ?? []).length, 6)
  assert.doesNotMatch(html, / checked=""/)
  assert.ok(html.includes('Stream provider response') && html.includes('validating the complete response and its citations'))
  assert.ok(html.includes('Current unsaved code: unsaved.py (off by default)'))
  assert.ok(!html.includes('secret source') && !html.includes('NameError: fixture'))
  assert.ok(html.includes('Review request') && !html.includes('Send reviewed request'))
  const project = renderToStaticMarkup(createElement(ExplanationDialog, { initialRequest: { ...request, purpose: 'project-lens', action: 'understand' }, bridge, onClose() {}, onOpenCitation() {} }))
  assert.ok(project.includes('Explain architecture') && !project.includes('Review my attempt'))
  assert.ok(project.includes('Stream provider response'))
  const oversized = renderToStaticMarkup(createElement(ExplanationDialog, { initialRequest: { ...request, question: '\u754c'.repeat(800) }, bridge, onClose() {}, onOpenCitation() {} }))
  assert.ok(oversized.includes('2400/2,048 UTF-8 bytes') && oversized.includes('Shorten your question before reviewing.'))
  assert.match(oversized, /<button[^>]*data-testid="explanation-review"[^>]*disabled=""/)
})

test('exact review escapes excerpts and identifies provider, model, size, revisions and exclusions', () => {
  const review: ExplanationReview = { token: 'never-show-token', provider, bodyBytes: 1200, expiresAt: 1000, purpose: 'tutor', action: 'hint',
    question: '<img src=x onerror=bad()>', exclusions: ['Private file excluded'], sources: [{ id: 'source-1', label: 'unsaved.py', origin: 'editor-buffer',
      revision: 'buffer-v2', startLine: 1, endLine: 4, text: '<script>bad()</script>' }] }
  const html = renderToStaticMarkup(createElement(ExplanationReviewView, { review, disabled: false, onSend() {} }))
  assert.ok(html.includes('https://example.invalid/v1') && html.includes('fixture-model') && html.includes('1,200 bytes'))
  assert.ok(html.includes('buffer-v2') && html.includes('Private file excluded'))
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;') && !html.includes('<script>'))
  assert.ok(html.includes('&lt;img src=x onerror=bad()&gt;') && !html.includes('<img '))
  assert.ok(!html.includes('never-show-token') && html.includes('Send reviewed request'))
  assert.ok(html.includes('Single response'))
  const streamed = renderToStaticMarkup(createElement(ExplanationReviewView, { review: { ...review, stream: true }, disabled: false, onSend() {} }))
  assert.ok(streamed.includes('Streaming') && !streamed.includes('Single response'))
})

test('AI answer is escaped read-only text with uncertainty and optional milestone review disabled', () => {
  const reply: ExplanationReply = { token: 'session-owned', summary: '<iframe src=bad>', sections: ['observed', 'inferred', 'unknown', 'suggestion'].map(kind => ({
    kind: kind as 'observed' | 'inferred' | 'unknown' | 'suggestion', title: '<script>title</script>', text: '[execute](javascript:bad())', citations: [{ sourceId: 'source-1', startLine: 1, endLine: 2 }] })),
    questions: ['<img src=x>'], recommendations: [{ id: 'proposal-1', title: 'Suggested task', description: 'Unverified description', acceptance: ['Confirm behavior'], dependsOn: [], citations: [] }] }
  const html = renderToStaticMarkup(createElement(ExplanationAnswer, { reply, disabled: false, onCitation() {} }))
  assert.ok(html.includes('Observed · AI unverified') && html.includes('Inferred · AI unverified') && html.includes('Unknown') && html.includes('Suggestion · AI unverified'))
  assert.ok(!html.includes('<script>') && !html.includes('<iframe ') && !html.includes('<img ') && !html.includes('<a '))
  assert.ok(html.includes('Source source-1 · 1–2') && !html.includes('session-owned'))
  assert.match(html, /<button[^>]*disabled=""[^>]*title="Milestone review is not available here"/)
  assert.ok(!html.includes('Run code') && !html.includes('Apply code'))
})

test('provider form uses existing metadata and keeps the key out of React markup', () => {
  const html = renderToStaticMarkup(createElement(ProviderConfiguration, { provider, onConfigure: async () => provider }))
  assert.ok(html.includes('value="https://example.invalid/v1"') && html.includes('value="fixture-model"'))
  assert.match(html, /<input type="password" autoComplete="off"[^>]*name="credential"/)
  assert.ok(!html.includes('value="fixture-key"'))
})
