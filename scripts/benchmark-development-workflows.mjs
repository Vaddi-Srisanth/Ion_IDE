import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, release, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { artifact, atPath, close, editorShows, eventually, launch, openFolder, openFromExplorer, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { developmentFixture, processTree, testSpec, waitForChildren } from './development-workflow-fixtures.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' }, baseline: { type: 'string' },
  trials: { type: 'string', default: '3' }, 'soak-seconds': { type: 'string', default: '60' },
  out: { type: 'string', default: 'performance-results/development-workflows.json' } } })
const trials = Number(values.trials)
const soakSeconds = Number(values['soak-seconds'])
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 8)
assert.ok(Number.isInteger(soakSeconds) && soakSeconds >= 0 && soakSeconds <= 14_400)
const win = process.platform === 'win32'
assert.ok(win || process.platform === 'darwin', 'Use a native macOS or Windows desktop for this benchmark.')
const execute = promisify(execFile)
const mb = 1024 ** 2
const candidate = await artifact(values.target)
const baseline = values.baseline ? await artifact(values.baseline) : undefined
const output = resolve(values.out)
await mkdir(dirname(output), { recursive: true })
const hash = async (target) => createHash('sha256').update(await readFile(join(target.path, 'main/index.cjs'))).digest('hex')
const report = {
  complete: false,
  time: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, release: release(),
    cpu: cpus()[0]?.model, ramBytes: totalmem() },
  protocol: { trials, soakSeconds, idleMs: 1_400, fixture: '1000 files, 10 open tabs, 7,000-line diff, 4 C cases',
    memory: win ? 'summed working set and private bytes, per-process CIM and Get-Process counters' : 'summed RSS and per-process macOS-attributed footprint',
    cpu: 'delta over settled samples as percent of a logical core. CPU in processes that exit between probes is excluded.',
    input: 'keypress to second renderer animation callback. Physical screen presentation is outside the measurement.' },
  builds: { candidate: await hash(candidate), ...(baseline && { baseline: await hash(baseline) }) },
  samples: { candidate: [], baseline: [] },
}

