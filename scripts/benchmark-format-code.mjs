import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch, cpus, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { median } from './benchmark-resource-metrics.mjs'
import { artifact, atPath, close, createProject, launch, openFolder, openFromExplorer, resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, trials: { type: 'string', default: '5' },
  exercise: { type: 'boolean' }, diagnose: { type: 'boolean' }, rounds: { type: 'string', default: '100' }, out: { type: 'string' },
} })
assert.equal(process.platform, 'darwin', 'This benchmark uses macOS process accounting.')
const trials = Number(values.trials)
assert.ok(Number.isInteger(trials) && trials >= (values.exercise ? 0 : 1) && trials <= 15)
const rounds = Number(values.rounds)
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 500)
const target = await artifact(values.target)
const output = resolve(values.out ?? 'performance-results/format-code/candidate.json')
const execute = promisify(execFile)
const system = async (bin, ...args) => (await execute(bin, args)).stdout.trim()
const MiB = 1024 ** 2
const report = {
  timestamp: new Date().toISOString(), target: target.path, trials,
  mainSha256: createHash('sha256').update(await readFile(join(target.path, 'main/index.cjs'))).digest('hex'),
  htmlSha256: createHash('sha256').update(await readFile(join(target.path, 'renderer/index.html'))).digest('hex'),
  host: { macOS: await system('/usr/bin/sw_vers'), arch: arch(), cpu: cpus()[0].model, ram: totalmem(),
    node: process.version, power: await system('/usr/bin/pmset', '-g', 'batt'), thermal: await system('/usr/bin/pmset', '-g', 'therm') },
  protocol: 'Hidden production Electron with seeded disposable profiles. Fresh process, then same-profile relaunch. OS caches unchanged. Offline renderer. 900 ms settle, 2 s one-source idle, 7 real typing samples, 20 resident tab switches per trial.',
  runs: [],
}
const save = async () => {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}

