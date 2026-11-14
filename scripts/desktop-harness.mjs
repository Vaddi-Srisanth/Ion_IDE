import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { nativePsEnvironment, parseIdentities } from './live-runtime-metrics.mjs'
import { familyFor, identityCpuPercent, parseMacFamilyRows, rememberLaunchMetrics } from './process-family.mjs'
import { installBenchmarkRun } from './run-completion.mjs'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
export const runnerMarker = 'ION-DESKTOP-RUN-OK'
export const testId = (name) => `[data-testid="${name}"]`
const backgroundEntry = fileURLToPath(new URL('./background-desktop.cjs', import.meta.url))

export const desktopWindowsVisible = () =>
  (process.env.ION_SHOW_TEST_WINDOWS ?? (process.env.CI === 'true' ? '1' : '0')) === '1'

export function requireVisibleDesktop() {
  assert.ok(desktopWindowsVisible(), 'This check opens native windows. Set ION_SHOW_TEST_WINDOWS=1 when you are ready to run it.')
}

export async function temporaryDirectory(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), `ion-${prefix}-`)))
}

export async function createProject(directory, { medium = false, fileCount = 10 } = {}) {
  await mkdir(directory, { recursive: true })
  const program = join(directory, 'program.c')
  const broken = join(directory, 'broken.c')
  const loop = join(directory, 'loop.c')
  const sampled = join(directory, 'sampled.c')
  const files = Array.from({ length: fileCount }, (_, index) =>
    join(directory, `notes-${String(index).padStart(2, '0')}.txt`))
  const text = (path) => `Ion fixture ${basename(path)}\n` + Array.from({ length: 650 }, (_, index) =>
    `Row ${String(index).padStart(3, '0')}: the quick brown fox jumps over the lazy dog.\n`).join('')

  await Promise.all([
    writeFile(program, `#include <stdio.h>\nint main(void) { puts("${runnerMarker}"); return 0; }\n`),
    writeFile(broken, 'int main(void) { return 0 }\n'),
    writeFile(loop, 'int main(void) { for (;;) {} }\n'),
    writeFile(sampled, '#define _POSIX_C_SOURCE 199309L\n#include <stdio.h>\n#include <time.h>\nint main(void) { const struct timespec wait = {0, 350000000}; nanosleep(&wait, NULL); puts("ION-DESKTOP-RUN-OK"); }\n'),
    ...files.map((file) => writeFile(file, text(file))),
  ])

  const directories = []
  if (medium) {
    for (let group = 0; group < 40; group += 1) {
      const path = join(directory, `module-${String(group).padStart(2, '0')}`)
      directories.push(path)
    }
    await Promise.all(directories.map(async (path) => {
      await mkdir(path)
      await Promise.all(Array.from({ length: 25 }, (_, index) => {
        const file = join(path, `source-${String(index).padStart(2, '0')}.txt`)
        return writeFile(file, `Ion module fixture ${basename(path)} ${basename(file)}\n`)
      }))
    }))
  }
  return { directory, program, broken, loop, sampled, files, directories }
}

export async function artifact(target) {
  const path = resolve(target)
  if (path.endsWith('.app')) {
    const { stdout } = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleExecutable',
      join(path, 'Contents/Info.plist')])
    return { path, executablePath: join(path, 'Contents/MacOS', stdout.trim()), args: [] }
  }
  const entry = path.endsWith('.cjs') ? path : join(path, 'main/index.cjs')
  return { path, executablePath: require('electron'), args: [entry] }
}

