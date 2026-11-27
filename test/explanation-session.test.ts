import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ExplanationCitation, ExplanationContent, ExplanationReview } from '../src/shared/explanations'
import { ExplanationSession, type ExplanationContext } from '../src/main/explanations/session'
import { WorkspaceFiles } from '../src/main/files'
import { buildExplanationPayload, ProviderVault } from '../src/main/projects/provider'
import { completionEvent, streamedCompletion } from './fixtures/explanation-sse'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

const key = 'synthetic-session-key-not-a-live-credential'
const settings = { endpoint: 'https://example.invalid/v1', model: 'fixture-model' }
const content: ExplanationContent = {
  summary: 'A bounded explanation.', sections: [{ kind: 'observed', title: 'First line', text: 'The reviewed text has a first line.',
    citations: [{ sourceId: 'file-1', startLine: 1, endLine: 1 }] }], questions: ['What happens next?'], edit: null,
  recommendations: [{ id: 'inspect', title: 'Inspect the second line', description: 'Review its behavior manually.',
    acceptance: ['Describe the second line.'], dependsOn: [], citations: [{ sourceId: 'file-1', startLine: 2, endLine: 2 }] }],
}
const response = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }))

async function fixture(t: TestContext) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-explanation-session-')))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'workspace'), other = join(scratch, 'other')
  await mkdir(root)
  await mkdir(other)
  const path = join(root, 'lesson.py'), outside = join(other, 'private.py')
  await writeFile(path, 'first line\nsecond line')
  await writeFile(outside, 'not approved')
  const scope = new WorkspaceFiles()
  await scope.grant(root, 'folder')
  const state = { current: true, approved: true, now: 0, decrypts: 0, requests: 0, contexts: 0,
    approvals: [] as ExplanationReview[], bodies: [] as string[], opened: [] as ExplanationCitation[], signals: [] as AbortSignal[],
    decryptHook: undefined as (() => Promise<void>) | undefined,
    approveHook: undefined as (() => Promise<boolean>) | undefined,
    requestHook: undefined as (() => Promise<Response>) | undefined,
    contextHook: undefined as (() => Promise<void>) | undefined,
    contextFailure: '', openFailure: '',
  }
  const vault = new ProviderVault(join(scratch, 'provider.json'), {
    available: async () => true,
    encrypt: async value => Buffer.from('unit-test-credential-adapter:' + value),
    decrypt: async value => {
      state.decrypts++
      await state.decryptHook?.()
      return value.toString().slice('unit-test-credential-adapter:'.length)
    },
  })
  await vault.update({ ...settings, apiKey: key })
  const context = async (request: unknown, signal: AbortSignal): Promise<ExplanationContext> => {
    state.contexts++
    await state.contextHook?.()
    signal.throwIfAborted()
    if (state.contextFailure) throw new Error(state.contextFailure)
    const requested = typeof request === 'string' ? request : path
    const saved = await scope.read(requested)
    const validate = async () => {
      if (scope.rootPath !== root) throw new Error('Raw source context moved: ' + key)
      const latest = await scope.read(requested)
      if (latest.revision !== saved.revision || latest.text !== saved.text) throw new Error('Raw source changed: ' + key)
    }
    return {
      ...(request && typeof request === 'object' && 'stream' in request && request.stream === true ? { stream: true } : {}),
      input: { purpose: 'tutor', action: 'hint', question: 'Explain this reviewed excerpt.', sources: [{
        id: 'file-1', label: basename(requested), origin: 'saved-file', revision: saved.revision,
        startLine: 1, endLine: 2, text: saved.text,
      }] },
      exclusions: ['Unselected source files were excluded.'], validate,
      async openCitation(citation) {
        await validate()
        if (state.openFailure) throw new Error(state.openFailure)
        state.opened.push(citation)
        return { entry: { path: requested, name: basename(requested), kind: 'file' },
          range: { startLine: citation.startLine, startColumn: 1, endLine: citation.endLine, endColumn: 1 } }
      },
    }
  }
  const session = new ExplanationSession({ vault: async () => vault, context,
    isCurrent: () => state.current, now: () => state.now,
    approve: async review => { state.approvals.push(review); return state.approveHook ? state.approveHook() : state.approved },
    request: async (url, init) => {
      assert.equal(String(url), settings.endpoint + '/chat/completions')
      assert.equal(init?.redirect, 'error')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + key)
      state.requests++
      state.bodies.push(String(init?.body))
      state.signals.push(init.signal as AbortSignal)
      return state.requestHook ? state.requestHook() : response()
    },
  })
  return { session, state, scope, vault, path, outside, root, other, scratch }
}

