import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { artifact, close, createProject, launch, openFolder, openFromExplorer, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const reportPath = resolve('performance-results/windows-compiler-bridge.json')
const marker = 'ION-COMPILER-BRIDGE-DIAGNOSTIC'
const id = randomUUID()
const report = { platform: process.platform, architecture: process.arch, id, marker,
  scope: 'Real renderer IPC and main compiler engine; not an assertion about terminal painting.',
  passed: false, cleanupErrors: [], sessionLaunched: false }
let failure
// Bundled once into disposable test code so the exact same execute adapter and
// comparison function run under standalone Node and Electron's main process.
async function compareCompiler(tools, data) {
  const key = Symbol.for('ion.ide.trusted-windows-process-helper')
  const existing = Reflect.get(globalThis, key)
  if (existing !== undefined && existing !== data.helper) throw new Error('The diagnostic helper differs from the installation-owned helper.')
  tools.configureWindowsProcessHelper(data.helper)
  const trace = [], controller = new AbortController(), began = performance.now()
  const tail = text => Buffer.from(text ?? '', 'utf8').subarray(-8192).toString('utf8')
  try {
    const result = await tools.execute(data.compiler, ['-x', 'c', '-std=c17', '-Wall', '-Wextra',
      '-fdiagnostics-color=never', data.source, '-o', data.output], {
      cwd: data.cwd, input: '', signal: controller.signal, timeoutMs: 15000,
      budget: { remaining: 64 * 1024 }, splitOutput: true,
      environment: tools.windowsEnvironment(await tools.workspaceSafeWindowsToolPaths(data.cwd), data.temp),
      trace(stage, event, value) { if (trace.length < 64) trace.push({ stage, event, value }) },
    })
    return { node: process.versions.node, electron: process.versions.electron ?? null,
      elapsedMs: performance.now() - began, trace, result: { ...result,
        output: tail(result.output), stdout: tail(result.stdout), stderr: tail(result.stderr),
        detail: result.detail && String(result.detail).slice(0, 1000) } }
  } finally { controller.abort() }
}
try {
  assert.equal(process.platform, 'win32', 'Run this diagnostic fixture on genuine Windows.')
  const target = await artifact(values.target)
  await withScratch('windows-compiler-bridge', async scratch => {
    let session, primaryError
    try {
      const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
      await writeFile(project.program, '#error ' + marker + '\nint main(void) { return 0; }\n')
      assert.ok(target.args[0], 'Use a production source build to resolve its installation-owned native helper.')
      const helper = resolve(dirname(target.args[0]), '../native/ion-pty.exe')
      const comparisonBundle = join(scratch, 'compiler-parent-comparison.cjs')
      await build({ stdin: { contents: `export {execute} from './src/main/runner.ts';
        export {configureWindowsProcessHelper,windowsEnvironment,workspaceSafeWindowsToolPaths} from './src/main/windows-process.ts';
        export const compare=${compareCompiler.toString()};`, resolveDir: process.cwd() },
      outfile: comparisonBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
      // Inspector-evaluated functions have no dynamic-import callback. Load
      // the private adapter from this disposable CJS entry, just as the other
      // main-process probes do, without changing production module exports.
      const comparisonKey = 'ion.test.compiler-parent-comparison'
      const probeEntry = join(scratch, 'compiler-bridge-entry.cjs')
      await writeFile(probeEntry, `globalThis[Symbol.for(${JSON.stringify(comparisonKey)})]=require(${JSON.stringify(comparisonBundle)});require(${JSON.stringify(resolve(target.args[0]))});`)
      session = await launch({ ...target, args: [probeEntry, ...target.args.slice(1)] }, join(scratch, 'profile'))
      report.sessionLaunched = true
      report.pid = session.pid
      const { app, page } = session
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory, allowRun: true })
      await openFolder(page, project)
      await openFromExplorer(page, project.program, marker)
      await app.evaluate((_, id) => {
        const key = Symbol.for('ion.main.run-trace.v1'), previous = Object.getOwnPropertyDescriptor(globalThis, key)
        const events = []
        let total = 0
        const sink = event => {
          if (event.id !== id) return
          total++
          if (events.length < 256) events.push({ ...event,
            value: typeof event.value === 'string' ? event.value.slice(0, 256) : event.value })
        }
        globalThis[key] = sink
        globalThis.__ionCompilerBridgeMain = { snapshot: () => ({ total, events }), restore() {
          if (globalThis[key] === sink) {
            if (previous) Object.defineProperty(globalThis, key, previous)
            else delete globalThis[key]
          }
          delete globalThis.__ionCompilerBridgeMain
        } }
      }, id)
      await page.evaluate(id => {
        const events = [], encoder = new TextEncoder(), decoder = new TextDecoder()
        let compilerData = '', total = 0, compilerBytes = 0
        let completed
        const completion = new Promise(resolve => { completed = resolve })
        const tail = text => decoder.decode(encoder.encode(text).slice(-8192))
        const remove = window.ion.runConsole.onUpdate(event => {
          if (event.id !== id) return
          const update = event.update
          total++
          if (events.length < 32) events.push({ kind: update.kind,
            ...(update.kind === 'phase' ? { phase: update.phase } : {}),
            ...(update.kind === 'data' ? { stream: update.stream, bytes: encoder.encode(update.text).length } : {}) })
          if (update.kind === 'data' && update.stream === 'compiler') {
            compilerBytes += encoder.encode(update.text).length
            compilerData = tail(compilerData + update.text)
          }
          if (update.kind === 'complete') completed()
        })
        globalThis.__ionCompilerBridgeRenderer = { tail, completion,
          snapshot: () => ({ total, events, compilerBytes, compilerData }), dispose() {
            remove(); delete globalThis.__ionCompilerBridgeRenderer
          } }
      }, id)
      report.result = await page.evaluate(async ({ id, path }) => {
        const result = await window.ion.runConsole.start(id, path, false)
        return { compiler: result.compiler, status: result.status,
          compileOutput: globalThis.__ionCompilerBridgeRenderer.tail(result.compileOutput),
          compileMs: result.compileMs, durationMs: result.durationMs, exitCode: result.exitCode,
          outputComplete: result.outputComplete, compileVerified: result.compileVerified,
          message: result.message }
      }, { id, path: project.program })
      // The invoke reply and stream are separate. Inspect the stream only
      // after its real ordered completion marker, never after an arbitrary sleep.
      await page.evaluate(async () => {
        let timer
        try {
          await Promise.race([globalThis.__ionCompilerBridgeRenderer.completion,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Compiler stream completion marker was not delivered.')), 5000) })])
        } finally { clearTimeout(timer) }
      }).catch(error => { report.streamCompletionError = String(error?.message ?? error).slice(0, 1000) })
      report.chosenCompiler = report.result.compiler ? basename(report.result.compiler) : null
      report.renderer = await page.evaluate(() => globalThis.__ionCompilerBridgeRenderer.snapshot())
      report.main = await app.evaluate(() => globalThis.__ionCompilerBridgeMain.snapshot())
      // Capture both boundaries once before making assertions about the real
      // bridge, so a failure cannot hide the independent parent-runtime evidence.
      report.comparisons = {}
      const data = { compiler: report.result.compiler, helper, cwd: project.directory, temp: scratch,
        source: project.program, output: join(scratch, 'program.exe') }
      if (data.compiler) {
        try {
          const tools = createRequire(import.meta.url)(comparisonBundle)
          report.comparisons.node = await tools.compare(tools, data)
        } catch (error) { report.comparisons.node = { error: String(error?.stack ?? error).slice(0, 2000) } }
        try {
          report.comparisons.electron = await app.evaluate(async (_, { key, data }) => {
            const tools = Reflect.get(globalThis, Symbol.for(key))
            if (!tools) throw new Error('The private compiler comparison adapter was not installed.')
            return tools.compare(tools, data)
          }, { key: comparisonKey, data })
        } catch (error) { report.comparisons.electron = { error: String(error?.stack ?? error).slice(0, 2000) } }
      } else report.comparisons.unavailable = 'The actual run did not select a compiler.'
      assert.equal(report.result.status, 'compile-error')
      // The real IPC contract strips duplicated compiler text from its reply;
      // compiler text belongs to the streamed updates, not this result field.
      assert.equal(report.result.compileOutput, '', 'The IPC reply unexpectedly duplicated compiler output.')
      assert.equal(report.streamCompletionError, undefined, 'Compiler stream completion marker was not delivered.')
      assert.ok(report.renderer.compilerData.includes(marker), 'Renderer compiler-data events omitted the real diagnostic.')
      assert.equal(report.result.outputComplete, true, 'Compiler output cleanup was not verified.')
      assert.ok(report.main.events.some(event => event.stage === 'compiler-output' && event.event === 'bytes' && event.value > 0))
      for (const runtime of ['node', 'electron']) {
        const comparison = report.comparisons[runtime]
        assert.equal(comparison?.error, undefined, runtime + ' direct comparison could not execute.')
        assert.equal(comparison?.result?.state, 'exited', runtime + ' direct compiler did not exit normally.')
        assert.ok(comparison.result.exitCode !== 0, runtime + ' invalid source unexpectedly compiled.')
        assert.equal(comparison.result.outputComplete, true, runtime + ' direct compiler cleanup was unverified.')
        assert.ok(comparison.result.stderr.includes(marker), runtime + ' direct compiler omitted its actual diagnostic.')
      }
      assert.deepEqual(session.requests, [], 'The offline fixture made a network request.')
      assert.deepEqual(session.errors, [])
    } catch (error) {
      primaryError = error
      report.failure = String(error?.stack ?? error).slice(0, 4000)
      throw error
    } finally {
      if (session) {
        const cleanup = []
        const capture = async (name, action) => {
          try { await action() } catch (error) { cleanup.push({ name, error: String(error?.message ?? error).slice(0, 1000) }) }
        }
        await capture('renderer-snapshot', async () => { report.renderer ??= await session.page.evaluate(() => globalThis.__ionCompilerBridgeRenderer?.snapshot()) })
        await capture('main-snapshot', async () => { report.main ??= await session.app.evaluate(() => globalThis.__ionCompilerBridgeMain?.snapshot()) })
        await capture('renderer-listener', () => session.page.evaluate(() => globalThis.__ionCompilerBridgeRenderer?.dispose()))
        await capture('main-hook', () => session.app.evaluate(() => globalThis.__ionCompilerBridgeMain?.restore()))
        await capture('comparison-hook', () => session.app.evaluate(() => { delete globalThis[Symbol.for('ion.test.compiler-parent-comparison')] }))
        await capture('normal-close', () => close(session))
        report.exit = { code: session.appProcess.exitCode, signal: session.appProcess.signalCode }
        await capture('exit-zero', async () => { assert.equal(session.appProcess.exitCode, 0); assert.equal(session.appProcess.signalCode, null) })
        await capture('known-native-pid', async () => {
          try { process.kill(session.pid, 0) } catch (error) {
            if (error.code === 'ESRCH') { report.nativePidGone = true; return }
            throw error
          }
          assert.fail('The known native Electron PID remained alive after normal close.')
        })
        report.cleanupErrors = cleanup
        if (cleanup.length && !primaryError) throw new Error('Compiler bridge cleanup failed: ' + JSON.stringify(cleanup))
      }
    }
  })
  report.passed = true
  console.log('PASS actual Windows compiler output through main execution and renderer IPC, offline and cleaned up')
} catch (error) {
  failure = error
  report.failure ??= String(error?.stack ?? error).slice(0, 4000)
} finally {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log('Compiler bridge evidence:', reportPath)
}
if (failure) throw failure
