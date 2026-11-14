// Opt-in test diagnostic for pinned Playwright's already-owned Node inspector.
// Never connects, sends protocol commands, closes sockets, polls or launches an app.
export function observeInspectorShutdown(session) {
  const app = session?.app
  const connection = app?._connection
  if (typeof connection?.toImpl !== 'function') throw new Error('Pinned Playwright toImpl is unavailable.')
  const impl = Reflect.apply(connection.toImpl, connection, [app])
  const processHandle = session.appProcess ?? app.process?.()
  if (!processHandle || typeof impl?.process !== 'function' || impl.process() !== processHandle) {
    throw new Error('Pinned Playwright inspector process ownership could not be verified.')
  }
  const node = impl._nodeConnection, transport = node?._transport, ws = transport?._ws
  const stderr = processHandle.stderr
  if (typeof transport?.close !== 'function' || typeof node?._closed !== 'boolean'
    || !ws || typeof ws.readyState !== 'number' || typeof ws._closeFrameSent !== 'boolean'
    || typeof ws._closeFrameReceived !== 'boolean' || typeof ws.on !== 'function'
    || typeof ws.removeListener !== 'function' || typeof ws.listenerCount !== 'function'
    || typeof stderr?.on !== 'function' || typeof stderr.removeListener !== 'function') {
    throw new Error('Pinned Playwright Node inspector transport metadata is unavailable.')
  }
  // Adding the first error listener would suppress EventEmitter's normal throw.
  if (!ws.listenerCount('error')) throw new Error('Pinned inspector WebSocket has no existing error handler; observation refused.')
  const descriptor = Object.getOwnPropertyDescriptor(transport, 'close')
  if (descriptor && (!('value' in descriptor) || (!descriptor.configurable && !descriptor.writable))) {
    throw new Error('Pinned inspector transport close method cannot be observed safely.')
  }
  const original = transport.close, began = performance.now(), records = []
  const marker = Buffer.from('Waiting for the debugger to disconnect...')
  let closing = false, disposed = false, overflow = false, ordinal = 0
  let matched = 0, awaitingNextByte = false, markerCount = 0, markerNextByte = null
  let markerTerminated = null, closeCalls = 0, closeEvents = 0, errorEvents = 0
  const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1)
  const state = () => ({ readyState: ws.readyState, closeFrameSent: ws._closeFrameSent,
    closeFrameReceived: ws._closeFrameReceived, connectionClosed: node._closed,
    closed: ws.readyState === 3 })
  function record(kind, detail = {}) {
    ordinal = increment(ordinal)
    if (records.length === 32) { overflow = true; return }
    records.push({ sequence: ordinal, ms: performance.now() - began, kind, closing, ...detail })
  }
  // Bookkeeping must never alter the original method's exact return/throw.
  const note = (kind, detail) => { try { record(kind, detail) } catch { overflow = true } }
  function close(...args) {
    closeCalls = increment(closeCalls)
    note('transport-close-call', state())
    try {
      const result = Reflect.apply(original, this, args)
      note('transport-close-return', state())
      return result
    } catch (error) { note('transport-close-throw', state()); throw error }
  }
  const data = chunk => {
    // Retain only a prefix of the fixed marker, never arbitrary stderr text.
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    for (const byte of bytes) {
      if (awaitingNextByte) {
        markerNextByte = byte === 10 ? 'LF' : byte === 13 ? 'CR' : 'other'
        markerTerminated = byte === 10 || byte === 13
        awaitingNextByte = false
        note('marker-next-byte', { category: markerNextByte, terminated: markerTerminated })
      }
      // The marker has no uppercase W beyond its first byte, so this fallback
      // retains every possible prefix while using at most marker.length bytes.
      matched = byte === marker[matched] ? matched + 1 : byte === marker[0] ? 1 : 0
      if (matched === marker.length) {
        matched = 0; markerCount = increment(markerCount)
        markerNextByte = null; markerTerminated = null; awaitingNextByte = true
        note('stderr-disconnect-marker', state())
      }
    }
  }
  const socketClose = () => { closeEvents = increment(closeEvents); note('websocket-close', state()) }
  const socketError = () => { errorEvents = increment(errorEvents); note('websocket-error', state()) }
  const stderrEnd = () => note('stderr-end')
  const stderrClose = () => note('stderr-close')
  function dispose() {
    if (disposed) return
    disposed = true
    stderr.removeListener('data', data); stderr.removeListener('end', stderrEnd); stderr.removeListener('close', stderrClose)
    ws.removeListener('close', socketClose); ws.removeListener('error', socketError)
    if (transport.close === close) {
      if (descriptor) Object.defineProperty(transport, 'close', descriptor)
      else delete transport.close
    }
  }
  try {
    Object.defineProperty(transport, 'close', descriptor ? { ...descriptor, value: close }
      : { value: close, writable: true, configurable: true })
    stderr.on('data', data); stderr.on('end', stderrEnd); stderr.on('close', stderrClose)
    ws.on('close', socketClose); ws.on('error', socketError)
  } catch (error) { dispose(); throw error }
  note('installed', state())
  return {
    setClosing() { if (!disposed && !closing) { closing = true; note('closing-requested') } },
    snapshot() {
      return { clock: 'observer performance.now relative milliseconds', passive: true, disposed, closing,
        ...state(), transportStillOwned: impl._nodeConnection === node && node._transport === transport && transport._ws === ws,
        markerCount, markerNextByte, markerTerminated, markerTail: marker.subarray(0, matched).toString('ascii'),
        markerAwaitingNextByte: awaitingNextByte, closeCalls, closeEvents, errorEvents, overflow,
        events: records.map(row => ({ ...row })) }
    },
    dispose,
  }
}
