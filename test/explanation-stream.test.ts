import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readExplanationStream } from '../src/main/explanations/stream'

const headers = { 'content-type': 'text/event-stream; charset=utf-8' }
const signal = () => new AbortController().signal
const delta = (value: unknown, finish: unknown = null, index = 0) =>
  JSON.stringify({ choices: [{ index, delta: value, finish_reason: finish }] })
const data = (message: string) => 'data: ' + message + '\n\n'
const word = data(delta({ content: 'ok' }))
const stop = data(delta({}, 'stop'))
const done = data('[DONE]')
const invalid = 'The explanation provider returned an incomplete, unsupported, or oversized stream.'
const cancelled = 'The explanation stream was cancelled.'

function reply(chunks: Uint8Array[], keepOpen = false) {
  let index = 0, cancelled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++])
      else if (!keepOpen) controller.close()
    },
    cancel() { cancelled++ },
  })
  return { response: new Response(body, { headers }), body, cancellations: () => cancelled }
}

test('decodes SSE field and line framing with fragmented UTF-8, BOM, CR, CRLF and LF', async () => {
  const first = '{"choices":[{"index":0,"delta":{"content":"雪"},'
  const second = '"finish_reason":null}]}'
  const feed = '\uFEFF: keep alive\r\nretry: 500\r\nid: synthetic\r\n\r\n'
    + data(delta({ role: 'assistant', content: '', refusal: null }))
    + 'event: message\rdata: ' + first + '\rdata: ' + second + '\r\r'
    + data(delta({ content: '🌱' }, 'stop')).replaceAll('\n', '\r\n')
    + data(JSON.stringify({ choices: [], usage: { completion_tokens: 4 } })) + done
  const bytes = Buffer.from(feed)
  for (const width of [1, 7, bytes.length]) {
    const chunks = []
    for (let start = 0; start < bytes.length; start += width) chunks.push(bytes.subarray(start, start + width))
    const { response, body } = reply(chunks)
    assert.equal(await readExplanationStream(response, signal()), '雪🌱')
    assert.equal(body.locked, false)
  }
})

test('completion needs no server EOF and releases the remaining response body', async () => {
  const { response, body, cancellations } = reply([Buffer.from(word + stop + done)], true)
  assert.equal(await readExplanationStream(response, signal()), 'ok')
  assert.equal(cancellations(), 1)
  assert.equal(body.locked, false)
})

test('incomplete streams, unrelated choices, tools, refusals and provider errors fail with fixed messages', async () => {
  const cases = [
    '', word, word + done, word + stop, stop + done, word + stop + 'data: [DONE]\n',
    word + stop + word + done, word + stop + stop + done,
    word + data(delta({}, 'length')) + done, word + data(delta({}, 'content_filter')) + done,
    data(delta({ tool_calls: [{ function: { name: 'private-provider-detail' } }] })) + stop + done,
    data(delta({ function_call: {} })) + stop + done,
    data(delta({ refusal: 'private-provider-detail' })) + stop + done,
    data(delta({ role: 'tool', content: 'private-provider-detail' })) + stop + done,
    data(delta({ reasoning: 'private-provider-detail' })) + word + stop + done,
    data(delta({ content: ['private-provider-detail'] })) + stop + done,
    data(delta({ content: 'private-provider-detail' }, 'stop', 1)) + done,
    data(JSON.stringify({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] })) + word + stop + done,
    data(JSON.stringify({ choices: [], usage: {} })) + word + stop + done,
    'event: error\n' + word + stop + done,
    data('{"error":{"message":"private-provider-detail"}}') + word + stop + done,
    data('{private-provider-detail') + stop + done,
  ]
  for (const feed of cases) {
    const { response, body } = reply([Buffer.from(feed)])
    await assert.rejects(readExplanationStream(response, signal()), { message: invalid })
    assert.equal(body.locked, false)
  }
})

test('rejects invalid UTF-8 instead of silently replacing damaged text', async () => {
  const bytes = [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"'), Uint8Array.of(0xc3),
    Buffer.from('("},"finish_reason":"stop"}]}\n\n' + done)]
  const { response, body } = reply(bytes)
  await assert.rejects(readExplanationStream(response, signal()), { message: invalid })
  assert.equal(body.locked, false)
})

test('bounds raw wire bytes, an unfinished line, a multiline event, number of events, and extracted UTF-8 text', async () => {
  const keepalive = ':' + 'x'.repeat(8 * 1024) + '\n\n'
  const largeText = data(delta({ content: 'é'.repeat(8000) }))
  const cases = [
    keepalive.repeat(129) + word + stop + done,
    ':' + 'x'.repeat(32 * 1024) + '\n\n' + word + stop + done,
    (':' + 'y'.repeat(24 * 1024) + '\n').repeat(3) + '\n' + word + stop + done,
    data(delta({})).repeat(4097) + word + stop + done,
    largeText.repeat(11) + stop + done,
  ]
  for (const feed of cases) {
    // No single input chunk exceeds the line limit in these streaming cases.
    const bytes = Buffer.from(feed), chunks = []
    for (let start = 0; start < bytes.length; start += 1021) chunks.push(bytes.subarray(start, start + 1021))
    const { response, body } = reply(chunks)
    await assert.rejects(readExplanationStream(response, signal()), { message: invalid })
    assert.equal(body.locked, false)
  }
})

test('interrupts a pending read, releases the lock and suppresses the abort reason', async () => {
  const controller = new AbortController()
  let pulling!: () => void, cancellations = 0
  const waiting = new Promise<void>(resolve => { pulling = resolve })
  const body = new ReadableStream<Uint8Array>({
    pull() { pulling() },
    cancel() { cancellations++ },
  })
  const reading = readExplanationStream(new Response(body, { headers }), controller.signal)
  await waiting
  controller.abort(new Error('private-provider-detail'))
  await assert.rejects(reading, { message: cancelled })
  assert.equal(cancellations, 1)
  assert.equal(body.locked, false)
})

test('a cancellation during terminal body teardown discards the completed text and drains the transport', async () => {
  const controller = new AbortController()
  let announce!: () => void, finish!: () => void
  const tearingDown = new Promise<void>(resolve => { announce = resolve })
  const drained = new Promise<void>(resolve => { finish = resolve })
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(Buffer.from(word + stop + done)) },
    cancel() {
      announce()
      return drained
    },
  })
  const reading = readExplanationStream(new Response(body, { headers }), controller.signal)
  await tearingDown
  assert.equal(body.locked, false)
  controller.abort()
  finish()
  await assert.rejects(reading, { message: cancelled })
})

test('pre-cancelled, failed HTTP and non-SSE responses release their bodies without exposing provider content', async () => {
  const aborted = new AbortController()
  aborted.abort(new Error('private-provider-detail'))
  for (const [options, requestSignal, expected] of [
    [{ headers }, aborted.signal, cancelled],
    [{ headers, status: 401 }, signal(), invalid],
    [{ headers: { 'content-type': 'application/json' } }, signal(), invalid],
  ] as const) {
    let cancelledBody = false
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelledBody = true } })
    await assert.rejects(readExplanationStream(new Response(body, options), requestSignal), { message: expected })
    assert.ok(cancelledBody)
    assert.equal(body.locked, false)
  }
  const broken = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('private-provider-detail')) } })
  await assert.rejects(readExplanationStream(new Response(broken, { headers }), signal()), { message: invalid })
  assert.equal(broken.locked, false)
  await assert.rejects(readExplanationStream(new Response(null, { headers }), signal()), { message: invalid })
})
