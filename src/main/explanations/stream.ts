// The raw stream includes a JSON envelope per token. The assembled answer has its own smaller budget.
const wireLimit = 1024 * 1024
const answerLimit = 160 * 1024
const lineLimit = 32 * 1024
const eventLimit = 64 * 1024
const eventCountLimit = 4096
const invalid = 'The explanation provider returned an incomplete, unsupported, or oversized stream.'
const cancelled = 'The explanation stream was cancelled.'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one text-only Chat Completions choice. The caller owns the request deadline and final explanation validation. */
export async function readExplanationStream(response: Response, signal: AbortSignal): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let cleanup: Promise<void> | undefined
  let result = ''
  function cancelReader() {
    if (reader && !cleanup) cleanup = reader.cancel().catch(() => undefined)
  }

  try {
    reader = response.body?.getReader()
    if (signal.aborted || !reader || !response.ok
      || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
      throw new Error(invalid)
    }
    signal.addEventListener('abort', cancelReader, { once: true })
    const lineBuffer = new Uint8Array(lineLimit)
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const answer: string[] = []
    let lineLength = 0, eventBytes = 0, events = 0, wireBytes = 0, answerBytes = 0, emptyReads = 0
    let firstLine = true, afterCR = false, stopped = false, receivedUsage = false
    let eventName = '', data: string[] = []

    function dispatch(): boolean {
      if (data.length === 0) return false
      if (++events > eventCountLimit || (eventName !== '' && eventName !== 'message')) throw new Error(invalid)
      const message = data.join('\n')
      if (message === '[DONE]') {
        if (!stopped || !answerBytes) throw new Error(invalid)
        return true
      }
      const chunk: unknown = JSON.parse(message)
      if (!object(chunk) || 'error' in chunk || !Array.isArray(chunk.choices)) throw new Error(invalid)
      if (chunk.choices.length === 0 && stopped && !receivedUsage && object(chunk.usage)) {
        receivedUsage = true
        return false
      }
      if (stopped || chunk.choices.length !== 1) throw new Error(invalid)
      const choice: unknown = chunk.choices[0]
      if (!object(choice) || choice.index !== 0 || !object(choice.delta)) throw new Error(invalid)
      const delta = choice.delta
      if (Object.keys(delta).some(key => !['role', 'content', 'refusal', 'function_call', 'tool_calls'].includes(key))
        || delta.role !== undefined && delta.role !== 'assistant' || delta.refusal != null
        || delta.function_call != null || delta.tool_calls != null) throw new Error(invalid)
      if (delta.content != null) {
        if (typeof delta.content !== 'string') throw new Error(invalid)
        answerBytes += Buffer.byteLength(delta.content)
        if (answerBytes > answerLimit) throw new Error(invalid)
        if (delta.content) answer.push(delta.content)
      }
      if (choice.finish_reason === 'stop') stopped = true
      else if (choice.finish_reason != null) throw new Error(invalid)
      return false
    }

    function finishLine(): boolean {
      let line = decoder.decode(lineBuffer.subarray(0, lineLength))
      if (firstLine && line.startsWith('\uFEFF')) line = line.slice(1)
      firstLine = false
      eventBytes += lineLength + 1
      lineLength = 0
      if (eventBytes > eventLimit) throw new Error(invalid)
      if (!line) {
        const done = dispatch()
        data = []
        eventName = ''
        eventBytes = 0
        return done
      }
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(line[colon + 1] === ' ' ? colon + 2 : colon + 1)
      if (field === 'data') data.push(value)
      else if (field === 'event') eventName = value
      // Comments and other SSE fields do not carry answer text. This request never reconnects.
      return false
    }

    receive: for (;;) {
      const { done, value } = await reader.read()
      if (signal.aborted || done) throw new Error(invalid)
      wireBytes += value.byteLength
      emptyReads = value.byteLength ? 0 : emptyReads + 1
      if (wireBytes > wireLimit || emptyReads > 32) throw new Error(invalid)
      for (const byte of value) {
        if (afterCR && byte === 10) {
          afterCR = false
          continue
        }
        afterCR = byte === 13
        if (byte === 13 || byte === 10) {
          if (finishLine()) {
            result = answer.join('')
            break receive
          }
        } else {
          if (lineLength === lineBuffer.length) throw new Error(invalid)
          lineBuffer[lineLength++] = byte
        }
      }
    }
  } catch {
    throw new Error(signal.aborted ? cancelled : invalid)
  } finally {
    signal.removeEventListener('abort', cancelReader)
    cancelReader()
    reader?.releaseLock()
    await cleanup
  }
  if (signal.aborted) throw new Error(cancelled)
  return result
}
