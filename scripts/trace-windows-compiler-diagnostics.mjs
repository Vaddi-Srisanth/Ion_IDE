import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, close, createProject, launch, openFolder, openFromExplorer, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const reportPath = resolve('performance-results/windows-compiler-bridge.json')
const marker = 'ION-COMPILER-BRIDGE-DIAGNOSTIC'
const id = randomUUID()
const report = { platform: process.platform, architecture: process.arch, id, marker,
  scope: 'Real renderer IPC and main compiler engine; not an assertion about terminal painting.',
  passed: false, cleanupErrors: [], sessionLaunched: false }
let failure
try {
  assert.equal(process.platform, 'win32', 'Run this diagnostic fixture on genuine Windows.')
  const target = await artifact(values.target)
  await withScratch('windows-compiler-bridge', async scratch => {
    let session, primaryError
    try {
      const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
      await writeFile(project.program, '#error ' + marker + '\nint main(void) { return 0; }\n')
      session = await launch(target, join(scratch, 'profile'))
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
      })
      report.chosenCompiler = report.result.compiler ? basename(report.result.compiler) : null
      report.renderer = await page.evaluate(() => globalThis.__ionCompilerBridgeRenderer.snapshot())
      report.main = await app.evaluate(() => globalThis.__ionCompilerBridgeMain.snapshot())
      assert.equal(report.result.status, 'compile-error')
      assert.ok(report.result.compileOutput.includes(marker), 'Raw RunResult omitted the real compiler diagnostic.')
      assert.ok(report.renderer.compilerData.includes(marker), 'Renderer compiler-data events omitted the real diagnostic.')
      assert.equal(report.result.outputComplete, true, 'Compiler output cleanup was not verified.')
      assert.ok(report.main.events.some(event => event.stage === 'compiler-output' && event.event === 'bytes' && event.value > 0))
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
