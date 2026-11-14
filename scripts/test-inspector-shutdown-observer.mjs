import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { observeInspectorShutdown } from './inspector-shutdown-observer.mjs'

function fixture({ priorError = true, ownClose = false } = {}) {
  const ws = new EventEmitter(), stderr = new EventEmitter()
  Object.assign(ws, { readyState: 1, _closeFrameSent: false, _closeFrameReceived: false })
  const errors = [], error = value => errors.push(value)
  if (priorError) ws.on('error', error)
  const processHandle = { pid: 101, stderr }
  const calls = [], failure = new Error('NEVER_CAPTURE_THIS_SECRET'), returnValue = Promise.resolve('unchanged')
  let throwClose = false
  function original(...args) { calls.push({ receiver: this, args }); if (throwClose) throw failure; return returnValue }
  const transport = ownClose ? { _ws: ws, close: original } : Object.assign(Object.create({ close: original }), { _ws: ws })
  const node = { _transport: transport, _closed: false }, impl = { process: () => processHandle, _nodeConnection: node }
  const connection = { toImpl(value) { assert.equal(this, connection); assert.equal(value, app); return impl } }
  const app = { _connection: connection }, session = { app, appProcess: processHandle, pid: 102 }
  return { ws, stderr, transport, node, impl, session, original, calls, failure, returnValue, errors,
    setThrow(value) { throwClose = value } }
}

test('passive close observation preserves receiver, arguments, exact promise and synchronous error', () => {
  const f = fixture(), observer = observeInspectorShutdown(f.session), receiver = {}, arg = { secret: 'NEVER_CAPTURE_ARGUMENT' }
  observer.setClosing()
  assert.equal(f.transport.close.call(receiver, arg), f.returnValue)
  assert.deepEqual(f.calls[0], { receiver, args: [arg] })
  f.setThrow(true)
  assert.throws(() => f.transport.close(), error => error === f.failure)
  const snap = observer.snapshot()
  assert.equal(snap.closeCalls, 2)
  assert.deepEqual(snap.events.slice(-4).map(e => e.kind), ['transport-close-call', 'transport-close-return', 'transport-close-call', 'transport-close-throw'])
  assert.doesNotMatch(JSON.stringify(snap), /NEVER_CAPTURE/)
  observer.dispose()
})

test('split marker and its following CR/LF are observed across chunks without retaining other stderr', () => {
  const f = fixture(), observer = observeInspectorShutdown(f.session)
  f.stderr.emit('data', Buffer.from('NEVER_CAPTURE_USER_TEXT\nWait'))
  assert.equal(observer.snapshot().markerTail, 'Wait')
  f.stderr.emit('data', Buffer.from('ing for the debugger to disconnect...'))
  assert.equal(observer.snapshot().markerCount, 1)
  assert.equal(observer.snapshot().markerTerminated, null)
  f.stderr.emit('data', Buffer.from('\r'))
  assert.equal(observer.snapshot().markerTerminated, true)
  assert.equal(observer.snapshot().markerNextByte, 'CR')
  f.stderr.emit('data', Buffer.from('\nWaiting for the debugger to disconnect...X'))
  assert.equal(observer.snapshot().markerCount, 2)
  assert.equal(observer.snapshot().markerTerminated, false)
  assert.equal(observer.snapshot().markerNextByte, 'other')
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /NEVER_CAPTURE_USER_TEXT/)
  observer.dispose()
})

test('socket events preserve existing error handling and record close-frame metadata and order', () => {
  const f = fixture(), observer = observeInspectorShutdown(f.session), error = new Error('NEVER_CAPTURE_ERROR')
  f.ws.emit('error', error)
  assert.equal(f.errors[0], error)
  f.transport.close()
  f.ws._closeFrameSent = true; f.ws._closeFrameReceived = true; f.ws.readyState = 3; f.node._closed = true
  f.ws.emit('close', 1000, Buffer.from('NEVER_CAPTURE_REASON'))
  const snap = observer.snapshot()
  assert.equal(snap.closed, true); assert.equal(snap.connectionClosed, true)
  assert.equal(snap.closeFrameSent, true); assert.equal(snap.closeFrameReceived, true)
  assert.equal(snap.closeEvents, 1); assert.equal(snap.errorEvents, 1)
  assert.deepEqual(snap.events.map(e => e.kind), ['installed', 'websocket-error', 'transport-close-call', 'transport-close-return', 'websocket-close'])
  assert.doesNotMatch(JSON.stringify(snap), /NEVER_CAPTURE/)
  observer.dispose()
})

test('missing pinned ownership/metadata fails explicitly and never suppresses an unhandled error', () => {
  assert.throws(() => observeInspectorShutdown({ app: {} }), /toImpl/)
  const f = fixture({ priorError: false })
  assert.throws(() => observeInspectorShutdown(f.session), /existing error handler/)
  assert.equal(f.transport.close, f.original); assert.equal(f.stderr.listenerCount('data'), 0)
  assert.throws(() => f.ws.emit('error', f.failure), error => error === f.failure)
  const g = fixture(); g.impl.process = () => ({})
  assert.throws(() => observeInspectorShutdown(g.session), /ownership/)
  assert.equal(g.stderr.listenerCount('data'), 0)
})

test('disposal restores original property/listeners and never overwrites a subsequent owner', () => {
  for (const ownClose of [false, true]) {
    const f = fixture({ ownClose }), prior = Object.getOwnPropertyDescriptor(f.transport, 'close')
    const observer = observeInspectorShutdown(f.session)
    observer.dispose(); observer.dispose()
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.transport, 'close'), prior)
    assert.equal(f.transport.close, f.original)
    assert.equal(f.stderr.listenerCount('data'), 0); assert.equal(f.stderr.listenerCount('end'), 0)
    assert.equal(f.stderr.listenerCount('close'), 0); assert.equal(f.ws.listenerCount('close'), 0)
    assert.equal(f.ws.listenerCount('error'), 1)
  }
  const f = fixture(), observer = observeInspectorShutdown(f.session), next = () => 'new owner'
  f.transport.close = next; observer.dispose(); assert.equal(f.transport.close, next)
})

test('event history and marker tail are bounded, snapshot records are defensive copies', () => {
  const f = fixture(), observer = observeInspectorShutdown(f.session)
  for (let i = 0; i < 1000; i++) f.transport.close()
  f.stderr.emit('data', Buffer.alloc(100000, 87))
  const snap = observer.snapshot()
  assert.equal(snap.closeCalls, 1000); assert.equal(snap.events.length, 32); assert.equal(snap.overflow, true)
  assert.equal(snap.markerTail, 'W')
  snap.events[0].kind = 'changed'; assert.equal(observer.snapshot().events[0].kind, 'installed')
  assert.ok(snap.events.every((e, i, rows) => !i || e.sequence > rows[i - 1].sequence && e.ms >= rows[i - 1].ms))
  observer.dispose()
})
