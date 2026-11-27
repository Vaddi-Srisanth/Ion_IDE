import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import vm from 'node:vm'
import { test } from 'node:test'
import { appendShutdownTail, dismissPreferences, disposeUpdateShutdown, installCloseConfirmationProbe, knownShutdownLiveness, observeUpdateShutdown, shutdownPids } from './update-preferences-support.mjs'

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

test('known-PID native liveness distinguishes a real owned live process from its verified exit without PowerShell', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })
  const exited = once(child, 'exit')
  try {
    await once(child, 'spawn')
    const session = { appProcess: child, pid: child.pid }
    assert.deepEqual(knownShutdownLiveness(session).alive, [child.pid])
    child.kill()
    await exited
    assert.deepEqual(knownShutdownLiveness(session).alive, [])
    assert.throws(() => knownShutdownLiveness({ pid: 'unsafe' }), /validated shutdown PIDs/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  }
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

test('shutdown receipt captures exact-PID liveness before and after a failed native query and the owned wrapper exit', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })
  const exit = once(child, 'exit')
  let saved
  const session = { appProcess: child, pid: child.pid, mainCreationTime: 123 }
  const dispose = observeUpdateShutdown(session, async value => { saved = value }, async () => {
    child.kill()
    await exit
    return { state: 'error', error: { code: 'ETIMEDOUT', killed: true } }
  })
  try {
    await once(child, 'spawn')
    await session.onShutdownFailure({ error: 'synthetic shutdown boundary' })
    assert.deepEqual(saved.liveness.before.alive, [child.pid])
    assert.deepEqual(saved.liveness.after.alive, [])
    assert.equal(saved.native.error.code, 'ETIMEDOUT', 'query failure is preserved, not used as a liveness result')
    assert.ok(saved.liveness.before.ms <= saved.liveness.after.ms)
    assert.equal(saved.wrapperExitEvents.length, 1)
    assert.ok(saved.wrapperExitEvents[0].ms >= saved.liveness.before.ms)
    assert.ok(saved.wrapperExitEvents[0].ms <= saved.liveness.after.ms)
  } finally {
    dispose()
    assert.equal(child.listenerCount('exit'), 0)
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exit
  }
})

test('shutdown receipt preserves unavailable PID observations and a rejected native query explicitly', async () => {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  const session = { appProcess: child, pid: 'not-a-validated-pid' }
  let saved
  const dispose = observeUpdateShutdown(session, async value => { saved = value }, async () => {
    throw new Error('synthetic native query failure')
  })
  try {
    await session.onShutdownFailure({ error: 'synthetic close failure' })
    assert.equal(saved.liveness.before.state, 'error')
    assert.equal(saved.liveness.after.state, 'error')
    assert.match(saved.liveness.before.error.message, /No validated shutdown PIDs/)
    assert.equal(saved.native.state, 'error')
    assert.equal(saved.native.error.message, 'synthetic native query failure')
  } finally {
    dispose()
    assert.equal(child.listenerCount('exit'), 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
  }
})

test('the serialized close probe preserves receivers, exact returns/errors and bounds without affecting other channels', () => {
  const handlers = new Map(), ipcMain = { handle(channel, handler) {
    assert.equal(this, ipcMain); handlers.set(channel, handler); return 'registered'
  } }, host = {}, receiver = {}, failure = new Error('exact failure'), result = Promise.resolve('exact promise')
  const context = { ipcMain, host, now: () => 123 }
  const dispose = vm.runInNewContext(`(${installCloseConfirmationProbe.toString()})(ipcMain,host,now)`, context)
  const handler = function (event, allow) { assert.equal(this, receiver); assert.equal(event, 'event');
    if (!allow) throw failure; return result }
  assert.equal(ipcMain.handle('ion:confirm-window-close', handler), 'registered')
  const wrapped = handlers.get('ion:confirm-window-close')
  assert.equal(wrapped.call(receiver, 'event', true), result)
  assert.throws(() => wrapped.call(receiver, 'event', false), error => error === failure)
  for (let index = 0; index < 30; index++) wrapped.call(receiver, 'event', true)
  assert.equal(host.ionCloseConfirmations.length, 16)
  assert.ok(host.ionCloseConfirmations.every(row => row.allow === true && row.ms === 123))
  ipcMain.handle('unrelated', handler)
  assert.equal(handlers.get('unrelated'), handler)
  dispose()
})
