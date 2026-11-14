// Test-only host. Never imported by Ion. Windows x64 only; no BrowserWindow.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const readline = require('node:readline')
const crypto = require('node:crypto')
const { safeHostError } = require('./gcc-diagnostic-errors.cjs')

async function main() {
  assert.equal(process.platform, 'win32', 'No diagnostic host may launch on macOS.')
  assert.equal(process.arch, 'x64')
  const argument = key => process.argv.find(value => value.startsWith('--ion-gcc-' + key + '='))?.split('=').slice(1).join('=')
  const rootArg = argument('root'), helperArg = argument('helper'), lane = argument('lane')
  assert.ok(['B', 'C'].includes(lane))
  const root = await fs.realpath(rootArg), helper = await fs.realpath(helperArg)
  let electron
  if (lane === 'C') {
    assert.ok(process.versions.electron, 'C requires actual Electron, not ELECTRON_RUN_AS_NODE.')
    electron = require('electron')
    electron.app.setPath('userData', path.join(root, 'profile'))
    electron.app.setPath('sessionData', path.join(root, 'profile', 'session'))
    electron.app.setPath('logs', path.join(root, 'profile', 'logs'))
    await electron.app.whenReady()
  } else assert.ok(!process.versions.electron, 'B requires standalone Node.')
  const tools = require(path.join(__dirname, 'gcc-production-adapter.cjs'))
  tools.configureWindowsProcessHelper(helper)
  let input
  let controller, running = false, closing = false
  const send = value => process.stdout.write(JSON.stringify(value) + '\n')
  const tail = value => {
    const bytes = Buffer.from(String(value ?? ''), 'utf8')
    let start = Math.max(0, bytes.length - 8192)
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
    return bytes.subarray(start).toString('utf8')
  }
  async function quit() {
    input.close()
    if (electron) electron.app.quit()
    else { process.stdin.destroy(); process.exitCode = 0 }
  }
  // Windows GUI Electron can expose stdin as already ended. A reviewed
  // manifest argument makes C independent of that transport, without a server.
  const oneShotManifest = argument('manifest')
  if (lane === 'C' && oneShotManifest) {
    controller = new AbortController()
    send({ kind: 'host-ready', lane, pid: process.pid, node: process.versions.node, electron: process.versions.electron, guiWindows: 0 })
    const sendAndDrain = value => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()))
    try { await sendAndDrain(await attempt(oneShotManifest, controller.signal)) }
    catch (error) { process.exitCode = 1; await sendAndDrain({ kind: 'host-error', lane, error: safeHostError(error), message: String(error.message).slice(0, 512) }) }
    finally { controller.abort(); electron.app.quit() }
    return
  }
  input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', line => {
    if (line.length > 1024) { controller?.abort(); return }
    let command
    try { command = JSON.parse(line) } catch { controller?.abort(); return }
    if (command.kind === 'cancel') { controller?.abort(); return }
    if (command.kind === 'quit') { closing = true; controller?.abort(); if (!running) void quit(); return }
    if (!['run', 'version'].includes(command.kind) || running || closing || (command.kind === 'version' && lane !== 'B')) return
    running = true; controller = new AbortController()
    void attempt(command.manifest, controller.signal, command.kind === 'version').then(send, error => send({ kind: 'host-error',
      lane, error: safeHostError(error), message: String(error.message).slice(0, 512) })).finally(() => {
      running = false; controller = undefined; if (closing) void quit()
    })
  })
  input.once('close', () => { process.stderr.write('ION_GCC_DIAGNOSTIC_STDIN_CLOSED\n'); closing = true; controller?.abort(); if (!running && electron) electron.app.quit() })
  send({ kind: 'host-ready', lane, pid: process.pid, node: process.versions.node,
    electron: process.versions.electron ?? null, guiWindows: 0 })

  async function attempt(file, signal, versionOnly = false) {
    const manifestPath = await fs.realpath(file)
    assert.equal(path.dirname(manifestPath), path.join(root, 'manifests'))
    assert.ok((await fs.stat(manifestPath)).size <= 32768)
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    assert.equal(m.schemaVersion, 1); assert.equal(m.lane, lane)
    assert.match(m.runId, /^(?:first-[ABC]|warm-(?:[1-9][0-9]?|100)-[ABC])$/)
    assert.equal(m.workspace, root)
    assert.equal(m.timeoutMs, tools.defaultRunLimits.compileMs)
    assert.equal(m.outputBytes, 65536)
    const cwd = path.join(root, 'work'), source = path.join(cwd, 'latency-probe.c'), output = path.join(cwd, 'latency-probe.exe')
    assert.equal(await fs.realpath(cwd), cwd)
    assert.equal(m.cwd, cwd); assert.equal(m.source, source); assert.equal(m.output, output)
    assert.equal(await fs.realpath(source), source)
    assert.deepEqual(m.args, ['-x', 'c', '-std=c17', '-Wall', '-Wextra', '-fdiagnostics-color=never', source, '-o', output])
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex'), m.sourceSha256)
    assert.ok(path.win32.isAbsolute(m.compiler) && /^gcc\.exe$/i.test(path.basename(m.compiler)))
    assert.equal(await fs.realpath(m.compiler), m.compiler)
    const environment = m.environment
    assert.ok(environment && Object.keys(environment).length <= 16)
    for (const [key, value] of Object.entries(environment)) {
      assert.ok(/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) && typeof value === 'string' && value.length <= 8192 && !value.includes('\0'))
    }
    const started = performance.now(), events = []
    let overflow = false, updates = 0, outputBytes = 0, programTail = '', programMarker = false
    const trace = (stage, event, value) => {
      if (events.length >= 256) { overflow = true; return }
      const entry = { ms: performance.now() - started, stage, event }
      if (typeof value === 'number' && Number.isFinite(value)) entry.value = value
      else if (typeof value === 'boolean' || value === null) entry.value = value
      else if (typeof value === 'string') entry.value = value.slice(0, 80)
      if ((event === 'first-callback' || event === 'last-callback') && typeof value === 'number') entry.callbackAtMs = value - started
      events.push(entry)
      send({ schemaVersion: 1, kind: 'event', runId: m.runId, lane, ...entry })
    }
    const onAbort = () => trace('adapter-cleanup', 'requested')
    signal.addEventListener('abort', onAbort, { once: true })
    let result
    trace('adapter', 'request')
    try {
      if (lane === 'B') {
        result = await tools.execute(m.compiler, versionOnly ? ['--version'] : m.args, { cwd, environment, input: '', signal,
          timeoutMs: m.timeoutMs, budget: { remaining: m.outputBytes }, splitOutput: true, trace })
      } else {
        const runner = new tools.InteractiveRunner(helper, { compileMs: m.timeoutMs, programMs: 5000, outputBytes: m.outputBytes })
        const run = await runner.run({ language: 'c', cwd, label: 'fixed diagnostic fixture', toolchain: m.compiler,
          compile: { executable: m.compiler, args: m.args, environment, timeoutMs: m.timeoutMs },
          run: { executable: output, args: [], environment, timeoutMs: 5000 } }, update => {
          updates++
          if (update.kind === 'data') outputBytes += Buffer.byteLength(update.text)
          if (update.kind === 'data' && update.stream === 'terminal') {
            programTail = (programTail + update.text).slice(-128)
            programMarker ||= programTail.includes('ION-GCC-LATENCY')
          }
        }, signal, async () => crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex') === m.sourceSha256, trace)
        result = { state: run.status === 'success' ? (programMarker ? 'exited' : 'error') : run.status, exitCode: run.exitCode,
          outputComplete: run.outputComplete, stdout: '', stderr: run.compileOutput, detail: run.message,
          compileVerified: run.compileVerified, programMs: run.programMs }
      }
      trace('adapter', 'result-delivered')
      const ready = events.find(e => e.stage === 'compiler-payload' && e.event === 'ready-observed')
      const clean = events.some(e => e.stage === 'compiler-job' && e.event === 'clean-observed')
      const closed = events.some(e => e.stage === 'compiler-process' && e.event === 'close')
      const state = result.state
      return { kind: 'result', schemaVersion: 1, runId: m.runId, lane, operation: versionOnly ? 'version-postlude' : 'compile', elapsedMs: performance.now() - started,
        state, exitCode: result.exitCode, success: state === 'exited' && result.exitCode === 0 && result.outputComplete === true,
        outputComplete: result.outputComplete === true, cleanupVerified: clean && closed && result.outputComplete === true,
        payloadPid: ready?.value ?? null, controllerPid: process.pid, events, overflow, updates, outputBytes,
        stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr),
        detail: String(result.detail ?? '').slice(0, 512), programMs: result.programMs ?? null, programMarker: lane === 'C' ? programMarker : null,
        nativeKernelExitTime: null, nativeCleanupInitiated: null,
        limitations: ['Compiler exit callback is supervisor exit, not independently observed GCC kernel exit.',
          'READY/CLEAN are Node receipt times. No continuous child census or file/antivirus tracing.'] }
    } finally { signal.removeEventListener('abort', onAbort) }
  }
}
main().catch(error => { process.stderr.write(String(error.stack).slice(0, 2048) + '\n'); process.exitCode = 1 })