test('review does not decrypt or send, and single-use Send transmits exact reviewed evidence after consent', async t => {
  const { session, state } = await fixture(t)
  assert.equal(state.contexts, 0, 'construction is inert')
  const review = await session.review({})
  assert.equal(state.requests, 0)
  assert.equal(state.decrypts, 0)
  assert.equal(state.approvals.length, 0)
  assert.equal(Object.isFrozen(review.sources[0]), true)
  assert.equal(JSON.stringify(review).includes(key), false)
  assert.equal('fingerprint' in review || 'body' in review, false)
  const reply = await session.send(review.token)
  assert.ok(reply)
  assert.notEqual(reply.token, review.token)
  assert.equal(state.approvals.length, 1)
  assert.equal(state.decrypts, 1)
  assert.equal(state.requests, 1)
  const body = JSON.parse(state.bodies[0])
  assert.equal(Buffer.byteLength(state.bodies[0]), review.bodyBytes)
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    purpose: review.purpose, action: review.action, question: review.question, sources: review.sources,
  })
  assert.equal(body.store, false)
  assert.equal(state.bodies[0].includes(key), false)
  await assert.rejects(session.send(review.token), /unavailable or expired/)
  assert.equal(state.requests, 1, 'replay never sends twice')
})

test('declined consent, forged tokens and ungranted source requests cannot send or decrypt', async t => {
  const { session, state, outside } = await fixture(t)
  await assert.rejects(session.review(outside), /Could not prepare/)
  state.approved = false
  const review = await session.review({})
  await assert.rejects(session.send({ token: review.token }), /unavailable or expired/)
  await assert.rejects(session.send('forged-token'), /unavailable or expired/)
  assert.equal(await session.send(review.token), null)
  await assert.rejects(session.send(review.token), /unavailable or expired/)
  assert.equal(state.requests, 0)
  assert.equal(state.decrypts, 0)
})

test('stream mode is frozen at review and only the single natively approved send unlocks the provider and issues a citation token', async t => {
  const { session, state, path } = await fixture(t)
  state.approved = false
  const denied = await session.review({ stream: true })
  assert.equal(await session.send(denied.token), null)
  assert.equal(state.requests, 0)
  assert.equal(state.decrypts, 0)
  await assert.rejects(session.send(denied.token), /unavailable or expired/)

  const request = { stream: true }
  const review = await session.review(request)
  request.stream = false
  assert.equal(review.stream, true)
  assert.equal(Object.isFrozen(review), true)
  assert.equal(state.decrypts, 0)
  const expected = buildExplanationPayload(settings, {
    purpose: review.purpose, action: review.action, question: review.question, sources: review.sources,
  }, true)
  assert.equal(expected.bodyBytes, review.bodyBytes)
  state.approved = true
  state.requestHook = async () => streamedCompletion(content)
  const reply = await session.send(review.token)
  assert.ok(reply)
  assert.equal(state.approvals[1], review)
  assert.equal(state.approvals[1].stream, true)
  assert.equal(state.decrypts, 1)
  assert.equal(reply.summary, content.summary)
  assert.notEqual(reply.token, review.token)
  assert.equal((await session.openCitation(reply.token, 'file-1', { startLine: 1, endLine: 1 })).entry?.path, path)
  await assert.rejects(session.openCitation(reply.token, 'file-1', { startLine: 1, endLine: 2 }), /citation is unavailable/)
  await assert.rejects(session.send(review.token), /unavailable or expired/)
  assert.deepEqual(state.bodies, [expected.body])
})

test('cancel after the first content delta aborts transport, closes a pending stream read and discards partial output', { timeout: 8000 }, async t => {
  const { session, state } = await fixture(t)
  const review = await session.review({ stream: true })
  assert.equal(review.stream, true)
  const blocked = deferred<void>(), release = deferred<void>()
  let source!: ReadableStreamDefaultController<Uint8Array>, first = true, cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { source = controller },
    pull(controller) {
      if (first) {
        first = false
        controller.enqueue(new TextEncoder().encode(completionEvent({ role: 'assistant' }) + completionEvent({ content: '{"summary":"partial' })))
        return
      }
      blocked.resolve()
      return release.promise
    },
    cancel() { cancelled = true; release.resolve() },
  }, { highWaterMark: 0 })
  state.requestHook = async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  const sending = session.send(review.token)
  const result = assert.rejects(sending, /cancelled/)
  void result.catch(() => undefined)
  const watchdog = setTimeout(() => { source.error(new Error('fixture stream stalled')); release.resolve() }, 3500)
  try {
    await Promise.race([blocked.promise, sending.then(() => assert.fail('Incomplete reply was accepted'))])
    await assert.rejects(session.openCitation(review.token, 'file-1', { startLine: 1, endLine: 1 }), /still finishing/)
    session.cancel()
    assert.equal(state.signals[0].aborted, true)
    await result
    await session.drain()
    assert.equal(cancelled, true)
    assert.equal(body.locked, false)
    await assert.rejects(session.send(review.token), /unavailable or expired/)
    assert.deepEqual(state.opened, [])
    assert.equal(state.requests, 1)
  } finally {
    clearTimeout(watchdog)
    source.error(new Error('fixture complete'))
    release.resolve()
    await sending.catch(() => undefined)
  }
})