await withScratch('development-bench', async (scratch) => {
  const probe = join(scratch, 'resource-probe')
  if (!win) await execute('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  async function snapshot(session) {
    const tree = await processTree(session)
    if (win) return tree
    const { stdout } = await execute(probe, tree.members.map(({ pid }) => String(pid)))
    const ledger = new Map(stdout.trim().split('\n').map(row => {
      const [pid, bytes, ns] = row.trim().split(/\s+/).map(Number)
      return [pid, { footprintMiB: bytes / mb, cpuSeconds: ns / 1e9 }]
    }))
    const members = tree.members.flatMap(member => ledger.has(member.pid) ? [{ ...member, ...ledger.get(member.pid) }] : [])
    return { timeMs: tree.timeMs, rssMiB: members.reduce((sum, item) => sum + item.rssMiB, 0),
      footprintMiB: members.reduce((sum, item) => sum + item.footprintMiB, 0), members }
  }
  function withCpu(first, last) {
    const prior = new Map(first.members.map(({ pid, cpuSeconds }) => [pid, cpuSeconds]))
    const seconds = last.members.reduce((sum, { pid, cpuSeconds }) => sum + Math.max(0, cpuSeconds - (prior.get(pid) ?? cpuSeconds)), 0)
    return { ...last, cpuPercent: seconds * 100_000 / (last.timeMs - first.timeMs) }
  }
  async function idle(session) {
    const first = await snapshot(session)
    await sleep(report.protocol.idleMs)
    return withCpu(first, await snapshot(session))
  }
  async function marker(page, action, waitFor) {
    const started = performance.now()
    await action()
    await waitFor()
    return performance.now() - started
  }
  async function responsiveness(page, project) {
    const source = atPath(page, 'tab', project.program).locator('.tab-name')
    const note = atPath(page, 'tab', project.files[0]).locator('.tab-name')
    const line = page.getByTestId('editor').locator('.view-line').first()
    const tabMs = []
    for (let cycle = 0; cycle < 4; cycle++) {
      tabMs.push(await marker(page, () => note.click(), () => editorShows(page, 'Ion fixture')))
      tabMs.push(await marker(page, () => source.click(), () => editorShows(page, '#include')))
    }
    await line.click()
    await page.keyboard.press(win ? 'End' : 'Meta+ArrowRight')
    await page.evaluate(() => {
      window.ionFixtureKey = new Promise(resolveKey => window.addEventListener('keydown', () => {
        const start = performance.now()
        requestAnimationFrame(() => requestAnimationFrame(() => resolveKey(performance.now() - start)))
      }, { once: true, capture: true }))
    })
    await page.keyboard.press('x')
    await page.waitForFunction(() => document.querySelector('[data-testid="editor"] .view-line').textContent.endsWith('x'))
    const typingMs = await page.evaluate(() => window.ionFixtureKey)
    await page.keyboard.press((win ? 'Control' : 'Meta') + '+z')
    await page.waitForFunction(() => !document.querySelector('[data-testid="editor"] .view-line').textContent.endsWith('x'))
    await page.getByTestId('save-file').click()
    await atPath(page, 'tab', project.program).locator('.tab-dirty').waitFor({ state: 'detached' })
    await note.click()
    await line.click()
    await page.keyboard.press(win ? 'Control+Home' : 'Meta+ArrowUp')
    await line.hover()
    const top = await line.innerText()
    const scrollMs = await marker(page, () => page.mouse.wheel(0, 1250), () => page.waitForFunction(initial =>
      document.querySelector('[data-testid="editor"] .view-line')?.innerText !== initial, top))
    await page.keyboard.press(win ? 'Control+Home' : 'Meta+ArrowUp')
    await editorShows(page, 'Ion fixture')
    return { tabMs, typingMs, scrollMs }
  }
  async function sample(target, label, index) {
    const profile = join(scratch, `${label}-profile-${index}`)
    const project = await developmentFixture(join(scratch, `${label} repo ${index}`), { medium: true })
    await mkdir(profile)
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
      settings: { resourceProfile: 'minimal', autoSave: false, showOutput: true, openFullScreen: false } }))
    const first = await launch(target, profile)
    const freshMs = first.startupMs
    await close(first)
    const session = await launch(target, profile)
    const { app, page } = session
    const result = { freshMs, warmMs: session.startupMs }
    const capture = async (key) => { await sleep(300); result[key] = await idle(session) }
    try {
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory, allowProjectTests: true, allowRun: true, allowGit: true })
      await capture('welcome')
      await openFolder(page, project)
      result.openSourceMs = await openFromExplorer(page, project.program, 'ION-DESKTOP-RUN-OK')
      await capture('oneFile')
      for (const note of project.files.slice(0, 9)) await openFromExplorer(page, note, 'Ion fixture ' + basename(note))
      assert.equal(await page.getByTestId('tab').count(), 10)
      await capture('tenTabs')
      for (const directory of project.directories.slice(0, 6)) await atPath(page, 'explorer-entry', directory).click()
      await capture('repoClosed')
      result.input = await responsiveness(page, project)
      assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(({ name }) => /SourceControl|ProjectTestsDialog/.test(name))), false)
      if (label === 'candidate') {
        const gitButton = page.getByTestId('toggle-source-control')
        const panel = page.getByTestId('source-control')
        const gitReady = panel.getByTestId('git-branch')
        result.openGitMs = await marker(page, async () => {
          await gitButton.click()
          await panel.getByTestId('git-trust').click()
        }, () => gitReady.waitFor())
        const diff = page.getByTestId('git-diff')
        const changed = panel.locator('[data-testid="git-open-diff"][data-git-path="large-diff.txt"]')
        await capture('gitOpen')
        const refresh = panel.getByTestId('git-refresh')
        result.gitRefreshMs = await marker(page, () => refresh.click(), () => eventually(() => refresh.isEnabled(), 'Git refresh did not finish.'))
        result.largeDiffMs = await marker(page, () => changed.click(), () => eventually(() =>
          diff.getByRole('button', { name: 'Next Change', exact: true }).isEnabled(), 'The large diff did not resolve changes.'))
        await diff.locator('.monaco-diff-editor').waitFor()
        await capture('largeDiff')
        await diff.getByTestId('git-diff-close').click()
        await gitButton.click()
        await panel.waitFor({ state: 'detached' })
        await capture('gitClosed')
        result.gitCycles = []
        for (let cycle = 0; cycle < 6; cycle++) {
          result.gitCycles.push(await marker(page, () => gitButton.click(), () => gitReady.waitFor()))
          await gitButton.click()
          await panel.waitFor({ state: 'detached' })
        }
        await capture('gitRepeatedClosed')

        const root = project.directory
        const spec = testSpec({ waits: 'waiting.c', waitingOutput: 'done\n' })
        await page.evaluate(async ({ root, spec }) => {
          const api = window.ion.projects
          let record = await api.save(root, spec, null)
          for (const test of spec.tests) record = await api.approve(root, test.id, record.revision)
          if (record.approved.length !== spec.tests.length) throw new Error('Benchmark fixture approval failed.')
        }, { root, spec })
        await capture('savedConfigIdle')
        const testButton = page.getByTestId('run-tests')
        const tests = page.getByTestId('project-tests')
        const selection = tests.getByTestId('project-test-selection')
        const status = tests.getByTestId('project-suite-status')
        await testButton.click()
        await selection.waitFor()
        await capture('testDialogIdle')
        const started = performance.now()
        await tests.getByTestId('project-run-suite').click()
        await tests.getByTestId('project-stop-suite').waitFor()
        let running
        const hasProgram = ({ members }) => members.some(({ name }) => /^program(?:\.exe)?$/i.test(name))
        await eventually(async () => {
          running = await snapshot(session)
          return hasProgram(running)
        }, 'No native C program was observed during the approved suite.')
        await sleep(350)
        const latest = await snapshot(session)
        result.suiteActive = hasProgram(latest) ? withCpu(running, latest) : running
        await status.filter({ hasText: /2 passed.*1 failed.*1 unable/ }).waitFor()
        result.suiteMs = performance.now() - started
        await tests.getByRole('button', { name: 'Done', exact: true }).click()
        await waitForChildren(session, children => children.every(({ name }) => /^(?:conhost|openconsole)\.exe$/i.test(name)),
          'A development subprocess remained after the suite.')
        await capture('suiteClosed')

        if (index === trials - 1 && soakSeconds) {
          const began = performance.now()
          result.soak = []
          while (performance.now() - began < soakSeconds * 1000) {
            const input = await responsiveness(page, project)
            const gitMs = await marker(page, () => gitButton.click(), () => gitReady.waitFor())
            await gitButton.click()
            await panel.waitFor({ state: 'detached' })
            await testButton.click()
            await selection.selectOption('pass')
            const testMs = await marker(page, () => tests.getByTestId('project-run-suite').click(),
              () => status.filter({ hasText: /1 passed/ }).waitFor())
            await tests.getByRole('button', { name: 'Done', exact: true }).click()
            result.soak.push({ second: (performance.now() - began) / 1000, gitMs, testMs, input, ...(await snapshot(session)) })
            await sleep(750)
          }
        }
      }
      assert.deepEqual(session.errors, [])
      assert.deepEqual(session.requests, [])
      console.log(`${label} ${index + 1}/${trials} finished`)
      return result
    } catch (error) {
      report.failure = { build: label, trial: index + 1, message: String(error) }
      await writeFile(output, JSON.stringify(report, null, 2) + '\n')
      console.error(`${label} ${index + 1}/${trials} failed`, error)
      throw error
    } finally { await close(session) }
  }

  for (let index = 0; index < trials; index++) {
    if (baseline) report.samples.baseline.push(await sample(baseline, 'baseline', index))
    report.samples.candidate.push(await sample(candidate, 'candidate', index))
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  }
})
report.complete = true
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(output)
