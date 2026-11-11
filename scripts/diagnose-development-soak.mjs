import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, release, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { artifact, atPath, close, desktopWindowsVisible, editorShows, launch, openFolder, openFromExplorer,
  sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { developmentFixture, processTree, testSpec, waitForChildren } from './development-workflow-fixtures.mjs'

const modes = ['edit', 'git', 'dialog', 'tests', 'mixed']
const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, baseline: { type: 'string' },
  modes: { type: 'string', default: modes.join(',') }, cycles: { type: 'string', default: '12' },
  'pace-ms': { type: 'string', default: '850' }, 'settle-ms': { type: 'string', default: '1200' },
  out: { type: 'string', default: 'performance-results/development-soak-diagnosis.json' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('node scripts/diagnose-development-soak.mjs --target dist [--baseline prior/dist] [--modes edit,git,dialog,tests,mixed] [--cycles 12] [--pace-ms 850] [--settle-ms 1200] [--out report.json]')
  process.exit(0)
}
const win = process.platform === 'win32'
assert.ok(win || process.platform === 'darwin', 'Use native macOS or Windows.')
const selected = values.modes.split(',')
assert.ok(selected.length && new Set(selected).size === selected.length && selected.every(mode => modes.includes(mode)),
  'Select one or more distinct modes from edit,git,dialog,tests,mixed.')
function integer(key, minimum, maximum) {
  const value = Number(values[key])
  assert.ok(Number.isInteger(value) && value >= minimum && value <= maximum, `--${key} must be between ${minimum} and ${maximum}.`)
  return value
}
const cycles = integer('cycles', 1, 200)
const paceMs = integer('pace-ms', 0, 10_000)
const settleMs = integer('settle-ms', 0, 120_000)
const target = await artifact(values.target)
const baseline = values.baseline ? await artifact(values.baseline) : undefined
const execute = promisify(execFile)
const mib = 1024 ** 2
const probeSource = fileURLToPath(new URL('./benchmark-resources-probe.c', import.meta.url))
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const identify = async build => ({ path: build.path, main: await sha256(join(build.path, 'main/index.cjs')),
  rendererHtml: await sha256(join(build.path, 'renderer/index.html')) })
const report = {
  timestamp: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model, ramBytes: totalmem() },
  builds: { target: await identify(target), ...(baseline && { baseline: await identify(baseline) }) },
  protocol: {
    cycles, paceMs, settleMs, selected, windowsVisible: desktopWindowsVisible(), offline: true,
    fixture: 'One C file, nine notes, 1,000 nested files and the same saved approved C configuration per fresh profile.',
    editing: 'Four note/source tab switch pairs, type/undo/save once, scroll note then return to top.',
    optional: 'Git opens status then closes. Dialog opens saved tests then closes. Tests run one approved C case. Mixed does Git then Tests.',
    memory: win ? 'Windows working set and private bytes.' : 'macOS summed process RSS and per-process attributed footprint.',
    method: 'One fresh launch per mode, one warmup, diagnostic GC before the loop, checkpoints without forced GC, natural settle then diagnostic GC after the loop. Snapshots and GC are outside edit action timings. Short isolated runs do not prove a long-session leak.',
  },
  samples: [],
}

function cpuPercent(before, after) {
  const prior = new Map(before.members.map(({ pid, cpuSeconds }) => [pid, cpuSeconds]))
  if (before.members.length !== after.members.length || after.members.some(({ pid, cpuSeconds }) =>
    !Number.isFinite(cpuSeconds) || !Number.isFinite(prior.get(pid)) || cpuSeconds < prior.get(pid))) return null
  return after.members.reduce((sum, { pid, cpuSeconds }) => sum + cpuSeconds - prior.get(pid), 0)
    * 100_000 / (after.timeMs - before.timeMs)
}

