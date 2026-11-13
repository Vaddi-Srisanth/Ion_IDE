const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

test('diagnostic preserves IPC receiver, async error identity, ownership and disposal without recording arguments', async () => {
  const handles = new Map(), child = new EventEmitter(), status = new EventEmitter()
  child.pid = 123
  child.stdio = [null, null, null, status]
  const failure = new Error('NEVER_CAPTURE_THIS_MESSAGE')
  failure.code = 'E_FIXTURE'
  let rejectRead = false
  const fs = Object.fromEntries(['access', 'stat', 'lstat', 'realpath', 'readFile', 'open', 'mkdtemp', 'rm']
    .map(name => [name, () => rejectRead ? Promise.reject(failure) : Promise.resolve('fixture value')]))
  const processes = { spawn() { return child } }
  const ipcMain = { handle(channel, handler) { handles.set(channel, handler) } }
  const timers = []
  const sandbox = {
    module: { exports: {} }, performance,
    process: { getActiveResourcesInfo: () => ['PipeWrap'] },
    setTimeout(callback, delay, ...args) {
      const timer = { unref() {}, callback, delay, args }
      timers.push(timer)
      return timer
    },
    clearTimeout() {},
    require(name) {
      if (name === 'node:fs/promises') return fs
      if (name === 'node:child_process') return processes
      if (name === 'electron') return { ipcMain }
      return require(name)
    },
  }
  sandbox.exports = sandbox.module.exports
  sandbox.global = sandbox
  const original = { spawn: processes.spawn, readFile: fs.readFile, handle: ipcMain.handle, timeout: sandbox.setTimeout }
  vm.runInNewContext(readFileSync(join(__dirname, 'run-trace-prelude.cjs'), 'utf8'), sandbox)
  const trace = sandbox.module.exports.install(), receiver = {}
  ipcMain.handle('ion:live-run-start', function (text) {
    assert.equal(this, receiver)
    assert.equal(text, 'NEVER_CAPTURE_ARGUMENT')
    processes.spawn('/private/no-log/ion-pty.exe', ['--pipe', '1', '/private/no-log/compiler.exe', 'NEVER_CAPTURE_ARGUMENT'])
    return fs.readFile('/private/no-log/NEVER_CAPTURE_PATH')
  })
  trace.start()
  assert.equal(await handles.get('ion:live-run-start').call(receiver, 'NEVER_CAPTURE_ARGUMENT'), 'fixture value')
  child.emit('spawn')
  status.emit('data', Buffer.from('READY 124\nCLEAN\n'))
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
  const snapshot = trace.snapshot()
  const ipc = snapshot.records.find(row => row.operation === 'ipc:ion:live-run-start')
  assert.ok(ipc)
  assert.equal(snapshot.records.find(row => row.operation === 'fs:readFile').owner, ipc.id)
  assert.equal(snapshot.records.find(row => row.operation === 'spawn').owner, ipc.id)
  assert.equal(snapshot.pending.length, 0)
  assert.equal(snapshot.records.filter(row => row.kind === 'native-status').length, 2)
  assert.doesNotMatch(JSON.stringify(snapshot), /NEVER_CAPTURE|private\/no-log/)

  rejectRead = true
  await assert.rejects(handles.get('ion:live-run-start').call(receiver, 'NEVER_CAPTURE_ARGUMENT'), error => error === failure)
  assert.doesNotMatch(JSON.stringify(trace.snapshot()), /NEVER_CAPTURE|private\/no-log/)
  trace.dispose()
  assert.equal(processes.spawn, original.spawn)
  assert.equal(fs.readFile, original.readFile)
  assert.equal(ipcMain.handle, original.handle)
  assert.equal(sandbox.setTimeout, original.timeout)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(status.listenerCount('data'), 0)
})
