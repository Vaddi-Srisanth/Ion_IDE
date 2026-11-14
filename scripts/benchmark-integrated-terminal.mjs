import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { median } from './benchmark-resource-metrics.mjs'
import { artifact, close, cpuPercent, createProject, eventually, launch, mkdir, openFolder,
  openFromExplorer, resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { terminalShortcut } from './integrated-terminal-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  mode: { type: 'string', default: 'candidate' },
  'matched-terminal-workload': { type: 'boolean', default: false },
  plan: { type: 'boolean', default: false },
  trials: { type: 'string', default: '3' },
  'idle-ms': { type: 'string', default: '5000' },
  'settle-ms': { type: 'string', default: '1200' },
  cycles: { type: 'string', default: '8' },
  out: { type: 'string', default: 'performance-results' },
} })
assert.ok(['baseline', 'candidate'].includes(values.mode))
const trials = Number(values.trials)
const idleMs = Number(values['idle-ms'])
const settleMs = Number(values['settle-ms'])
const cycles = Number(values.cycles)
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 20)
assert.ok(Number.isInteger(idleMs) && idleMs >= 1000 && idleMs <= 120_000)
assert.ok(Number.isInteger(settleMs) && settleMs >= 500 && settleMs <= 30_000)
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 40)
// Preserve the historical pre-terminal baseline by default. A baseline known
// to contain Terminal can explicitly run the identical candidate workload.
const terminalWorkload = values.mode === 'candidate' || values['matched-terminal-workload']
if (values.plan) {
  console.log(JSON.stringify({ schemaVersion: 1, mode: values.mode, terminalWorkload,
    matchedTerminalWorkload: values['matched-terminal-workload'], trials, idleMs, settleMs, cycles,
    measurementStatus: 'not-run' }))
  process.exit(0)
}
assert.equal(process.platform, 'darwin', 'The resource probe uses macOS process accounting.')
const execute = promisify(execFile)
const system = (command, ...args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const stamp = new Date().toISOString()
const output = resolve(values.out, `terminal-${values.mode}-${stamp.replaceAll(':', '-')}.json`)
await mkdir(values.out, { recursive: true })
const report = {
  complete: false, phase: 'preflight', timestamp: stamp, mode: values.mode, terminalWorkload, matchedTerminalWorkload: values['matched-terminal-workload'], trials, idleMs, settleMs, cycles,
  artifact: { path: values.target },
  host: { platform: process.platform, arch: process.arch, node: process.version },
  samples: [],
}
async function record() {
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n')
  assert.ok(bytes.length <= 8 * 1024 ** 2, 'Terminal benchmark receipt limit exceeded.')
  const pending = output + '.tmp-' + process.pid
  let owned = false
  try {
    const file = await open(pending, 'wx', 0o600)
    owned = true
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await rename(pending, output)
  } finally { if (owned) await rm(pending, { force: true }) }
}
function failureDetails(error) {
  const names = new Set(['Error', 'TypeError', 'RangeError', 'AssertionError', 'TimeoutError'])
  const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ESRCH', 'ERR_ASSERTION', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE'])
  return { type: names.has(error?.name) ? error.name : 'Error', code: Number.isInteger(error?.code) ? error.code : codes.has(error?.code) ? error.code : null,
    messageSha256: hash(String(error?.message ?? '')) }
}
// Reserve the generated evidence name before checkpoints may replace it.
const reservation = await open(output, 'wx', 0o600)
await reservation.close()
await record()
let target
try {
  target = await artifact(values.target)
  assert.ok(!target.path.endsWith('.app'), 'Use production build files for Playwright and native dialog stubbing.')
  report.artifact.mainSha256 = hash(await readFile(join(target.path, 'main/index.cjs')))
  report.artifact.rendererHtmlSha256 = hash(await readFile(join(target.path, 'renderer/index.html')))
  report.host = {
    macOS: system('/usr/bin/sw_vers'), processor: system('/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'),
    ramBytes: Number(system('/usr/sbin/sysctl', '-n', 'hw.memsize')),
    arch: process.arch, node: process.version, power: system('/usr/bin/pmset', '-g', 'batt').split('\n')[0],
    electron: JSON.parse(await readFile('node_modules/electron/package.json', 'utf8')).version,
  }
  report.phase = 'fixture-setup'
  await record()

async function sample(session, probe) {
  const snapshot = await resourceSnapshot(session, { details: true })
  const rows = (await execute(probe, snapshot.members.map(({ pid }) => String(pid)))).stdout.trim().split('\n').filter(Boolean)
  const byPid = new Map(rows.map((line) => {
    const [pid, footprintBytes, cpuNs] = line.split(' ').map(Number)
    return [pid, { footprintBytes, cpuNs }]
  }))
  return {
    ...snapshot,
    members: snapshot.members.map((member) => ({ ...member, ...byPid.get(member.pid) })),
    footprintMiB: snapshot.members.every(({ pid }) => byPid.has(pid))
      ? snapshot.members.reduce((sum, { pid }) => sum + byPid.get(pid).footprintBytes, 0) / 1024 ** 2 : null,
  }
}

async function idle(session, probe) {
  await sleep(settleMs)
  const first = await sample(session, probe)
  await sleep(idleMs)
  const last = await sample(session, probe)
  const before = new Map(first.members.map(({ pid, cpuNs }) => [pid, cpuNs]))
  const stable = last.members.filter(({ pid }) => before.has(pid))
  const cpu = stable.every(({ pid, cpuNs }) => Number.isFinite(cpuNs) && Number.isFinite(before.get(pid)))
    ? stable.reduce((sum, { pid, cpuNs }) => sum + Math.max(0, cpuNs - before.get(pid)), 0)
      / (last.timeMs - first.timeMs) / 10_000 : cpuPercent(first, last)
  return { first, last, cpuPercent: cpu }
}

const children = (snapshot) => snapshot.members.filter(({ kind }) => kind === 'child')
const pane = (page) => page.getByTestId('terminal-pane')
const click = (page, id) => page.getByTestId(id).click()
const toggle = (app) => terminalShortcut(app, 'J', ['meta', 'shift'])
const prompt = (page) => pane(page).locator('.xterm:visible .xterm-rows').getByText('ION-BENCH>', { exact: true }).waitFor()
const noChildren = (session) => eventually(async () => !(await resourceSnapshot(session)).processes.includes('child'),
  'A shell or helper survived close.')

async function checkIdle(session, probe, stage, expectedChildren) {
  const state = await idle(session, probe)
  for (const endpoint of [state.first, state.last]) {
    assert.equal(children(endpoint).length, expectedChildren, stage + ' process count')
  }
  return state
}

await withScratch('terminal-benchmark', async (scratch) => {
  const probe = join(scratch, 'resource-probe')
  await execute('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 1 })
  const zsh = join(scratch, 'zsh')
  await mkdir(zsh)
  await writeFile(join(zsh, '.zshrc'), 'PROMPT="ION-BENCH> "\nRPROMPT=""\nunsetopt BEEP\n')
  process.env.ZDOTDIR = zsh
  for (let index = 0; index < trials; index++) {
    const run = { index: index + 1, complete: false, phase: 'launch',
      cleanup: { attempted: false, completed: false, verified: false, scope: 'main-process-exit', exitCode: null, signal: null } }
    report.samples.push(run)
    report.phase = 'trial'
    await record()
    let session
    const phase = async value => { run.phase = value; await record() }
    try {
      session = await launch(target, join(scratch, 'profile-' + index))
      run.startupMs = session.startupMs
      const { app, page } = session
      await phase('editor-setup')
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory })
      await openFolder(page, project)
      await openFromExplorer(page, project.files[0], 'Ion fixture')
      await phase('editor-idle')
      run.editor = await checkIdle(session, probe, 'editor idle', 0)
      assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
        .some((entry) => /\/(?:TerminalPane|TerminalSurface|xterm)-/.test(entry.name))), false, 'xterm stayed unloaded before requesting a console')

      if (terminalWorkload) {
        await phase('terminal-first-open')
        const started = performance.now()
        await toggle(app)
        await prompt(page)
        run.firstPromptMs = performance.now() - started
        await phase('terminal-one-session')
        run.open = await checkIdle(session, probe, 'one shell open', 2)
        await phase('terminal-two-sessions')
        await click(page, 'terminal-new')
        await page.getByTestId('terminal-session').locator('option').nth(1).waitFor({ state: 'attached' })
        run.two = await checkIdle(session, probe, 'two shells open', 4)
        await phase('terminal-hidden')
        await click(page, 'terminal-hide')
        await pane(page).waitFor({ state: 'hidden' })
        run.hidden = await checkIdle(session, probe, 'hidden panel', 4)
        await phase('terminal-close')
        await toggle(app)
        await click(page, 'terminal-close')
        await click(page, 'terminal-close')
        await click(page, 'terminal-hide')
        await noChildren(session)
        run.closed = await checkIdle(session, probe, 'all sessions closed', 0)
        await phase('terminal-cycles')
        run.completedCycles = 0
        await toggle(app)
        for (let cycle = 0; cycle < cycles; cycle++) {
          await click(page, 'terminal-new')
          await prompt(page)
          await click(page, 'terminal-close')
          await noChildren(session)
          run.completedCycles = cycle + 1
        }
        await click(page, 'terminal-hide')
        await phase('terminal-after-cycles')
        run.afterCycles = await checkIdle(session, probe, 'after repeated create and close', 0)
      }
      assert.deepEqual(session.requests, [])
      assert.deepEqual(session.errors, [])
      run.workloadComplete = true
    } catch (error) {
      run.failure = { stage: run.phase, ...failureDetails(error) }
      run.phase = 'failed'
      throw error
    } finally {
      // A failed checkpoint must never prevent cleanup of a returned session.
      if (session) {
        run.cleanup.attempted = true
        const appProcess = session.appProcess ?? session.app.process()
        try {
          await close(session)
          run.cleanup.completed = true
          run.cleanup.verified = appProcess.exitCode === 0 && appProcess.signalCode === null
          if (!run.cleanup.verified) throw new Error('Terminal benchmark application did not exit normally.')
        } catch (error) {
          run.cleanup.failure = failureDetails(error)
          if (!run.failure) run.failure = { stage: 'session-cleanup', ...failureDetails(error) }
        } finally { run.cleanup.exitCode = appProcess.exitCode; run.cleanup.signal = appProcess.signalCode }
      } else run.cleanup.status = 'launch-not-returned'
      run.complete = run.workloadComplete === true && run.cleanup.verified
      run.phase = run.complete ? 'completed' : 'failed'
      await record()
      if (run.cleanup.failure && run.failure.stage === 'session-cleanup') throw new Error('Terminal benchmark session cleanup failed.')
    }
    console.log('Recorded trial ' + (index + 1) + ' of ' + trials)
  }
})

report.phase = 'summarizing'
report.medians = { startupMs: median(report.samples.map(({ startupMs }) => startupMs)) }
if (terminalWorkload) report.medians.firstPromptMs = median(report.samples.map(({ firstPromptMs }) => firstPromptMs))
for (const stage of ['editor', 'open', 'two', 'hidden', 'closed', 'afterCycles']) {
  const states = report.samples.flatMap((trial) => trial[stage] ? [trial[stage]] : [])
  if (!states.length) continue
  report.medians[stage] = {
    rssMiB: median(states.flatMap(({ first, last }) => [first.rssMiB, last.rssMiB])),
    footprintMiB: median(states.flatMap(({ first, last }) => [first.footprintMiB, last.footprintMiB])),
    cpuPercent: median(states.map((state) => state.cpuPercent)),
  }
}
report.complete = report.samples.length === trials && report.samples.every(run => run.complete)
report.phase = report.complete ? 'completed' : 'incomplete'
await record()
console.log(JSON.stringify(report.medians, null, 2))
console.log(output)

} catch (error) {
  report.complete = false
  report.failure = { stage: report.phase, ...failureDetails(error) }
  report.phase = 'failed'
  await record()
  throw error
}