async function processes(session, probe) {
  const tree = await processTree(session)
  if (win) return tree
  const { stdout } = await execute(probe, tree.members.map(({ pid }) => String(pid)))
  const ledger = new Map(stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pid, footprint, cpu] = line.split(' ').map(Number)
    return [pid, { footprintMiB: footprint / mib, cpuSeconds: cpu / 1e9 }]
  }))
  const members = tree.members.map(member => ({ ...member, ...ledger.get(member.pid) }))
  const footprintMiB = members.every(member => Number.isFinite(member.footprintMiB))
    ? members.reduce((sum, member) => sum + member.footprintMiB, 0) : null
  return { timeMs: tree.timeMs, rssMiB: tree.rssMiB, footprintMiB, members }
}

async function measure(session, cdp, probe) {
  const heap = await cdp.send('Runtime.getHeapUsage')
  const dom = await cdp.send('Memory.getDOMCounters')
  const tree = await processes(session, probe)
  const roles = {}
  for (const member of tree.members) {
    const role = roles[member.kind] ??= { count: 0 }
    role.count++
    for (const [key, value] of Object.entries({
      rssMiB: member.rssMiB, footprintMiB: member.footprintMiB,
      workingSetMiB: member.workingSet / mib, privateMiB: member.privateBytes / mib,
    })) {
      if (Number.isFinite(value)) role[key] = (role[key] ?? 0) + value
    }
  }
  return { ...tree, heap, dom, roles }
}

async function prepareTests(page, root) {
  const spec = testSpec()
  await page.evaluate(async ({ root, spec }) => {
    const api = window.ion.projects
    let record = await api.save(root, spec, null)
    record = await api.approve(root, 'pass', record.revision)
    if (!record.approved.includes('pass')) throw new Error('Unable to approve the disposable C test.')
  }, { root, spec })
}

function actions(page, project, mode) {
  const source = atPath(page, 'tab', project.program).locator('.tab-name')
  const note = atPath(page, 'tab', project.files[0]).locator('.tab-name')
  const line = page.getByTestId('editor').locator('.view-line').first()
  const panel = page.getByTestId('source-control')
  const branch = panel.getByTestId('git-branch')
  const trust = panel.getByTestId('git-trust')
  const testDialog = page.getByTestId('project-tests')
  const selection = testDialog.getByTestId('project-test-selection')
  const useGit = mode === 'git' || mode === 'mixed'
  const runTest = mode === 'tests' || mode === 'mixed'
  const useTests = mode === 'dialog' || runTest
  const edit = async () => {
    for (let switchPair = 0; switchPair < 4; switchPair++) {
      await note.click()
      await (await editorShows(page, 'Ion fixture')).dispose()
      await source.click()
      await (await editorShows(page, '#include')).dispose()
    }
    await line.click()
    await page.keyboard.press(win ? 'End' : 'Meta+ArrowRight')
    await page.keyboard.press('x')
    await (await page.waitForFunction(() => document.querySelector('[data-testid="editor"] .view-line')?.textContent.endsWith('x'))).dispose()
    await page.keyboard.press((win ? 'Control' : 'Meta') + '+z')
    await (await page.waitForFunction(() => !document.querySelector('[data-testid="editor"] .view-line')?.textContent.endsWith('x'))).dispose()
    await page.getByTestId('save-file').click()
    await atPath(page, 'tab', project.program).locator('.tab-dirty').waitFor({ state: 'detached' })
    await note.click()
    await line.click()
    await page.keyboard.press(win ? 'Control+Home' : 'Meta+ArrowUp')
    await line.hover()
    const initial = await line.innerText()
    await page.mouse.wheel(0, 1250)
    await (await page.waitForFunction(value => document.querySelector('[data-testid="editor"] .view-line')?.innerText !== value,
      initial)).dispose()
    await page.keyboard.press(win ? 'Control+Home' : 'Meta+ArrowUp')
    await (await editorShows(page, 'Ion fixture')).dispose()
  }
  return async () => {
    const began = performance.now()
    await edit()
    const editingMs = performance.now() - began
    let gitMs, testMs
    if (useGit) {
      const start = performance.now()
      const toggle = page.getByTestId('toggle-source-control')
      await toggle.click()
      await branch.or(trust).waitFor()
      if (await trust.isVisible()) await trust.click()
      await branch.waitFor()
      await toggle.click()
      await panel.waitFor({ state: 'detached' })
      gitMs = performance.now() - start
    }
    if (useTests) {
      const start = performance.now()
      await page.getByTestId('run-tests').click()
      await selection.waitFor()
      if (runTest) {
        await selection.selectOption('pass')
        await testDialog.getByTestId('project-run-suite').click()
        await testDialog.getByTestId('project-suite-status').filter({ hasText: /1 passed/ }).waitFor()
      }
      await testDialog.getByRole('button', { name: 'Done', exact: true }).click()
      await testDialog.waitFor({ state: 'detached' })
      testMs = performance.now() - start
    }
    return { editingMs, gitMs, testMs, elapsedMs: performance.now() - began }
  }
}

