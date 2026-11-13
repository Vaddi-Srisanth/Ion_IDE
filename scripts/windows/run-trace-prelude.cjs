// Diagnostic-only entry prelude. Never imported by the production build.
const { AsyncLocalStorage } = require('node:async_hooks')
const processes = require('node:child_process')
const fs = require('node:fs/promises')
const { basename } = require('node:path')
const { ipcMain } = require('electron')

exports.install = function install() {
  const scope = new AsyncLocalStorage()
  const records = [], pending = new Map(), timers = new Map(), listeners = []
  const original = { spawn: processes.spawn, handle: ipcMain.handle, setTimeout, clearTimeout }
  const fileMethods = ['access', 'stat', 'lstat', 'realpath', 'readFile', 'open', 'mkdtemp', 'rm']
  for (const name of fileMethods) original[name] = fs[name]
  let active = false, started = false, overflow = false, counter = 0, start = 0
  const record = event => {
    if (!active) return
    if (records.length === 1024) { overflow = true; return }
    records.push({ atMs: performance.now() - start, ...event })
  }
  const begin = operation => {
    const row = { id: ++counter, owner: scope.getStore() ?? null, operation, beganMs: performance.now() - start }
    if (pending.size < 256) pending.set(row.id, row)
    else overflow = true
    record({ kind: 'begin', ...row })
    return row
  }
  const end = (row, error) => {
    pending.delete(row.id)
    record({ kind: 'end', id: row.id, durationMs: performance.now() - start - row.beganMs,
      ...(error ? { errorCode: String(error.code ?? error.name ?? 'error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) } : {}) })
  }
  function task(name, call, owned = false) {
    const row = begin(name)
    let result
    try { result = owned ? scope.run(row.id, call) : call() }
    catch (error) { end(row, error); throw error }
    // A derived diagnostic promise preserves rejection/error identity rather
    // than installing a side handler that could suppress an unhandled failure.
    if (result && typeof result.then === 'function') return result.then(value => {
      end(row); return value
    }, error => { end(row, error); throw error })
    end(row)
    return result
  }
  ipcMain.handle = function (channel, handler) {
    return Reflect.apply(original.handle, this, [channel, function (...args) {
      if (!active) return Reflect.apply(handler, this, args)
      return task('ipc:' + channel, () => Reflect.apply(handler, this, args), true)
    }])
  }
  for (const name of fileMethods) fs[name] = function (...args) {
    if (!active) return Reflect.apply(original[name], this, args)
    return task('fs:' + name, () => Reflect.apply(original[name], this, args))
  }
  processes.spawn = function (...args) {
    if (!active) return Reflect.apply(original.spawn, this, args)
    const row = begin('spawn')
    const argv = Array.isArray(args[1]) ? args[1] : []
    record({ kind: 'spawn-call', id: row.id, executable: basename(String(args[0])),
      payload: argv[0] === '--pipe' ? basename(String(argv[2])) : null, argumentCount: argv.length })
    let child
    try { child = Reflect.apply(original.spawn, this, args) }
    catch (error) { end(row, error); throw error }
    record({ kind: 'spawn-return', id: row.id, pid: child.pid ?? null })
    const listen = (target, name, callback) => {
      target.on(name, callback)
      listeners.push(() => target.removeListener(name, callback))
    }
    listen(child, 'spawn', () => record({ kind: 'child-spawn', id: row.id, pid: child.pid ?? null }))
    listen(child, 'exit', (code, signal) => record({ kind: 'child-exit', id: row.id, code, signal }))
    listen(child, 'error', error => record({ kind: 'child-error', id: row.id, code: String(error.code ?? 'error').slice(0, 32) }))
    listen(child, 'close', (code, signal) => { record({ kind: 'child-close', id: row.id, code, signal }); end(row) })
    if (argv[0] === '--pipe' && child.stdio[3]) {
      let buffer = ''
      listen(child.stdio[3], 'data', bytes => {
        buffer += bytes.toString('utf8')
        if (buffer.length > 4096) { record({ kind: 'status-overflow', id: row.id }); buffer = ''; return }
        for (;;) {
          const next = buffer.indexOf('\n')
          if (next < 0) break
          const line = buffer.slice(0, next).replace(/\r$/, '')
          buffer = buffer.slice(next + 1)
          record({ kind: 'native-status', id: row.id,
            status: /^READY \d+$/.test(line) ? 'READY' : line === 'CLEAN' ? 'CLEAN' : /^ERROR \d+$/.test(line) ? 'ERROR' : 'invalid' })
        }
      })
    }
    return child
  }
  global.setTimeout = function (callback, delay, ...args) {
    if (!active || typeof callback !== 'function' || !(delay >= 1000)) return Reflect.apply(original.setTimeout, this, [callback, delay, ...args])
    const row = begin('timer:' + delay)
    const timer = Reflect.apply(original.setTimeout, this, [function (...values) {
      timers.delete(timer); end(row)
      return Reflect.apply(callback, this, values)
    }, delay, ...args])
    timers.set(timer, row)
    return timer
  }
  global.clearTimeout = function (timer) {
    const row = timers.get(timer)
    if (row) { timers.delete(timer); record({ kind: 'timer-cancel', id: row.id }); pending.delete(row.id) }
    return Reflect.apply(original.clearTimeout, this, [timer])
  }
  return {
    start() {
      if (started) throw new Error('This diagnostic has no retries.')
      started = active = true; start = performance.now()
    },
    snapshot() {
      return { started, overflow, clock: 'main performance.now relative to diagnostic start only',
        records: records.slice(), pending: [...pending.values()], resources: process.getActiveResourcesInfo() }
    },
    dispose() {
      active = false
      processes.spawn = original.spawn; ipcMain.handle = original.handle
      global.setTimeout = original.setTimeout; global.clearTimeout = original.clearTimeout
      for (const name of fileMethods) fs[name] = original[name]
      for (const remove of listeners) remove()
      scope.disable()
    },
  }
}