export async function launch(target, profile, { firstRun = false, args: launchArgs = [], startAt = 'welcome' } = {}) {
  const { executablePath, args } = target
  if (!firstRun) {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'preferences.json'), '{"version":1,"settings":{},"recents":[]}\n', { flag: 'wx' })
      .catch((error) => { if (error.code !== 'EEXIST') throw error })
  }
  const env = { ...process.env }
  delete env.ION_DEV_URL
  delete env.ELECTRON_RUN_AS_NODE
  const background = !desktopWindowsVisible()
  if (background) {
    assert.ok(args.length === 1, 'Background desktop checks need an unpackaged production build.')
    env.ION_TEST_ENTRY = args[0]
  }
  const began = performance.now()
  const app = await _electron.launch({
    executablePath, args: [`--user-data-dir=${profile}`, ...launchArgs, ...(background ? [backgroundEntry] : args)], env, timeout: 20_000,
  })
  const appProcess = app.process()
  const requests = []
  const errors = []
  app.context().on('request', (request) => {
    if (/^https?:|^wss?:/.test(request.url())) requests.push(request.url())
  })
  try {
    const page = await app.firstWindow({ timeout: 12_000 })
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(8_000)
    await page.getByTestId(startAt).waitFor()
    const startupMs = performance.now() - began
    if (background) {
      const visible = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()))
      assert.equal(visible, false, 'A background test window became visible or took focus.')
    }
    const identity = await app.evaluate(({ app }) => ({ profile: app.getPath('userData'), pid: process.pid,
      processes: app.getAppMetrics().map(({ pid, creationTime }) => ({ pid, creationTime })) }))
    assert.equal(identity.profile, profile, 'app uses disposable profile')
    assert.equal(page.url(), 'app://workbench/index.html', 'production renderer loaded from the local app protocol')
    const session = { app, appProcess, page, profile, startupMs, requests, errors, pid: identity.pid,
      mainCreationTime: identity.processes.find(p => p.pid === identity.pid)?.creationTime,
      executablePath: await realpath(executablePath) }
    rememberLaunchMetrics(session, identity.processes)
    return session
  } catch (error) {
    await close({ app, appProcess }).catch(() => {})
    throw error
  }
}

export async function close(session) {
  const proc = session.appProcess ?? session.app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = once(proc, 'exit')
  const output = []
  const observeConsole = (message) => {
    output.push({ type: message.type(), text: message.text().slice(0, 1000) })
    if (output.length > 12) output.shift()
  }
  session.app.on('console', observeConsole)
  let setupDiagnosticError
  await session.app.evaluate(({ app, BrowserWindow }) => {
    const events = []
    const record = (name, prevented) => {
      events.push({ name, prevented, time: Date.now() })
      if (events.length > 16) events.shift()
    }
    const before = event => record('before-quit', event.defaultPrevented)
    const will = event => record('will-quit', event.defaultPrevented)
    app.on('before-quit', before)
    app.on('will-quit', will)
    const windows = BrowserWindow.getAllWindows().map(window => {
      const closing = event => record('window-close', event.defaultPrevented)
      const closed = () => record('window-closed')
      window.on('close', closing)
      window.on('closed', closed)
      return { window, closing, closed }
    })
    globalThis.ionShutdownDiagnostics = { events, cleanup() {
      app.removeListener('before-quit', before)
      app.removeListener('will-quit', will)
      for (const { window, closing, closed } of windows) {
        window.removeListener('close', closing)
        window.removeListener('closed', closed)
      }
      delete globalThis.ionShutdownDiagnostics
    } }
  }).catch(reason => { setupDiagnosticError = String(reason.message).slice(0, 1000) })
  // Keep the inspector attached while the renderer confirms the window close.
  // Wait for the actual app process, including the asynchronous runner drain.
  let quitError
  let quitState = 'pending'
  void session.app.evaluate(({ app }) => app.quit()).then(() => { quitState = 'resolved' }, error => { quitError = error; quitState = 'rejected' })
  let timer
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Desktop app did not quit within 8 seconds.')), 8000)
      }),
    ])
  } catch (error) {
    const lifecycle = await Promise.race([
      session.app.evaluate(({ BrowserWindow }) => ({
        events: globalThis.ionShutdownDiagnostics?.events,
        windows: BrowserWindow.getAllWindows().slice(0, 16).map(window => ({
          destroyed: window.isDestroyed(), loading: window.webContents.isLoadingMainFrame(),
          crashed: window.webContents.isCrashed(),
        })),
        handles: process._getActiveHandles().slice(0, 64).map(handle => handle.constructor.name),
        requests: process._getActiveRequests().slice(0, 64).map(request => request.constructor.name),
      })).then(value => ({ state: 'available', value }), reason => ({ state: 'error', error: String(reason.message).slice(0, 1000) })),
      sleep(300, { state: 'timeout' }, { ref: false }),
    ])
    if (lifecycle) console.error('Desktop shutdown lifecycle:', lifecycle)
    const dialogs = session.page && await Promise.race([
      session.page.locator('dialog[open]').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))
        .then(value => ({ state: 'available', value }), reason => ({ state: 'error', error: String(reason.message).slice(0, 1000) })),
      sleep(300, { state: 'timeout' }, { ref: false }),
    ])
    if (dialogs) console.error('Dialog diagnostic at shutdown:', dialogs)
    if (quitError) console.error('Failed to request desktop shutdown:', quitError.message)
    if (output.length) console.error('Recent desktop console messages:', output)
    error.desktopShutdown = { error: error.message, lifecycle, dialogs, console: output, setupDiagnosticError,
      quitRequest: { state: quitState, message: quitError && String(quitError.message).slice(0, 1000) } }
    if (session.onShutdownFailure) await session.onShutdownFailure(error.desktopShutdown).catch(reason =>
      console.error('Shutdown failure receipt unavailable:', reason?.message ?? reason))
    if (proc.exitCode === null && proc.signalCode === null) {
      if (process.platform === 'win32') {
        // A failed disposable test may leave a close-confirmation open. Killing
        // just Electron's main process orphans Chromium children with open
        // profile databases. Terminate the owned tree before the parent exits.
        await execute('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
          windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024,
        }).catch(cleanupError => {
          if (proc.exitCode === null && proc.signalCode === null) throw new AggregateError(
            [error, cleanupError], 'Desktop shutdown failed and its process tree could not be terminated.')
        })
      } else proc.kill('SIGKILL')
      await exited
    }
    throw error
  } finally {
    clearTimeout(timer)
    session.app.removeListener('console', observeConsole)
    if (proc.exitCode === null && proc.signalCode === null) {
      await session.app.evaluate(() => globalThis.ionShutdownDiagnostics?.cleanup()).catch(() => {})
    }
  }
}

