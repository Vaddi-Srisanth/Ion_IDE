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
    const profile = join(scratch, 'profile-' + i)
    const first = await launch(target, profile)
    const fresh = first.startupMs
    await close(first)
    const session = await launch(target, profile)
    try {
      const { app, page } = session
      const sample = { freshMs: fresh, warmMs: session.startupMs }
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory, allowRun: true })
      sample.welcome = await measure(session)
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
      for (const note of project.files.slice(0, 9)) await openFromExplorer(page, note, `Ion fixture ${basename(note)}`)
      assert.equal(await page.getByTestId('tab').count(), 10)
      sample.tenTabs = await measure(session)
      for (const directory of project.directories.slice(0, 6)) await atPath(page, 'explorer-entry', directory).click()
      sample.medium = await measure(session)

      await atPath(page, 'explorer-entry', pdf).click()
      await page.locator('[data-rendered=true] [data-testid=pdf-page-canvas]').first().waitFor()
      sample.pdf = await measure(session)
      await atPath(page, 'close-tab', pdf).click()
      await noChildren(session, idleChildren)

      await atPath(page, 'tab', project.program).locator('.tab-name').click()
      sample.runMs = await runProgram(page)
      await openFromExplorer(page, waiting, 'ION-BENCH-WAIT')
      await page.getByTestId('run').click()
      await page.locator('[data-testid="output"][data-phase="running"]').waitFor()
      sample.running = await measure(session)
      await page.getByTestId('run-console-stop').click()
      await page.locator('[data-testid="output"][data-status="cancelled"]').waitFor()
      await noChildren(session, idleChildren)

      if (values.terminal) {
        await page.getByTestId('bottom-terminal-tab').click()
        const input = page.getByTestId('terminal-input')
        await input.waitFor()
        const renderedShell = '[data-testid="terminal-pane"] .xterm-rows'
        await (await page.waitForFunction((selector) => /PS .*?>/.test(document.querySelector(selector)?.textContent ?? ''),
          renderedShell, { timeout: 15_000 })).dispose()
        sample.terminal = await measure(session)
        const terminalChildren = children(sample.terminal.last)
        assert.ok(terminalChildren.some(({ name }) => /^ion-pty\.exe$/i.test(name)), 'Real Windows PTY helper is running.')
        assert.ok(terminalChildren.some(({ name }) => /^powershell\.exe$/i.test(name)), 'System PowerShell is running.')
        await page.getByTestId('terminal-close').click()
        await noChildren(session, idleChildren)
        sample.terminalClosed = await measure(session)
      }

      if (i === trials - 1) {
        const started = performance.now()
        sample.soak = []
        while (performance.now() - started < soakMs) {
          for (const note of project.files.slice(0, 3)) await atPath(page, 'tab', note).locator('.tab-name').click()
          await atPath(page, 'tab', project.program).locator('.tab-name').click()
          await runProgram(page)
          await noChildren(session, idleChildren)
          sample.soak.push(await windowsProcessTree(session))
          await sleep(800)
        }
        sample.soakSeconds = (performance.now() - started) / 1000
      }
      assert.deepEqual(session.requests, [])
      assert.deepEqual(session.errors, [])
      samples.push(sample)
      console.log('Recorded Windows sample ' + (i + 1))
    } finally {
      await close(session)
      await eventually(async () => (await windowsProcessTree(session)).members.length === 0,
        'The Windows process tree did not exit.', 18_000)
    }
  }
})
const summary = Object.fromEntries(['freshMs', 'warmMs', 'firstSourceMs', 'runMs'].map((key) => [key, median(samples.map((sample) => sample[key]))]))
for (const stage of ['welcome', 'oneFile', 'tenTabs', 'medium', 'pdf', 'running', 'terminal', 'terminalClosed']) {
  if (!samples[0][stage]) continue
  summary[stage] = Object.fromEntries(['workingSetMiB', 'privateMiB', 'cpuPercent']
    .map((key) => [key, median(samples.map((sample) => sample[stage][key]))]))
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  host: { platform: process.platform, release: release(), arch: process.arch, memoryBytes: totalmem(), cpu: cpus()[0]?.model },
  protocol: { trials, idleMs, soakMs }, label: values.label, summary, samples,
}, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
console.log(output)
