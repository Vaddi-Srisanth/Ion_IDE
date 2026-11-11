import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { cpus, release, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { artifact, atPath, close, desktopWindowsVisible, editorShows, eventually, launch, openFolder,
  openFromExplorer, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { developmentFixture, processTree, testSpec, waitForChildren } from './development-workflow-fixtures.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, baseline: { type: 'string' },
  cycles: { type: 'string', default: '20' }, 'pace-ms': { type: 'string', default: '1000' },
  checkpoints: { type: 'string', default: '20,120,300' }, 'diagnostic-gc': { type: 'boolean' },
  out: { type: 'string', default: 'performance-results/stabilization/memory-recovery.json' },
  help: { type: 'boolean' },
} })
if (values.help) {
  console.log('node scripts/benchmark-stabilization-memory.mjs [--baseline prior/dist] [--target dist] [--cycles 20] [--pace-ms 1000] [--checkpoints 20,120,300] [--diagnostic-gc] [--out report.json]')
  process.exit(0)
}
assert.ok(process.platform === 'darwin' || process.platform === 'win32', 'Use native macOS or Windows.')
const windows = process.platform === 'win32'
const cycles = Number(values.cycles)
const paceMs = Number(values['pace-ms'])
const checkpoints = values.checkpoints.split(',').map(Number)
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 5000, 'Use 1–5000 workload cycles.')
assert.ok(Number.isInteger(paceMs) && paceMs >= 0 && paceMs <= 10_000, 'Use 0–10000 ms pacing.')
assert.ok(checkpoints.length >= 1 && checkpoints.length <= 10 && checkpoints.every((value, index) =>
  Number.isInteger(value) && value >= 0 && value <= 900 && (!index || value > checkpoints[index - 1])),
'Use increasing recovery checkpoints between 0 and 900 seconds.')
const execute = promisify(execFile)
const mib = 1024 ** 2
const output = resolve(values.out)
const builds = [{ label: 'candidate', build: await artifact(values.target) }]
if (values.baseline) builds.unshift({ label: 'baseline', build: await artifact(values.baseline) })
const hash = async (build) => createHash('sha256').update(await readFile(join(build.path, 'main/index.cjs'))).digest('hex')
const report = {
  complete: false, timestamp: new Date().toISOString(),
  harnessSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  host: { platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model, ramBytes: totalmem() },
  protocol: { cycles, paceMs, checkpointsSeconds: checkpoints, windowsVisible: desktopWindowsVisible(), offline: true,
    fixture: '1,000-file Git workspace, ten source tabs, 7,000-line Git diff and one approved native C sample per cycle. The first cycle also runs a 3.6-second waiting C case to observe its actual native process.',
    workload: 'Each cycle switches source/note tabs, types and undoes one edit, saves source, opens/closes Git status and a real diff, then runs/closes the approved C case.',
    recovery: 'Checkpoint deadlines start when the final test dialog closes, before native child cleanup verification. Memory is captured at the requested deadline; the following two-second sample is used for CPU. No forced GC before or during these checkpoints. Both builds use identical windows, input and cycle counts with fresh profiles.',
    cpu: 'Two-second process CPU interval following each checkpoint. Includes the sample instrumentation; exited child CPU is reported separately when available.',
    memory: windows ? 'Per-process working set and private bytes.' : 'Per-process macOS-attributed footprint and summed process RSS.',
    diagnosticGc: Boolean(values['diagnostic-gc']),
    limits: 'Hidden-window automation and software frame callbacks do not measure physical display latency, GPU hardware utilization, laptop battery drain, or an 8 GB host.',
  },
  builds: Object.fromEntries(await Promise.all(builds.map(async ({ label, build }) => [label,
    { path: build.path, mainSha256: await hash(build) }]))),
  samples: [],
}
await mkdir(dirname(output), { recursive: true })
async function persist() {
  await writeFile(output + '.tmp', JSON.stringify(report, null, 2) + '\n')
  await rename(output + '.tmp', output)
}