export async function stubDialogs(app, choices) {
  await app.evaluate(({ dialog }, data) => {
    dialog.showOpenDialog = async (_window, options) => {
      const path = options?.properties?.includes('openDirectory') ? data.folder : data.file
      return { canceled: !path, filePaths: path ? [path] : [] }
    }
    dialog.showSaveDialog = async () => ({ canceled: !data.save, filePath: data.save })
    dialog.showMessageBox = async (_window, options) => {
      const buttons = options?.buttons ?? []
      const runIndex = buttons.findIndex((label) => /^Run(?: (?:C )?Program| (?:Maven|Gradle|C\/C\+\+) Build)?$/i.test(label))
      const testIndex = buttons.findIndex((label) => /^(Approve|Run) Test$/.test(label))
      const automaticIndex = buttons.indexOf('Enable Automatic Test')
      const gitIndex = buttons.indexOf('Trust Repository')
      const approved = gitIndex >= 0 && data.allowGit ? gitIndex : automaticIndex >= 0 && data.allowAutomatic ? automaticIndex
        : runIndex >= 0 && data.allowRun ? runIndex : testIndex >= 0 && data.allowProjectTests ? testIndex : -1
      const response = approved >= 0 ? approved : (options?.cancelId ?? 0)
      return { response, checkboxChecked: false }
    }
  }, choices)
}

export function atPath(page, name, path) {
  return page.locator(`${testId(name)}[data-path=${JSON.stringify(path)}]`)
}

export async function openFolder(page, project) {
  await page.getByTestId('welcome').getByTestId('open-folder').click()
  await page.getByTestId('workspace').waitFor()
  await atPath(page, 'explorer-entry', project.program).waitFor()
}

export async function openFromExplorer(page, path, expected) {
  const start = performance.now()
  await atPath(page, 'explorer-entry', path).click()
  await atPath(page, 'tab', path).waitFor()
  await editorShows(page, expected)
  return performance.now() - start
}

export function editorShows(page, expected) {
  return page.waitForFunction((needle) => {
    const lines = document.querySelector('.monaco-editor .view-lines')
    return lines?.textContent?.replace(/\u00a0/g, ' ').includes(needle)
  }, expected, { timeout: 8000 })
}