test('real source changes, root revocation and owner loss invalidate reviewed context', async t => {
  const { session, state, scope, path, other } = await fixture(t)
  let review = await session.review({})
  await writeFile(path, 'changed first line\nsecond line')
  await assert.rejects(session.send(review.token), /could not be completed/)
  assert.equal(state.approvals.length, 0)
  assert.equal(state.decrypts, 0)
  review = await session.review({})
  await scope.grant(other, 'folder')
  await assert.rejects(session.send(review.token), /could not be completed/)
  assert.equal(state.requests, 0)
  state.current = false
  await assert.rejects(session.review({}), /no longer active/)
})

test('provider key rotation before Send and during OS decryption prevents network access', async t => {
  const { session, state, vault } = await fixture(t)
  const review = await session.review({})
  await vault.update({ ...settings, apiKey: 'synthetic-rotated-session-key' })
  await assert.rejects(session.send(review.token), /could not be completed/)
  assert.equal(state.requests, 0)
  assert.equal(state.decrypts, 0)
  await vault.update({ ...settings, apiKey: key })
  const next = await session.review({})
  const entered = deferred<void>(), release = deferred<void>()
  state.decryptHook = async () => { entered.resolve(); await release.promise }
  const pending = session.send(next.token)
  void pending.catch(() => undefined)
  await entered.promise
  await vault.update({ ...settings, apiKey: 'synthetic-another-rotated-key' })
  release.resolve()
  await assert.rejects(pending, /could not be completed/)
  assert.equal(state.requests, 0)
})

test('cancel during consent revokes tokens and refuses overlap until pending cleanup unwinds', async t => {
  const { session, state } = await fixture(t)
  const review = await session.review({})
  const entered = deferred<void>(), release = deferred<boolean>()
  state.approveHook = async () => { entered.resolve(); return release.promise }
  const pending = session.send(review.token)
  void pending.catch(() => undefined)
  await entered.promise
  session.cancel()
  await assert.rejects(session.review({}), /still finishing/)
  release.resolve(true)
  await assert.rejects(pending, /cancelled/)
  assert.equal(state.requests, 0)
  assert.equal(state.decrypts, 0)
  state.approveHook = undefined
  const next = await session.review({})
  assert.notEqual(next.token, review.token)
})

test('close during context assembly prevents a review and rejects overlapping work until cleanup', async t => {
  const { session, state } = await fixture(t)
  const entered = deferred<void>(), release = deferred<void>()
  state.contextHook = async () => { entered.resolve(); await release.promise }
  const pending = session.review({})
  void pending.catch(() => undefined)
  await entered.promise
  session.close()
  let drained = false
  const cleanup = session.drain().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false, 'shutdown must wait for the context owner to unwind')
  await assert.rejects(session.review({}), /still finishing/)
  release.resolve()
  await assert.rejects(pending, /cancelled/)
  await cleanup
  assert.equal(drained, true)
  assert.equal(state.decrypts, 0)
  assert.equal(state.requests, 0)
})

test('cancel during transport aborts its signal and late responses never become a usable reply', async t => {
  const { session, state } = await fixture(t)
  const review = await session.review({})
  const entered = deferred<void>(), release = deferred<Response>()
  state.requestHook = async () => { entered.resolve(); return release.promise }
  const pending = session.send(review.token)
  void pending.catch(() => undefined)
  await entered.promise
  session.close()
  assert.equal(state.signals[0].aborted, true)
  await assert.rejects(session.review({}), /still finishing/)
  release.resolve(response())
  await assert.rejects(pending, /cancelled/)
  assert.equal(state.requests, 1, 'only the already-consented request was dispatched')
  await assert.rejects(session.send(review.token), /unavailable or expired/)
})

