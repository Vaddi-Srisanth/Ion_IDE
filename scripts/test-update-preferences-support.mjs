import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { appendShutdownTail, dismissPreferences, disposeUpdateShutdown, observeUpdateShutdown, shutdownPids } from './update-preferences-support.mjs'

test('Done click acknowledgement does not replace the detached-dialog boundary', async () => {
  const events = []
  let detach
  const detached = new Promise(resolve => { detach = resolve })
  const page = { getByRole() { return {
    isVisible: async () => true,
    getByRole() { return { async click() { events.push('click-returned') } } },
    async waitFor(options) { assert.equal(options.state, 'detached'); events.push('waiting-for-detach'); await detached; events.push('detached') },
  } } }
  const job = dismissPreferences(page).then(() => events.push('request-close'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['click-returned', 'waiting-for-detach'])
  detach(); await job
  assert.deepEqual(events, ['click-returned', 'waiting-for-detach', 'detached', 'request-close'])
})

test('a detached-dialog failure cannot be treated as a successful close boundary', async () => {
  const error = new Error('fixture detach failure')
  const page = { getByRole() { return { isVisible: async () => false, async waitFor() { throw error } } } }
  await assert.rejects(dismissPreferences(page), actual => actual === error)
})

test('known shutdown PID selection distinguishes wrapper and Electron without accepting arbitrary process filters', () => {
  assert.deepEqual(shutdownPids({ appProcess: { pid: 100 }, pid: 200 }), [100, 200])
  assert.deepEqual(shutdownPids({ appProcess: { pid: 100 }, pid: 100 }), [100])
  assert.deepEqual(shutdownPids({ appProcess: { pid: '1 OR 1=1' }, pid: -1 }), [])
})

test('the opt-in stderr tail retains at most 8192 bytes, including Unicode and oversized chunks', () => {
  let tail = appendShutdownTail(Buffer.alloc(0), Buffer.from('α'.repeat(10000)))
  assert.equal(tail.length, 8192)
  tail = appendShutdownTail(tail, Buffer.from('last'))
  assert.equal(tail.length, 8192)
  assert.equal(tail.subarray(-4).toString(), 'last')
})

test('the opt-in observer removes its actual stderr listener and disposer property on every close path', () => {
  const stderr = new EventEmitter(), prior = () => {}
  const session = { appProcess: { stderr }, onShutdownFailure: prior }
  session.disposeShutdownObserver = observeUpdateShutdown(session, () => {})
  assert.equal(stderr.listenerCount('data'), 1)
  assert.notEqual(session.onShutdownFailure, prior)
  stderr.emit('data', Buffer.from('bounded diagnostic text'))
  disposeUpdateShutdown(session)
  assert.equal(stderr.listenerCount('data'), 0)
  assert.equal(Object.hasOwn(session, 'disposeShutdownObserver'), false)
  assert.equal(session.onShutdownFailure, prior)
  disposeUpdateShutdown(session)
  assert.equal(stderr.listenerCount('data'), 0)
})