export async function runProgram(page) {
  const run = page.getByTestId('run')
  // This fixture is a single C source without a native-project build config.
  // Compilation has its own 15s application limit followed by up to 4s verified
  // Windows helper cleanup. The interactive program has its existing 5min limit
  // and 3.5s helper guard. A 15s overall success-only wait raced the compiler's
  // own deadline and also hid terminal failures until that deadline expired.
  await page.evaluate(installBenchmarkRun, { preparing: 15_000, compiling: 15_000 + 4_000, running: 300_000 + 3_500,
    expectedMarker: runnerMarker })
  try {
    const start = performance.now()
    await run.click()
    const result = await page.evaluate(() => window.ionBenchmarkRunCompletion)
    assert.ok(!result.failure, JSON.stringify(result))
    assert.equal(result.status, 'success', JSON.stringify(result))
    assert.ok(result.text?.includes('ION-DESKTOP-RUN-OK'), JSON.stringify(result))
    return performance.now() - start
  } finally {
    await page.evaluate(() => window.ionBenchmarkRunCleanup?.()).catch(() => {})
  }
}

export async function waitForFile(readFile, path, expected, timeoutMs = 5000) {
  const end = performance.now() + timeoutMs
  while (performance.now() < end) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (text.includes(expected)) return
    await sleep(40)
  }
  throw new Error(`Disk verification failed for ${basename(path)}; expected ${JSON.stringify(expected)}.`)
}

export async function eventually(check, message, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs
  do {
    if (await check()) return
    await sleep(40)
  } while (performance.now() < deadline)
  assert.fail(message)
}

export async function withScratch(prefix, run) {
  const scratch = await temporaryDirectory(prefix)
  let failure
  try {
    return await run(scratch)
  } catch (error) {
    failure = error
    throw error
  } finally {
    try { await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    catch (error) {
      if (failure) throw new AggregateError([failure, error], 'The workload failed and its disposable files could not be removed.')
      throw error
    }
  }
}

export async function resourceSnapshot(session, { details = false } = {}) {
  const { stdout } = await execute('/bin/ps', ['-axww', '-o', 'pid=,ppid=,rss=,time=,lstart=,command='],
    { maxBuffer: 6_000_000, env: nativePsEnvironment() })
  const family = familyFor(session, 'darwin')
  const selected = family.select(parseMacFamilyRows(stdout))
  let appProcesses = selected.members
  if (appProcesses.length) {
    let identities
    try {
      identities = parseIdentities((await execute('/bin/ps', ['-ww', '-p', appProcesses.map(p => p.pid).join(','), '-o', 'pid=,lstart='],
        { env: nativePsEnvironment(), maxBuffer: 128_000 })).stdout)
    } catch (error) {
      if (error.code !== 1) throw error
      identities = parseIdentities(error.stdout ?? '')
    }
    appProcesses = appProcesses.filter(p => identities.get(p.pid) === p.started)
  }
  const kind = p => family.kind(p)
  const nativeChildren = appProcesses.filter(p => kind(p) === 'child')
  const childRssMiB = nativeChildren.reduce((total, p) => total + p.rssMiB, 0)
  return {
    timeMs: performance.now(),
    rootAlive: selected.rootAlive && appProcesses.some(p => p.pid === session.pid),
    childRssMiB,
    ideRssMiB: appProcesses.reduce((total, p) => total + p.rssMiB, 0) - childRssMiB,
    rssMiB: appProcesses.reduce((total, p) => total + p.rssMiB, 0),
    cpuSecondsByPid: Object.fromEntries(appProcesses.map(p => [p.pid, p.cpuSeconds])),
    cpuSecondsByIdentity: Object.fromEntries(appProcesses.map(p => [p.pid + ':' + p.started, p.cpuSeconds])),
    processes: appProcesses.map(kind),
    ...(details && { members: appProcesses.map(p => ({
      pid: p.pid, parent: p.parent, started: p.started, startedMs: p.startedMs,
      kind: kind(p), rssMiB: p.rssMiB, cpuSeconds: p.cpuSeconds,
      ...(kind(p) === 'child' && { name: basename(p.command.split(' ', 1)[0]) }),
    })) }),
  }
}

export function cpuPercent(first, last) { return identityCpuPercent(first, last) }

export { dirname, mkdir, sleep }