test('source changes after consent or while transport is pending prevent stale explanations', async t => {
  const { session, state, path } = await fixture(t)
  let review = await session.review({})
  state.approveHook = async () => { await writeFile(path, 'changed at consent\nsecond line'); return true }
  await assert.rejects(session.send(review.token), /could not be completed/)
  assert.equal(state.decrypts, 0)
  assert.equal(state.requests, 0)
  state.approveHook = undefined
  review = await session.review({ stream: true })
  const entered = deferred<void>(), release = deferred<Response>()
  state.requestHook = async () => { entered.resolve(); return release.promise }
  const pending = session.send(review.token)
  void pending.catch(() => undefined)
  await entered.promise
  await writeFile(path, 'changed during transport\nsecond line')
  release.resolve(streamedCompletion(content))
  await assert.rejects(pending, /could not be completed/)
})

test('source changes during unlock are rejected before transport, and provider rotation after transport discards its reply', async t => {
  const { session, state, path, vault } = await fixture(t)
  const first = await session.review({})
  state.decryptHook = async () => { await writeFile(path, 'changed while decrypting\nsecond line') }
  await assert.rejects(session.send(first.token), /could not be completed/)
  assert.equal(state.requests, 0)
  state.decryptHook = undefined
  const next = await session.review({})
  state.requestHook = async () => {
    await vault.update({ ...settings, apiKey: 'synthetic-rotated-after-dispatch' })
    return response()
  }
  await assert.rejects(session.send(next.token), /could not be completed/)
  assert.equal(state.requests, 1)
})

test('only exact citations actually returned can open, and no citation grants arbitrary files', async t => {
  const { session, state, path } = await fixture(t)
  const review = await session.review({})
  const reply = (await session.send(review.token))!
  for (const [source, range] of [
    ['file-1', { startLine: 1, endLine: 2 }], ['outside', { startLine: 1, endLine: 1 }],
    ['file-1', { startLine: 0, endLine: 1 }], ['file-1', { startLine: 1, endLine: 1, path: '../private.py' }],
  ] as const) await assert.rejects(session.openCitation(reply.token, source, range), /citation is unavailable/)
  assert.equal(state.opened.length, 0)
  const opened = await session.openCitation(reply.token, 'file-1', { startLine: 1, endLine: 1 })
  assert.equal(opened.entry?.path, path)
  await session.openCitation(reply.token, 'file-1', { startLine: 2, endLine: 2 })
  assert.equal(state.opened.length, 2, 'section and recommendation citations both work')
  assert.equal(Object.isFrozen(reply.sections[0].citations[0]), true)
  await writeFile(path, 'stale citation source\nsecond line')
  await assert.rejects(session.openCitation(reply.token, 'file-1', { startLine: 1, endLine: 1 }), /citation is unavailable/)
  assert.equal(state.opened.length, 2)
})

test('reviews and replies expire lazily at five minutes and replacing review revokes the previous reply', async t => {
  const { session, state } = await fixture(t)
  const first = await session.review({})
  state.now = 300_000
  await assert.rejects(session.send(first.token), /unavailable or expired/)
  assert.equal(state.requests, 0)
  const review = await session.review({})
  const reply = (await session.send(review.token))!
  state.now += 300_000
  await assert.rejects(session.openCitation(reply.token, 'file-1', { startLine: 1, endLine: 1 }), /unavailable or expired/)
  const next = await session.review({})
  const replacement = (await session.send(next.token))!
  await session.review({})
  await assert.rejects(session.openCitation(replacement.token, 'file-1', { startLine: 1, endLine: 1 }), /unavailable or expired/)
})

test('errors do not expose context, credentials, provider response bodies or filesystem paths', async t => {
  const { session, state, path, scratch } = await fixture(t)
  const secret = 'PRIVATE_PROVIDER_BODY ' + key + ' ' + path
  state.contextFailure = secret
  await assert.rejects(session.review({}), error => {
    assert.equal((error as Error).message, 'Could not prepare this explanation. No context was sent.')
    return true
  })
  state.contextFailure = ''
  const review = await session.review({})
  state.requestHook = async () => { throw new Error(secret) }
  await assert.rejects(session.send(review.token), error => {
    const encoded = String(error)
    for (const value of [key, path, secret, 'PRIVATE_PROVIDER_BODY']) assert.equal(encoded.includes(value), false)
    assert.equal(Object.hasOwn(error as object, 'cause'), false)
    return true
  })
  assert.equal((await readFile(join(scratch, 'provider.json'), 'utf8')).includes(key), false)
})
