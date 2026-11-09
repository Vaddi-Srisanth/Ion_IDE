import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, launch, openFolder, openFromExplorer, resourceSnapshot, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, runs: { type: 'string', default: '20' }, baseline: { type: 'string' },
  'gc-diagnostic': { type: 'boolean' },
} })
assert.equal(process.platform, 'darwin')
const count = Number(values.runs)
assert.ok(Number.isInteger(count) && count >= 2 && count <= 100)
const target = await artifact(values.target)
const baseline = values.baseline ? await artifact(values.baseline) : null
const output = resolve('performance-results', `run-console-${new Date().toISOString().replaceAll(':', '-')}.json`)
await mkdir(resolve('performance-results'), { recursive: true })

async function shortRuns(bundle, profile, project) {
  const session = await launch(bundle, profile)
  const { app, page } = session
  try {
    await app.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, 'getpid')
    let previous = null
    const timings = []
    for (let index = 0; index < count; index++) {
      const start = performance.now()
      await page.getByTestId('run').click()
      const result = await page.waitForFunction((lastPid) => {
        const output = document.querySelector('[data-testid="output"][data-status="success"]')
        const match = /ION-SHORT-(\d+)/.exec(output?.textContent ?? '')
        return match && match[1] !== lastPid ? match[1] : false
      }, previous)
      timings.push(performance.now() - start)
      previous = await result.jsonValue()
      await result.dispose()
    }
    return timings
  } finally {
    await close(session)
  }
}

await withScratch('pty-bench', async (scratch) => {
  const probe = join(scratch, 'footprint')
  execFileSync('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const project = await createProject(join(scratch, 'code workspace'), { fileCount: 0 })
  await writeFile(project.program, `#include <stdio.h>
#include <unistd.h>
int main(void) {
  int value;
  printf("ION-PTY-READY-%ld> ", (long)getpid());
  fflush(stdout);
  if (scanf("%d", &value) != 1) return 2;
  printf("ION-PTY-RESULT-%d\\n", value + 1);
  return 0;
}
`)
  const session = await launch(target, join(scratch, 'profile'))
  const { app, page } = session
  const cdp = values['gc-diagnostic'] ? await app.context().newCDPSession(page) : null
  const checkpoints = []
  async function heapCheckpoint(label) {
    if (!cdp) return
    const before = await cdp.send('Runtime.getHeapUsage')
    await cdp.send('HeapProfiler.collectGarbage')
    const after = await cdp.send('Runtime.getHeapUsage')
    const dom = await cdp.send('Memory.getDOMCounters')
    checkpoints.push({ label, before, after, dom })
  }
  let report
  async function sample() {
    const { members, rssMiB, timeMs } = await resourceSnapshot(session, { details: true })
    const result = execFileSync(probe, members.map(({ pid }) => String(pid)), { encoding: 'utf8' })
    const byPid = new Map(result.trim().split('\n').map((line) => {
      const [pid, bytes, cpuNs] = line.trim().split(/\s+/).map(Number)
      return [pid, { footprintMiB: bytes / 1024 ** 2, cpuNs }]
    }))
    const processes = members.map(({ pid, kind, rssMiB }) => ({ pid, kind, rssMiB, ...byPid.get(pid) }))
    return { timeMs, rssMiB, processes, footprintMiB: processes.every(({ footprintMiB }) => Number.isFinite(footprintMiB))
      ? processes.reduce((sum, { footprintMiB }) => sum + footprintMiB, 0) : null }
  }
  const show = (text) => page.waitForFunction((needle) => document.querySelector('.xterm-rows')?.textContent?.includes(needle), text)
  try {
    await app.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, 'scanf')
    await sleep(1000)
    const before = await sample()
    assert.equal(before.processes.filter(({ kind }) => kind === 'child').length, 0)
    const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => name))
    assert.ok(!loaded.some((name) => name.includes('TerminalSurface-')), 'No terminal bundle requested during code-only editing')
    await heapCheckpoint('before')

    const runs = []
    let waitingCpuPercent
    let previousPid = null
    for (let index = 0; index < count; index++) {
      const started = performance.now()
      await page.getByTestId('run').click()
      const prompt = await page.waitForFunction((lastPid) => {
        const match = /ION-PTY-READY-(\d+)>/.exec(document.querySelector('.xterm-rows')?.textContent ?? '')
        return match && match[1] !== lastPid ? match[1] : false
      }, previousPid)
      previousPid = await prompt.jsonValue()
      await prompt.dispose()
      const promptMs = performance.now() - started
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'run-console-input')
      const waiting = await sample()
      const children = waiting.processes.filter(({ kind }) => kind === 'child')
      assert.equal(children.length, 2, 'One PTY helper and one program are running')
      assert.ok(children.some(({ pid }) => pid === Number(previousPid)), 'Prompt came from the current native program')
      if (!index) {
        await sleep(3000)
        const next = await sample()
        const previous = new Map(children.map(({ pid, cpuNs }) => [pid, cpuNs]))
        const delta = next.processes.filter(({ pid }) => previous.has(pid)).reduce((sum, { pid, cpuNs }) => sum + cpuNs - previous.get(pid), 0)
        waitingCpuPercent = 100 * delta / 1e6 / (next.timeMs - waiting.timeMs)
      }
      await page.keyboard.type(String(index + 1))
      const sent = performance.now()
      await page.keyboard.press('Enter')
      await show('ION-PTY-RESULT-' + String(index + 2))
      const inputMs = performance.now() - sent
      await page.locator('[data-testid="output"][data-status="success"]').waitFor()
      const settled = await sample()
      for (const { pid } of children) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      runs.push({ promptMs, inputMs, waiting, settled })
      if (!index || (index + 1) % 20 === 0) await heapCheckpoint(index + 1)
    }
    const last = await sample()
    await page.getByRole('button', { name: 'Toggle Console' }).click()
    await page.getByTestId('output').waitFor({ state: 'detached' })
    await sleep(4000)
    const closed = await sample()
    assert.equal(closed.processes.filter(({ kind }) => kind === 'child').length, 0)
    assert.deepEqual(session.requests, [])
    await heapCheckpoint('closed')
    report = { before, runs, waitingCpuPercent, last, closed, checkpoints }
    const measure = (key) => {
      const values = runs.map((run) => run[key]).sort((a, b) => a - b)
      return { first: runs[0][key], median: (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2,
        min: values[0], max: values.at(-1) }
    }
    console.log({ runs: count, promptMs: measure('promptMs'), inputMs: measure('inputMs'), waitingCpuPercent, output })
  } finally {
    await close(session)
  }
  if (baseline) {
    await writeFile(project.program, '#include <stdio.h>\n#include <unistd.h>\nint main(void) { printf("ION-SHORT-%ld\\n", (long)getpid()); return 0; }\n')
    report.shortRuns = {
      baseline: await shortRuns(baseline, join(scratch, 'short-baseline'), project),
      candidate: await shortRuns(target, join(scratch, 'short-candidate'), project),
    }
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
})
