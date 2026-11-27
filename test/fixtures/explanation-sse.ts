// The fixture constructs Chat Completions events locally. The request callback never opens a socket.
export function completionEvent(delta: { role?: 'assistant'; content?: string }, finish: 'stop' | null = null) {
  const chunk = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] }
  return 'data: ' + JSON.stringify(chunk) + '\n\n'
}

export function streamedCompletion(value: unknown, divideAt?: string) {
  const json = JSON.stringify(value)
  const split = divideAt ? json.indexOf(divideAt) + Math.floor(divideAt.length / 2) : Math.floor(json.length / 2)
  const body = completionEvent({ role: 'assistant', content: '' }) + completionEvent({ content: json.slice(0, split) })
    + completionEvent({ content: json.slice(split) }) + completionEvent({}, 'stop') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