function elapsedCpu(before, after) {
  const previous = new Map(before.members.map(member => [member.pid, member.cpuSeconds]))
  if (before.members.length !== after.members.length || after.members.some(member =>
    !Number.isFinite(previous.get(member.pid)) || !Number.isFinite(member.cpuSeconds))) return null
  const cpuSeconds = after.members.reduce((sum, member) => sum + Math.max(0, member.cpuSeconds - previous.get(member.pid)), 0)
  return cpuSeconds * 100_000 / (after.timeMs - before.timeMs)
}

async function snapshot(session, cdp, probe) {
  const tree = await processTree(session)
  let members = tree.members
  if (!windows) {
    const { stdout } = await execute(probe, members.map(member => String(member.pid)))
    const ledger = new Map(stdout.trim().split('\n').filter(Boolean).map(line => {
      const [pid, bytes, cpuNs, childCpuNs, wakeups] = line.trim().split(/\s+/).map(Number)
      return [pid, { footprintMiB: bytes / mib, cpuSeconds: cpuNs / 1e9, reapedChildCpuSeconds: childCpuNs / 1e9, wakeups }]
    }))
    members = members.map(member => ({ ...member, ...ledger.get(member.pid) }))
  }
  const [heap, dom, ui] = await Promise.all([
    cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters'),
    session.page.evaluate(() => ({ editors: document.querySelectorAll('[data-testid="editor"] .monaco-editor').length,
      diffEditors: document.querySelectorAll('.monaco-diff-editor').length,
      testDialogs: document.querySelectorAll('[data-testid="project-tests"]').length,
      sourceControlPanels: document.querySelectorAll('[data-testid="source-control"]').length,
      loadedWorkerAssets: performance.getEntriesByType('resource').filter(entry => /worker/.test(entry.name)).map(entry => entry.name.split('/').pop()),
    })),
  ])
  const roles = {}
  for (const member of members) {
    const role = roles[member.kind] ??= { count: 0 }
    role.count++
    for (const [key, value] of Object.entries({ rssMiB: member.rssMiB, footprintMiB: member.footprintMiB,
      workingSetMiB: member.workingSet / mib, privateMiB: member.privateBytes / mib })) {
      if (Number.isFinite(value)) role[key] = (role[key] ?? 0) + value
    }
  }
  return { timeMs: tree.timeMs, rssMiB: tree.rssMiB, workingSetMiB: tree.workingSetMiB, privateMiB: tree.privateMiB,
    footprintMiB: windows ? undefined : members.every(member => Number.isFinite(member.footprintMiB))
      ? members.reduce((sum, member) => sum + member.footprintMiB, 0) : null,
    heap, dom, ui, roles, members }
}

async function show(page, text) { await (await editorShows(page, text)).dispose() }