async function sample(build, label, mode, scratch, probe) {
  const project = await developmentFixture(join(scratch, label + ' ' + mode + ' repo'), { medium: true })
  const profile = join(scratch, label + '-' + mode + '-profile')
  await mkdir(profile)
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: {
    resourceProfile: 'minimal', autoSave: false, showOutput: true, openFullScreen: false,
  } }))
  const session = await launch(build, profile)
  const { app, page } = session
  let cdp
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowProjectTests: true, allowGit: true })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, 'ION-DESKTOP-RUN-OK')
    for (const note of project.files.slice(0, 9)) await openFromExplorer(page, note, 'Ion fixture ' + basename(note))
    assert.equal(await page.getByTestId('tab').count(), 10)
    for (const directory of project.directories.slice(0, 6)) await atPath(page, 'explorer-entry', directory).click()
    await prepareTests(page, project.directory)
    cdp = await page.context().newCDPSession(page)
    const record = () => measure(session, cdp, probe)
    const cycle = actions(page, project, mode)
    await sleep(settleMs)
    const beforeFirstUse = await record()
    const warmup = await cycle()
    await sleep(settleMs)
    const beforeGc = await record()
    await cdp.send('HeapProfiler.collectGarbage')
    await sleep(settleMs)
    const before = await record()
    const began = performance.now()
    const timings = []
    const checkpoints = []
    for (let index = 1; index <= cycles; index++) {
      const timing = await cycle()
      timings.push(timing)
      await sleep(Math.max(0, paceMs - timing.elapsedMs))
      if (index % Math.ceil(cycles / 4) === 0 || index === cycles) {
        checkpoints.push({ cycle: index, elapsedMs: performance.now() - began, ...(await record()) })
      }
    }
    const loopMs = performance.now() - began
    await waitForChildren(session, children => children.every(({ name }) => /^(?:conhost|openconsole)\.exe$/i.test(name)),
      'A fixture compiler, Git process or test program remained after its panel closed.')
    const idleStart = await record()
    await sleep(settleMs)
    const after = await record()
    await cdp.send('HeapProfiler.collectGarbage')
    await sleep(settleMs)
    const afterGc = await record()
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    const result = { build: label, mode, startupMs: session.startupMs, loopMs, beforeFirstUse, warmup, beforeGc,
      before, timings, checkpoints, after, afterGc, idleCpuPercent: settleMs ? cpuPercent(idleStart, after) : null }
    const short = point => ({
      memory: win ? point.workingSetMiB : point.rssMiB, renderer: point.roles.renderer,
      heapMiB: point.heap.usedSize / mib, dom: point.dom,
    })
    console.log(JSON.stringify({ build: label, mode, loopMs, before: short(before), after: short(after), afterGc: short(afterGc) }))
    return result
  } finally {
    await cdp?.detach().catch(() => {})
    await close(session)
  }
}

const output = resolve(values.out)
await mkdir(dirname(output), { recursive: true })
await withScratch('development-isolation', async scratch => {
  const probe = join(scratch, 'resource-probe')
  if (!win) await execute('/usr/bin/xcrun', ['clang', '-O2', probeSource, '-o', probe])
  async function save(build, label, mode) {
    report.samples.push(await sample(build, label, mode, scratch, probe))
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  }
  if (baseline) await save(baseline, 'baseline', 'edit')
  for (const mode of selected) await save(target, 'target', mode)
})
console.log(output)