await withScratch('format-bench', async (scratch) => {
  const probe = join(scratch, 'resource-probe')
  await execute('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 1 })
  await writeFile(project.program, '// ion format source\nint main(void){return 0;}\n')
  async function snapshot(session) {
    const result = await resourceSnapshot(session, { details: true })
    const { stdout } = await execute(probe, result.members.map(({ pid }) => String(pid)))
    const byPid = new Map(stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [pid, footprintBytes, cpuNs, childCpuNs] = line.split(' ').map(Number)
      return [pid, { footprintBytes, cpuNs, childCpuNs }]
    }))
    const members = result.members.map((item) => ({ ...item, ...byPid.get(item.pid) }))
    return { timeMs: result.timeMs, rssMiB: result.rssMiB,
      footprintMiB: members.every((p) => p.footprintBytes !== undefined)
        ? members.reduce((sum, p) => sum + p.footprintBytes, 0) / MiB : null, members }
  }
  function cpu(first, last, includeReaped = false) {
    const old = new Map(first.members.map((p) => [p.pid, p]))
    const cpuNs = last.members.reduce((sum, p) => {
      const base = old.get(p.pid)
      if (!base || p.cpuNs === undefined || base.cpuNs === undefined) return sum
      return sum + Math.max(0, p.cpuNs - base.cpuNs) + (includeReaped && p.kind === 'main'
        ? Math.max(0, p.childCpuNs - base.childCpuNs) : 0)
    }, 0)
    return { cpuMs: cpuNs / 1e6, cpuPercent: cpuNs / (last.timeMs - first.timeMs) / 10_000 }
  }
  const line = (page) => page.getByTestId('editor').locator('.view-line').first()
  const choose = async (page, path, expected) => {
    const began = performance.now()
    await atPath(page, 'tab', path).locator('.tab-name').evaluate((button) => button.click())
    await (await page.waitForFunction((needle) => document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes(needle), expected)).dispose()
    return performance.now() - began
  }
  async function quit(session) {
    const closing = close(session)
    const confirm = session.page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: /discard/i })
    await Promise.race([closing, confirm.click({ timeout: 3000 }).catch(() => closing)])
    await closing
  }
  for (let i = 0; i < trials; i++) {
    const profile = join(scratch, 'profile-' + i)
    await mkdir(profile)
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
      settings: { resourceProfile: 'minimal', openFullScreen: false, autoSave: false } }))
    const fresh = await launch(target, profile)
    const startup = { freshMs: fresh.startupMs }
    report.electron = await fresh.app.evaluate(() => process.versions.electron)
    await close(fresh)
    const session = await launch(target, profile)
    const { app, page } = session
    try {
      startup.warmMs = session.startupMs
      await page.context().setOffline(true)
      await sleep(900)
      const welcome = await snapshot(session)
      await stubDialogs(app, { folder: project.directory })
      await openFolder(page, project)
      const fileOpenMs = await openFromExplorer(page, project.program, 'ion format source')
      await sleep(900)
      const idleStart = await snapshot(session)
      await sleep(2000)
      const oneFile = await snapshot(session)
      assert.equal(oneFile.members.some(({ kind }) => kind === 'child'), false)
      const typing = []
      for (let j = 0; j < 7; j++) {
        await line(page).click()
        await page.evaluate(() => {
          window.ionFormatKey = new Promise((done) => {
            window.addEventListener('keydown', () => {
              const begin = performance.now()
              requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - begin)))
            }, { once: true, capture: true })
          })
        })
        await page.keyboard.press('x')
        await (await page.waitForFunction(() => document.querySelector('.monaco-editor .view-line')?.textContent.includes('x'))).dispose()
        typing.push(await page.evaluate(() => window.ionFormatKey))
        await page.keyboard.press('Meta+z')
      }
      await openFromExplorer(page, project.files[0], 'Ion fixture')
      const switches = []
      for (let j = 0; j < 10; j++) {
        switches.push(await choose(page, project.program, 'ion format source'))
        switches.push(await choose(page, project.files[0], 'Ion fixture'))
      }
      const result = { startup, welcome, fileOpenMs, oneFile, idle: cpu(idleStart, oneFile), typing, switches }
      report.runs.push(result)
      assert.deepEqual(session.errors, [])
      assert.deepEqual(session.requests, [])
      console.log(JSON.stringify({ trial: i + 1, ...startup, fileOpenMs, rss: oneFile.rssMiB, footprint: oneFile.footprintMiB,
        cpu: result.idle.cpuPercent, typingMs: median(typing), tabMs: median(switches) }))
      await save()
    } catch (error) {
      console.error(error)
      throw error
    } finally { await quit(session) }
  }
  // The candidate-only workload uses the same sampling and process ownership.
  if (values.exercise) {
    const sizes = [100, 1000, 5000]
    const files = new Map(sizes.map((size) => [size, join(project.directory, 'format-' + size + '.c')]))
    const sources = new Map(sizes.map((size) => [size, Array.from({ length: size }, (_, line) =>
      'int f' + line + '(void){return ' + line + ';}').join('\n') + '\n']))
    await Promise.all(sizes.map((size) => writeFile(files.get(size), sources.get(size))))
    const profile = join(scratch, 'format-workload-profile')
    await mkdir(profile)
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { resourceProfile: 'minimal', openFullScreen: false, autoSave: false } }))
    const session = await launch(target, profile)
    const { app, page } = session
    const cdp = values.diagnose ? await page.context().newCDPSession(page) : undefined
    const heap = async () => cdp && ({
      renderer: await cdp.send('Runtime.getHeapUsage'),
      main: await app.evaluate(() => process.memoryUsage()),
      nodes: await cdp.send('Memory.getDOMCounters'),
    })
    const expect = async (text) => (await page.waitForFunction((needle) =>
      document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes(needle), text)).dispose()
    const button = page.getByTestId('format-document')
    const original = 'int f0(void){'
    const formatted = 'int f0(void) {'
    async function format(clicks = 1) {
      const began = performance.now()
      await button.evaluate((node, count) => { for (let index = 0; index < count; index++) node.click() }, clicks)
      await expect(formatted)
      const elapsed = performance.now() - began
      await button.locator('xpath=..').locator('[data-testid="format-document"]:enabled').waitFor()
      return elapsed
    }
    async function undo() {
      await line(page).click()
      await page.keyboard.press('Meta+z')
      await expect(original)
    }
    const formatting = { sizes: [], soak: null }
    try {
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory })
      await openFolder(page, project)
      for (const size of sizes) {
        const path = files.get(size)
        await openFromExplorer(page, path, original)
        await sleep(500)
        const before = await snapshot(session)
        const samples = []
        let running = true
        const sampler = (async () => {
          while (running) {
            samples.push(await snapshot(session))
            if (running) await sleep(10)
          }
        })()
        const latency = []
        try {
          for (let i = 0; i < 5; i++) {
            latency.push(await format(i === 0 ? 20 : 1))
            if (i < 4) await undo()
          }
        } finally { running = false; await sampler }
        const after = await snapshot(session)
        assert.ok(after.members.every(({ kind }) => kind !== 'child'), 'Tool remained after the format reply.')
        await sleep(900)
        const settled = await snapshot(session)
        const row = { lines: size, latency, before, after, settled, samples, cpu: cpu(before, after, true) }
        formatting.sizes.push(row)
        await undo()
        console.log(JSON.stringify({ lines: size, latencyMs: median(latency), samples: samples.length,
          peakRssMiB: Math.max(...samples.map((item) => item.rssMiB)),
          peakFootprintMiB: Math.max(...samples.flatMap((item) => item.footprintMiB === null ? [] : [item.footprintMiB])),
          cpu: row.cpu, settledRssMiB: settled.rssMiB }))
      }
      const before = await snapshot(session)
      const heapBefore = await heap()
      const checkpoints = []
      const latency = []
      for (let i = 0; i < rounds; i++) {
        await choose(page, files.get(sizes[i % sizes.length]), original)
        latency.push(await format())
        await undo()
        if ((i + 1) % 10 === 0 || i + 1 === rounds) {
          await sleep(220)
          const sample = await snapshot(session)
          assert.ok(sample.members.every(({ kind }) => kind !== 'child'), 'Formatter survived a completed round.')
          checkpoints.push({ round: i + 1, sample, heap: await heap() })
        }
      }
      await sleep(1500)
      const after = await snapshot(session)
      formatting.soak = { rounds, elapsedSeconds: (after.timeMs - before.timeMs) / 1000, before, after, checkpoints, latency, cpu: cpu(before, after, true) }
      if (cdp) {
        const heapAfter = await heap()
        await sleep(20_000)
        const idle = { sample: await snapshot(session), heap: await heap() }
        await cdp.send('HeapProfiler.collectGarbage')
        const afterDiagnosticGC = { sample: await snapshot(session), heap: await heap() }
        formatting.diagnostics = { heapBefore, heapAfter, idle, afterDiagnosticGC }
      }
      for (const [size, path] of files) assert.equal(await readFile(path, 'utf8'), sources.get(size))
      assert.deepEqual(session.requests, [])
      assert.deepEqual(session.errors, [])
      report.formatting = formatting
      await save()
      console.log(JSON.stringify({ rounds, seconds: formatting.soak.elapsedSeconds, before: before.rssMiB, after: after.rssMiB }))
    } finally { await quit(session) }
  }
})