await withScratch('stabilization-memory', async scratch => {
  const probe = join(scratch, 'footprint')
  if (!windows) await execute('/usr/bin/xcrun', ['clang', '-O2', fileURLToPath(new URL('./benchmark-resources-probe.c', import.meta.url)), '-o', probe])
  for (const { label, build } of builds) {
    const sample = { build: label, complete: false, timings: [], activity: [], recovery: [] }
    report.samples.push(sample)
    await persist()
    const project = await developmentFixture(join(scratch, label + ' Source folder'), { medium: true })
    const profile = join(scratch, label + '-profile')
    await mkdir(profile)
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: {
      resourceProfile: 'minimal', autoSave: false, showOutput: true, openFullScreen: false,
    } }))
    const session = await launch(build, profile)
    const { app, page } = session
    let cdp
    let failure
    const observedChildren = new Set()
    try {
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory, allowGit: true, allowProjectTests: true })
      cdp = await page.context().newCDPSession(page)
      const measure = async () => {
        const point = await snapshot(session, cdp, probe)
        for (const member of point.members) if (member.kind === 'child') observedChildren.add(member.pid)
        return point
      }
      sample.startupMs = session.startupMs
      sample.welcome = await measure()
      await openFolder(page, project)
      await openFromExplorer(page, project.program, '#include')
      for (const note of project.files.slice(0, 9)) await openFromExplorer(page, note, 'Ion fixture ' + basename(note))
      assert.equal(await page.getByTestId('tab').count(), 10)
      const preserved = project.files[8]
      const original = await readFile(preserved, 'utf8')
      const sentinel = ' ION_UNDO_RETENTION'
      const editor = page.getByTestId('editor').locator('.monaco-editor')
      const editorHost = page.getByTestId('editor').locator('.monaco-host')
      await editorHost.evaluate(node => { node.dataset.memoryRecoveryIdentity = 'original' })
      const editorContext = await editorHost.getAttribute('data-keybinding-context')
      assert.ok(editorContext, 'The editor must own its scoped keyboard context.')
      const line = editor.locator('.view-line').first()
      await line.click()
      await page.keyboard.press(windows ? 'End' : 'Meta+ArrowRight')
      await page.keyboard.insertText(sentinel)
      await show(page, sentinel.trim())
      await page.getByTestId('save-file').click()
      await atPath(page, 'tab', preserved).locator('.tab-dirty').waitFor({ state: 'detached' })
      const spec = testSpec({ waits: 'waiting.c', waitingOutput: 'done\n' })
      await page.evaluate(async ({ root, spec }) => {
        const api = window.ion.projects
        let record = await api.save(root, spec, null)
        record = await api.approve(root, 'pass', record.revision)
        record = await api.approve(root, 'waiting', record.revision)
        if (!['pass', 'waiting'].every(id => record.approved.includes(id))) throw new Error('Approval failed for the disposable C cases.')
      }, { root: project.directory, spec })
      const source = atPath(page, 'tab', project.program).locator('.tab-name')
      const note = atPath(page, 'tab', project.files[0]).locator('.tab-name')
      await source.click()
      await show(page, '#include')
      await sleep(2000)
      sample.before = await measure()
      const began = performance.now()
      let finalPanelClosedAt = began
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const started = performance.now()
        for (let pair = 0; pair < 4; pair++) {
          await note.click()
          await show(page, 'Ion fixture')
          await source.click()
          await show(page, '#include')
        }
        await line.click()
        await page.keyboard.press(windows ? 'End' : 'Meta+ArrowRight')
        await page.keyboard.press('x')
        await (await page.waitForFunction(() => document.querySelector('[data-testid="editor"] .view-line')?.textContent.endsWith('x'))).dispose()
        await page.keyboard.press((windows ? 'Control' : 'Meta') + '+z')
        await (await page.waitForFunction(() => !document.querySelector('[data-testid="editor"] .view-line')?.textContent.endsWith('x'))).dispose()
        await page.getByTestId('save-file').click()
        await atPath(page, 'tab', project.program).locator('.tab-dirty').waitFor({ state: 'detached' })
        const git = page.getByTestId('source-control')
        const toggle = page.getByTestId('toggle-source-control')
        await toggle.click()
        await git.getByTestId('git-branch').or(git.getByTestId('git-trust')).waitFor()
        if (await git.getByTestId('git-trust').isVisible()) await git.getByTestId('git-trust').click()
        await git.getByTestId('git-branch').waitFor()
        await git.locator('[data-testid="git-open-diff"][data-git-path="large-diff.txt"]').click()
        const diff = page.getByTestId('git-diff')
        await eventually(() => diff.getByRole('button', { name: 'Next Change', exact: true }).isEnabled(), 'The Git diff did not finish.')
        await diff.getByTestId('git-diff-close').click()
        await diff.waitFor({ state: 'detached' })
        await toggle.click()
        await git.waitFor({ state: 'detached' })
        const tests = page.getByTestId('project-tests')
        await page.getByTestId('run-tests').click()
        await tests.getByTestId('project-test-selection').selectOption('pass')
        await tests.getByTestId('project-run-suite').click()
        await tests.getByTestId('project-suite-status').filter({ hasText: /1 passed/ }).waitFor()
        if (cycle === 1) {
          await tests.getByTestId('project-test-selection').selectOption('waiting')
          await tests.getByTestId('project-run-suite').click()
          await eventually(async () => (await processTree(session)).members.some(member =>
            member.kind === 'child' && /^program(?:\.exe)?$/i.test(member.name)), 'The waiting C program was not observed.')
          sample.nativeTestActive = await measure()
          assert.ok(sample.nativeTestActive.members.some(member => member.kind === 'child'
            && /^program(?:\.exe)?$/i.test(member.name)), 'The C process exited before its memory sample.')
          await tests.getByTestId('project-suite-status').filter({ hasText: /1 passed/ }).waitFor()
        }
        await tests.getByRole('button', { name: 'Done', exact: true }).click()
        await tests.waitFor({ state: 'detached' })
        finalPanelClosedAt = performance.now()
        sample.timings.push({ cycle, elapsedMs: performance.now() - started })
        await sleep(Math.max(0, paceMs - (performance.now() - started)))
        if (cycle % Math.ceil(cycles / 10) === 0 || cycle === cycles) {
          sample.activity.push({ cycle, elapsedMs: performance.now() - began, ...(await measure()) })
          await persist()
        }
      }
      sample.workloadMs = performance.now() - began
      await waitForChildren(session, children => children.every(member => /^(?:conhost|openconsole)\.exe$/i.test(member.name)),
        'A native fixture child remained after closing Git and saved tests.')
      const recoveryStarted = finalPanelClosedAt
      sample.afterWork = { ...(await measure()), elapsedSeconds: (performance.now() - recoveryStarted) / 1000 }
      for (const seconds of checkpoints) {
        await sleep(Math.max(0, recoveryStarted + seconds * 1000 - performance.now()))
        const first = await measure()
        const observedSeconds = (performance.now() - recoveryStarted) / 1000
        await sleep(2000)
        const after = await measure()
        sample.recovery.push({ requestedSeconds: seconds, elapsedSeconds: observedSeconds,
          cpuPercent: elapsedCpu(first, after), cpuIntervalMs: after.timeMs - first.timeMs, ...first })
        await persist()
        console.log(`${label}: recovered ${seconds}s, ${windows ? first.workingSetMiB.toFixed(1) + ' MiB working set' : first.rssMiB.toFixed(1) + ' MiB RSS'}`)
      }
      if (values['diagnostic-gc']) {
        await cdp.send('HeapProfiler.collectGarbage')
        await sleep(2000)
        sample.diagnosticGcAfterRecovery = await measure()
      }
      await atPath(page, 'tab', preserved).locator('.tab-name').click()
      await show(page, sentinel.trim())
      // Monaco replaces its model view node on setModel. The creation host and
      // scoped keyboard context belong to the widget and survive model swaps.
      assert.equal(await editorHost.getAttribute('data-memory-recovery-identity'), 'original')
      assert.equal(await editorHost.getAttribute('data-keybinding-context'), editorContext)
      await editor.locator('.view-line').first().click()
      await page.keyboard.press((windows ? 'Control' : 'Meta') + '+z')
      await (await page.waitForFunction(() => !document.querySelector('[data-testid="editor"] .view-lines')?.textContent.includes('ION_UNDO_RETENTION'))).dispose()
      await page.getByTestId('save-file').click()
      await atPath(page, 'tab', preserved).locator('.tab-dirty').waitFor({ state: 'detached' })
      assert.equal(await readFile(preserved, 'utf8'), original)
      sample.editorIdentityAndUndoPreserved = true
      assert.deepEqual(session.requests, [])
      assert.deepEqual(session.errors, [])
    } catch (error) {
      failure = error
      sample.error = String(error)
      throw error
    } finally {
      await cdp?.detach().catch(() => {})
      await persist()
      try {
        await close(session)
        await eventually(async () => !(await processTree(session)).members.length, 'The app process family remained after shutdown.')
        await eventually(() => [...observedChildren].every(pid => {
          try { process.kill(pid, 0); return false }
          catch (error) { if (error.code === 'ESRCH') return true; throw error }
        }), 'An observed native child remained alive after app shutdown.')
        sample.observedNativeChildPids = [...observedChildren]
        sample.processFamilyExited = true
      } catch (error) {
        sample.shutdownError = String(error)
        await persist()
        if (failure) throw new AggregateError([failure, error], 'Workload and shutdown both failed.')
        throw error
      }
    }
    sample.complete = true
    await persist()
  }
})
report.complete = true
await persist()
console.log(output)
