import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { cpus, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, eventually, launch, openFolder, openFromExplorer, runProgram,
  sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { pdfFixture } from './viewer-fixtures.mjs'
import { windowsProcessTree, windowsTreeCPU } from './windows/process-tree.mjs'

assert.equal(process.platform, 'win32', 'Run the Windows benchmark on Windows.')
const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, label: { type: 'string', default: 'candidate' },
  terminal: { type: 'boolean' }, trials: { type: 'string', default: '3' },
  'idle-ms': { type: 'string', default: '3000' }, 'soak-ms': { type: 'string', default: '60000' },
  out: { type: 'string' },
} })
const trials = Number(values.trials)
const idleMs = Number(values['idle-ms'])
const soakMs = Number(values['soak-ms'])
assert.ok(Number.isInteger(trials) && trials >= 2 && trials <= 10 && idleMs >= 1000 && soakMs >= 10000)
const output = resolve(values.out ?? `performance-results/windows-${values.label}.json`)
const target = await artifact(values.target)
const samples = []
const report = {
  complete: false,
  host: { platform: process.platform, release: release(), arch: process.arch, memoryBytes: totalmem(), cpu: cpus()[0]?.model },
  source: { commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
  protocol: { trials, idleMs, soakMs }, label: values.label, samples,
}
async function saveReport() {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
async function boundedDiagnostic(action) {
  let timer
  try {
    return await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Diagnostic exceeded four seconds.')), 4000)
    })])
  } catch (error) { return { unavailable: String(error?.message ?? error).slice(0, 500) } }
  finally { clearTimeout(timer) }
}
async function captureFailure(session, observer) {
  const [renderer, windows, processes] = await Promise.all([
    boundedDiagnostic(() => session.page.evaluate(() => {
      const text = (selector, limit) => document.querySelector(selector)?.textContent?.slice(-limit) ?? null
      const output = document.querySelector('[data-testid="output"]')
      return { phase: output?.getAttribute('data-phase'), status: output?.getAttribute('data-status'),
        footer: text('.run-console-footer', 1500), transcript: text('.run-console .xterm-rows', 5000),
        runStatus: text('[data-testid="run-status"]', 500),
        runDisabled: document.querySelector('[data-testid="run"]')?.disabled,
        dialogs: [...document.querySelectorAll('[role="dialog"], dialog[open]')].slice(0, 6)
          .map(node => node.textContent?.slice(0, 1000)),
        lastRunIPCEvents: globalThis.ionWindowsBenchmarkRunEvents?.slice(-24) ?? [] }
    })),
    boundedDiagnostic(() => session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().slice(0, 8)
      .map(window => ({ id: window.id, modal: window.isModal(), visible: window.isVisible(),
        title: window.getTitle().slice(0, 300), url: window.webContents.getURL().slice(0, 300) })))),
    boundedDiagnostic(() => windowsProcessTree(session)),
  ])
  return { renderer, windows, processes, console: observer.console.slice(-24), stderr: observer.stderr,
    errors: session.errors.slice(-24).map(text => String(text).slice(0, 500)),
    networkRequests: session.requests.slice(-24).map(text => String(text).slice(0, 500)),
    applicationExit: { code: session.appProcess.exitCode, signal: session.appProcess.signalCode } }
}
const median = (array) => {
  const sorted = [...array].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function measure(session) {
  await sleep(650)
  const first = await windowsProcessTree(session)
  await sleep(idleMs)
  const last = await windowsProcessTree(session)
  return { workingSetMiB: last.workingSetMiB, privateMiB: last.privateMiB, cpuPercent: windowsTreeCPU(first, last), last }
}

const children = (snapshot) => snapshot.members.filter(({ kind }) => kind === 'child')
async function noChildren(session, idleChildren) {
  await eventually(async () => children(await windowsProcessTree(session)).every(({ pid }) => idleChildren.has(pid)),
    'Expected zero native child processes.', 18_000)
}

await withScratch('windows-bench', async (scratch) => {
  const project = await createProject(join(scratch, 'benchmark workspace'), { medium: true })
  const pdf = join(project.directory, 'local study.pdf')
  const waiting = join(project.directory, 'waiting.js')
  await writeFile(pdf, pdfFixture(2))
  await writeFile(waiting, "console.log('ION-BENCH-WAIT'); setInterval(() => {}, 1000)\n")
  for (let i = 0; i < trials; i++) {
    const sample = { trial: i + 1, complete: false, phase: 'fresh-launch' }
    samples.push(sample)
    await saveReport()
    const profile = join(scratch, 'profile-' + i)
    const first = await launch(target, profile)
    const fresh = first.startupMs
    await close(first)
    const session = await launch(target, profile)
    const observer = { console: [], stderr: '' }
    const observeConsole = message => {
      observer.console.push({ type: message.type(), text: message.text().slice(0, 500) })
      if (observer.console.length > 24) observer.console.shift()
    }
    const observeStderr = chunk => { observer.stderr = (observer.stderr + chunk).slice(-4096) }
    session.page.on('console', observeConsole)
    session.appProcess.stderr?.on('data', observeStderr)
    let primaryError
    try {
      const { app, page } = session
      Object.assign(sample, { freshMs: fresh, warmMs: session.startupMs, phase: 'welcome' })
      await page.evaluate(() => {
        const events = globalThis.ionWindowsBenchmarkRunEvents = []
        window.ion.runConsole.onUpdate(({ id, update }) => {
          events.push({ id, update: update.kind === 'data' ? { ...update, text: update.text.slice(-500) } : update })
          if (events.length > 24) events.shift()
        })
      })
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory, allowRun: true })
      sample.welcome = await measure(session)
      await saveReport()
      const idleChildren = new Set()
      for (const child of children(sample.welcome.last)) {
        // Windows may attach a host console to the desktop test launch. It is
        // part of the measured tree, but is distinct from a launched program.
        assert.match(child.name, /^(?:conhost|openconsole)\.exe$/i, JSON.stringify(sample.welcome.last.members))
        idleChildren.add(child.pid)
      }
      await openFolder(page, project)
      sample.firstSourceMs = await openFromExplorer(page, project.program, 'ION-DESKTOP-RUN-OK')
      sample.oneFile = await measure(session)
      sample.phase = 'one-file'
      await saveReport()
      for (const note of project.files.slice(0, 9)) await openFromExplorer(page, note, `Ion fixture ${basename(note)}`)
      assert.equal(await page.getByTestId('tab').count(), 10)
      sample.tenTabs = await measure(session)
      sample.phase = 'ten-tabs'
      await saveReport()
      for (const directory of project.directories.slice(0, 6)) await atPath(page, 'explorer-entry', directory).click()
      sample.medium = await measure(session)
      sample.phase = 'medium-workspace'
      await saveReport()

      await atPath(page, 'explorer-entry', pdf).click()
      await page.locator('[data-rendered=true] [data-testid=pdf-page-canvas]').first().waitFor()
      sample.pdf = await measure(session)
      sample.phase = 'pdf'
      await saveReport()
      await atPath(page, 'close-tab', pdf).click()
      await noChildren(session, idleChildren)

      await atPath(page, 'tab', project.program).locator('.tab-name').click()
      sample.phase = 'run-program'
      await saveReport()
      sample.runMs = await runProgram(page)
      await openFromExplorer(page, waiting, 'ION-BENCH-WAIT')
      await page.getByTestId('run').click()
      await page.locator('[data-testid="output"][data-phase="running"]').waitFor()
      sample.running = await measure(session)
      sample.phase = 'running-program'
      await saveReport()
      await page.getByTestId('run-console-stop').click()
      await page.locator('[data-testid="output"][data-status="cancelled"]').waitFor()
      await noChildren(session, idleChildren)

      if (values.terminal) {
        await page.getByTestId('bottom-terminal-tab').click()
        const input = page.getByTestId('terminal-input')
        await input.waitFor()
        const renderedShell = '[data-testid="terminal-pane"] .xterm-rows'
        await (await page.waitForFunction((selector) => /[a-z]:\\[^>]*>/i.test(document.querySelector(selector)?.textContent ?? ''),
          renderedShell, { timeout: 15_000 })).dispose()
        sample.terminal = await measure(session)
        sample.phase = 'terminal'
        await saveReport()
        const terminalChildren = children(sample.terminal.last)
        assert.ok(terminalChildren.some(({ name }) => /^ion-pty\.exe$/i.test(name)), 'Real Windows PTY helper is running.')
        assert.ok(terminalChildren.some(({ name }) => /^cmd\.exe$/i.test(name)), 'System Command Prompt is running.')
        await page.getByTestId('terminal-close').click()
        await noChildren(session, idleChildren)
        sample.terminalClosed = await measure(session)
        sample.phase = 'terminal-closed'
        await saveReport()
      }

      if (i === trials - 1) {
        const started = performance.now()
        sample.soak = []
        sample.phase = 'soak'
        while (performance.now() - started < soakMs) {
          for (const note of project.files.slice(0, 3)) await atPath(page, 'tab', note).locator('.tab-name').click()
          await atPath(page, 'tab', project.program).locator('.tab-name').click()
          await runProgram(page)
          await noChildren(session, idleChildren)
          sample.soak.push(await windowsProcessTree(session))
          await saveReport()
          await sleep(800)
        }
        sample.soakSeconds = (performance.now() - started) / 1000
      }
      assert.deepEqual(session.requests, [])
      assert.deepEqual(session.errors, [])
      sample.complete = true
      sample.phase = 'complete'
      await saveReport()
      console.log('Recorded Windows sample ' + (i + 1))
    } catch (error) {
      primaryError = error
      sample.failure = { phase: sample.phase, name: error?.name, message: String(error?.message ?? error).slice(0, 2000) }
      sample.diagnostics = await captureFailure(session, observer)
      await saveReport().catch(reason => console.error('Partial benchmark receipt unavailable:', reason?.message ?? reason))
      console.error('PRIMARY WINDOWS BENCHMARK FAILURE:', JSON.stringify({ failure: sample.failure, diagnostics: sample.diagnostics }))
      throw error
    } finally {
      session.page.removeListener('console', observeConsole)
      session.appProcess.stderr?.removeListener('data', observeStderr)
      try {
        await close(session)
        await eventually(async () => (await windowsProcessTree(session)).members.length === 0,
          'The Windows process tree did not exit.', 18_000)
      } catch (error) {
        if (!primaryError) throw error
        console.error('Benchmark teardown warning after primary failure:', error?.message ?? error)
      }
    }
  }
})
const summary = Object.fromEntries(['freshMs', 'warmMs', 'firstSourceMs', 'runMs'].map((key) => [key, median(samples.map((sample) => sample[key]))]))
for (const stage of ['welcome', 'oneFile', 'tenTabs', 'medium', 'pdf', 'running', 'terminal', 'terminalClosed']) {
  if (!samples[0][stage]) continue
  summary[stage] = Object.fromEntries(['workingSetMiB', 'privateMiB', 'cpuPercent']
    .map((key) => [key, median(samples.map((sample) => sample[stage][key]))]))
}
report.complete = true
report.summary = summary
await saveReport()
console.log(JSON.stringify(summary, null, 2))
console.log(output)
