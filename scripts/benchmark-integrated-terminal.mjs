import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { median } from './benchmark-resource-metrics.mjs'
import { artifact, close, cpuPercent, createProject, eventually, launch, mkdir, openFolder,
  openFromExplorer, resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { terminalShortcut } from './integrated-terminal-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  mode: { type: 'string', default: 'candidate' },
  trials: { type: 'string', default: '3' },
  'idle-ms': { type: 'string', default: '5000' },
  'settle-ms': { type: 'string', default: '1200' },
  cycles: { type: 'string', default: '8' },
  out: { type: 'string', default: 'performance-results' },
} })
assert.equal(process.platform, 'darwin', 'The resource probe uses macOS process accounting.')
assert.ok(['baseline', 'candidate'].includes(values.mode))
const trials = Number(values.trials)
const idleMs = Number(values['idle-ms'])
const settleMs = Number(values['settle-ms'])
const cycles = Number(values.cycles)
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 20)
assert.ok(Number.isInteger(idleMs) && idleMs >= 1000 && idleMs <= 120_000)
assert.ok(Number.isInteger(settleMs) && settleMs >= 500 && settleMs <= 30_000)
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 40)
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use production build files for Playwright and native dialog stubbing.')
const execute = promisify(execFile)
const system = (command, ...args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const stamp = new Date().toISOString()
const output = resolve(values.out, `terminal-${values.mode}-${stamp.replaceAll(':', '-')}.json`)
await mkdir(values.out, { recursive: true })
const report = {
  timestamp: stamp, mode: values.mode, trials, idleMs, settleMs, cycles,
  artifact: {
    path: values.target,
    mainSha256: hash(await readFile(join(target.path, 'main/index.cjs'))),
    rendererHtmlSha256: hash(await readFile(join(target.path, 'renderer/index.html'))),
  },
  host: {
    macOS: system('/usr/bin/sw_vers'), processor: system('/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'),
    ramBytes: Number(system('/usr/sbin/sysctl', '-n', 'hw.memsize')),
    arch: process.arch, node: process.version, power: system('/usr/bin/pmset', '-g', 'batt').split('\n')[0],
    electron: JSON.parse(await readFile('node_modules/electron/package.json', 'utf8')).version,
  },
  samples: [],
}
const record = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')

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
    const session = await launch(target, join(scratch, 'profile-' + index))
    try {
      const { app, page } = session
      const run = { index: index + 1, startupMs: session.startupMs }
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory })
      await openFolder(page, project)
      await openFromExplorer(page, project.files[0], 'Ion fixture')
      run.editor = await checkIdle(session, probe, 'editor idle', 0)
      assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
        .some((entry) => /\/(?:TerminalPane|TerminalSurface|xterm)-/.test(entry.name))), false, 'xterm stayed unloaded before requesting a console')

      if (values.mode === 'candidate') {
        const started = performance.now()
        await toggle(app)
        await prompt(page)
        run.firstPromptMs = performance.now() - started
        run.open = await checkIdle(session, probe, 'one shell open', 2)
        await click(page, 'terminal-new')
        await page.getByTestId('terminal-session').locator('option').nth(1).waitFor({ state: 'attached' })
        run.two = await checkIdle(session, probe, 'two shells open', 4)
        await click(page, 'terminal-hide')
        await pane(page).waitFor({ state: 'hidden' })
        run.hidden = await checkIdle(session, probe, 'hidden panel', 4)
        await toggle(app)
        await click(page, 'terminal-close')
        await click(page, 'terminal-close')
        await click(page, 'terminal-hide')
        await noChildren(session)
        run.closed = await checkIdle(session, probe, 'all sessions closed', 0)
        await toggle(app)
        for (let cycle = 0; cycle < cycles; cycle++) {
          await click(page, 'terminal-new')
          await prompt(page)
          await click(page, 'terminal-close')
          await noChildren(session)
        }
        await click(page, 'terminal-hide')
        run.afterCycles = await checkIdle(session, probe, 'after repeated create and close', 0)
      }
      assert.deepEqual(session.requests, [])
      assert.deepEqual(session.errors, [])
      report.samples.push(run)
      await record()
      console.log('Recorded trial ' + (index + 1) + ' of ' + trials)
    } finally {
      await close(session)
    }
  }
})

report.medians = { startupMs: median(report.samples.map(({ startupMs }) => startupMs)) }
if (values.mode === 'candidate') report.medians.firstPromptMs = median(report.samples.map(({ firstPromptMs }) => firstPromptMs))
for (const stage of ['editor', 'open', 'two', 'hidden', 'closed', 'afterCycles']) {
  const states = report.samples.flatMap((trial) => trial[stage] ? [trial[stage]] : [])
  if (!states.length) continue
  report.medians[stage] = {
    rssMiB: median(states.flatMap(({ first, last }) => [first.rssMiB, last.rssMiB])),
    footprintMiB: median(states.flatMap(({ first, last }) => [first.footprintMiB, last.footprintMiB])),
    cpuPercent: median(states.map((state) => state.cpuPercent)),
  }
}
await record()
console.log(JSON.stringify(report.medians, null, 2))
console.log(output)
