import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { _electron } from 'playwright-core'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
export const runnerMarker = 'ION-DESKTOP-RUN-OK'
export const testId = (name) => `[data-testid="${name}"]`

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

export async function launch(target, profile) {
  const { executablePath, args } = target
  const env = { ...process.env }
  delete env.ION_DEV_URL
  delete env.ELECTRON_RUN_AS_NODE
  const began = performance.now()
  const app = await _electron.launch({
    executablePath, args: [`--user-data-dir=${profile}`, ...args], env, timeout: 20_000,
  })
  const requests = []
  const errors = []
  app.context().on('request', (request) => {
    if (/^https?:|^wss?:/.test(request.url())) requests.push(request.url())
  })
  try {
    const page = await app.firstWindow({ timeout: 12_000 })
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(8_000)
    await page.getByTestId('welcome').waitFor()
    const startupMs = performance.now() - began
    const identity = await app.evaluate(({ app }) => ({ profile: app.getPath('userData'), pid: process.pid }))
    assert.equal(identity.profile, profile, 'app uses disposable profile')
    assert.equal(page.url(), 'app://workbench/index.html', 'production renderer loaded from the local app protocol')
    return { app, page, profile, startupMs, requests, errors, pid: identity.pid }
  } catch (error) {
    await close({ app }).catch(() => {})
    throw error
  }
}

export async function close(session) {
  const proc = session.app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = once(proc, 'exit')
  // Keep the inspector attached while the renderer confirms the window close.
  // Wait for the actual app process, including the asynchronous runner drain.
  void session.app.evaluate(({ app }) => app.quit()).catch(() => {})
  let timer
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Desktop app did not quit within 8 seconds.')), 8000)
      }),
    ])
  } catch (error) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL')
      await exited
    }
    throw error
  } finally {
    clearTimeout(timer)
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
      const approved = automaticIndex >= 0 && data.allowAutomatic ? automaticIndex : runIndex >= 0 && data.allowRun ? runIndex : testIndex >= 0 && data.allowProjectTests ? testIndex : -1
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
  await page.evaluate(() => {
    window.ionBenchmarkRunStarted = false
    const observer = new MutationObserver(() => {
      const output = document.querySelector('[data-testid="output"]')
      if (['preparing', 'compiling', 'running'].includes(output?.getAttribute('data-phase'))) {
        window.ionBenchmarkRunStarted = true
      }
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase'] })
    window.ionBenchmarkRunCleanup = () => {
      observer.disconnect()
      delete window.ionBenchmarkRunStarted
      delete window.ionBenchmarkRunCleanup
    }
  })
  try {
    const start = performance.now()
    await run.click()
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="run"]')
      const output = document.querySelector('[data-testid="output"]')
      return window.ionBenchmarkRunStarted && button && !button.disabled && output?.dataset.status === 'success'
        && output.textContent?.includes('ION-DESKTOP-RUN-OK')
    }, undefined, { timeout: 15_000 })
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
  try {
    return await run(scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function resourceSnapshot(session, { details = false } = {}) {
  const { stdout } = await execute('/bin/ps', ['-axww', '-o', 'pid=,ppid=,rss=,time=,command='], { maxBuffer: 6_000_000 })
  const processes = stdout.trim().split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!match) return []
    const [, pid, parent, rss, cpu, command] = match
    const cpuSeconds = cpu.split(/[:-]/).map(Number).reverse().reduce((total, part, index) =>
      total + part * [1, 60, 3600, 86400][index], 0)
    return [{ pid: Number(pid), parent: Number(parent), rssMiB: Number(rss) / 1024, cpuSeconds, command }]
  })
  const owned = new Set([session.pid])
  for (const process of processes) {
    if (process.command.includes(`--user-data-dir=${session.profile}`)
      || process.command.includes(`--database=${session.profile}/`)) owned.add(process.pid)
  }
  let previousSize
  do {
    previousSize = owned.size
    for (const process of processes) if (owned.has(process.parent)) owned.add(process.pid)
  } while (owned.size > previousSize)
  const appProcesses = processes.filter((process) => owned.has(process.pid))
  const nativeChildren = appProcesses.filter(({ pid, command }) =>
    pid !== session.pid && !command.includes('--type=') && !command.includes('crashpad_handler'))
  const childRssMiB = nativeChildren.reduce((total, process) => total + process.rssMiB, 0)
  const kind = (process) => process.pid === session.pid ? 'main'
    : process.command.match(/--type=([^ ]+)/)?.[1] ?? (process.command.includes('crashpad_handler') ? 'crashpad' : 'child')
  return {
    timeMs: performance.now(),
    childRssMiB,
    ideRssMiB: appProcesses.reduce((total, process) => total + process.rssMiB, 0) - childRssMiB,
    rssMiB: appProcesses.reduce((total, process) => total + process.rssMiB, 0),
    cpuSecondsByPid: Object.fromEntries(appProcesses.map((process) => [process.pid, process.cpuSeconds])),
    processes: appProcesses.map(kind),
    ...(details && { members: appProcesses.map((process) => ({
      pid: process.pid,
      parent: process.parent,
      kind: kind(process),
      rssMiB: process.rssMiB,
      cpuSeconds: process.cpuSeconds,
      ...(kind(process) === 'child' && { name: basename(process.command.split(' ', 1)[0]) }),
    })) }),
  }
}

export function cpuPercent(first, last) {
  const delta = Object.entries(last.cpuSecondsByPid).reduce((total, [pid, seconds]) =>
    total + Math.max(0, seconds - (first.cpuSecondsByPid[pid] ?? seconds)), 0)
  return 100_000 * delta / (last.timeMs - first.timeMs)
}

export { dirname, mkdir, sleep }
