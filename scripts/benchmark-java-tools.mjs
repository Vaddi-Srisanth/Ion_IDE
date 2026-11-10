import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch, cpus, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { median } from './benchmark-resource-metrics.mjs'
import { artifact, atPath, close, createProject, eventually, launch, openFolder, openFromExplorer,
  resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  baseline: { type: 'string' },
  target: { type: 'string', default: 'dist' },
  untuned: { type: 'string' },
  trials: { type: 'string', default: '3' },
  out: { type: 'string', default: 'performance-results/java-intelligence/java-tools.json' },
} })
assert.equal(process.platform, 'darwin', 'Native process accounting in this benchmark requires macOS.')
assert.ok(values.baseline, 'Pass a preserved production build before Java intelligence via --baseline.')
const trials = Number(values.trials)
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 10)
const execute = promisify(execFile)
const output = resolve(values.out)
const source = 'class Main {\n    void run() {\n        List<String> values;\n    }\n}\n'
const member = 'class Main { void run() { System.out.; } }'
const size = 1024 ** 2
const modeKey = process.platform === 'darwin' ? 'Meta' : 'Control'
const baseline = await artifact(values.baseline)
const candidate = await artifact(values.target)
const untuned = values.untuned && await artifact(values.untuned)
const javaHome = (await execute('/usr/libexec/java_home', ['-F'])).stdout.trim()
const javaVersion = await execute(join(javaHome, 'bin/java'), ['-version'])
const modes = [
  { name: 'baseline', target: baseline, smart: false },
  { name: 'basic', target: candidate, smart: false },
  { name: 'smart', target: candidate, smart: true },
  ...(untuned ? [{ name: 'smart-untuned', target: untuned, smart: true }] : []),
]
const identify = async (target) => ({
  path: target.path,
  mainSha256: createHash('sha256').update(await readFile(join(target.path, 'main/index.cjs'))).digest('hex'),
  htmlSha256: createHash('sha256').update(await readFile(join(target.path, 'renderer/index.html'))).digest('hex'),
  javaSha256: await readFile(join(target.path, 'main/java/service.cjs'))
    .then((bytes) => createHash('sha256').update(bytes).digest('hex'), () => null),
})
const report = {
  timestamp: new Date().toISOString(), trialsPerMode: trials,
  builds: { baseline: await identify(baseline), candidate: await identify(candidate), ...(untuned && { untuned: await identify(untuned) }) },
  host: {
    macOS: (await execute('/usr/bin/sw_vers')).stdout.trim(), arch: arch(), cpu: cpus()[0].model,
    ramBytes: totalmem(), node: process.version, jdk: javaVersion.stderr.trim(),
  },
  protocol: 'Interleaved production builds in hidden Electron, offline renderer, one fresh disposable profile per trial. RSS sums the full process tree and can double-count shared pages. Footprint sums macOS per-process ledger charges. CPU is percent of one logical core over a 2-second idle interval. Typing measures keydown to a second animation-frame callback and confirms the resulting source in the same editor.',
  modes: Object.fromEntries(modes.map(({ name }) => [name, []])),
}

await withScratch('java-bench', async (scratch) => {
  const probe = join(scratch, 'resource-probe')
  await execute('xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const path = join(project.directory, 'Main.java')
  await writeFile(path, source)
  async function snapshot(session) {
    const result = await resourceSnapshot(session, { details: true })
    const { stdout } = await execute(probe, result.members.map(({ pid }) => String(pid)))
    const byPid = new Map(stdout.trim().split('\n').map((row) => {
      const [pid, footprint, cpu] = row.split(' ').map(Number)
      return [pid, { footprint, cpu }]
    }))
    const processes = result.members.map((item) => ({ ...item, ...byPid.get(item.pid) }))
    assert.ok(processes.every(({ footprint }) => Number.isFinite(footprint)), 'Process tree changed during sampling.')
    return { time: result.timeMs, rssMiB: result.rssMiB,
      footprintMiB: processes.reduce((sum, item) => sum + item.footprint, 0) / size, processes }
  }
  async function trial({ name, target, smart }, iteration) {
    const profile = join(scratch, name + '-' + iteration)
    await mkdir(profile)
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({
      version: 1, settings: { smartLanguages: smart ? ['java'] : [], autoSave: false,
        openFullScreen: false, showOutput: true, automaticSuggestions: false },
    }))
    const session = await launch(target, profile)
    const { app, page } = session
    try {
      await page.context().setOffline(true)
      await sleep(900)
      const welcome = await snapshot(session)
      assert.ok(welcome.processes.every(({ kind }) => kind !== 'child'))
      await stubDialogs(app, { folder: project.directory })
      await openFolder(page, project)
      const beginOpen = performance.now()
      const openMs = await openFromExplorer(page, path, 'List<String>')
      if (smart) await (await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="editor"] .squiggly-error')),
        null, { timeout: 18_000 })).dispose()
      const firstDiagnosticMs = smart ? performance.now() - beginOpen : null
      await sleep(800)
      const beforeIdle = await snapshot(session)
      await sleep(2000)
      const editor = await snapshot(session)
      assert.equal(editor.processes.filter(({ name }) => name === 'java').length, smart ? 1 : 0)
      const old = new Map(beforeIdle.processes.map(({ pid, cpu }) => [pid, cpu]))
      assert.deepEqual(editor.processes.map(({ pid }) => pid).sort(), [...old.keys()].sort())
      const cpuIdle = editor.processes.reduce((sum, { pid, cpu }) => sum + Math.max(0, cpu - old.get(pid)), 0) / (editor.time - beforeIdle.time) / 10_000
      const keySamples = []
      for (let i = 0; i < 7; i++) {
        const first = page.getByTestId('editor').locator('.view-line').first()
        await first.click()
        await page.evaluate(() => {
          window.ionJavaBenchmarkKey = new Promise((resolveKey) => {
            window.addEventListener('keydown', () => {
              const begin = performance.now()
              requestAnimationFrame(() => requestAnimationFrame(() => resolveKey(performance.now() - begin)))
            }, { once: true, capture: true })
          })
        })
        await page.keyboard.press('x')
        await eventually(async () => (await first.textContent()).includes('x'), 'The key was not rendered.')
        keySamples.push(await page.evaluate(() => window.ionJavaBenchmarkKey))
        await page.keyboard.press(modeKey + '+z')
      }
      const warmCompletions = []
      if (smart) {
        for (let version = 1; version <= 5; version++) {
          const start = performance.now()
          const result = await page.evaluate(({ path, text, version }) => window.ion.languageTools.query({
            language: 'java', operation: 'complete', path, text, offset: text.indexOf('.;') + 1, version,
          }), { path, text: member, version })
          assert.ok(result?.rows.some(([name]) => name === 'println'))
          warmCompletions.push(performance.now() - start)
        }
      }
      await atPath(page, 'close-tab', path).click()
      const unsaved = page.getByRole('dialog', { name: 'Unsaved changes' })
      const tab = atPath(page, 'tab', path)
      await eventually(async () => !(await tab.count()) || (await unsaved.count()), 'Java tab did not close or prompt.')
      if (await unsaved.count()) await unsaved.getByRole('button', { name: /discard/i }).click()
      await tab.waitFor({ state: 'detached' })
      if (smart) await eventually(async () => !(await resourceSnapshot(session, { details: true })).members.some(({ name }) => name === 'java'),
        'Java remained after the final tab closed.')
      await sleep(900)
      const afterClose = await snapshot(session)
      return { startupMs: session.startupMs, openMs, firstDiagnosticMs, cpuIdle, typingMs: median(keySamples),
        warmCompletionMs: warmCompletions.length ? median(warmCompletions) : null, keySamples, warmCompletions, welcome, editor, afterClose }
    } finally { await close(session) }
  }
  for (let i = 0; i < trials; i++) {
    for (const mode of modes) {
      const run = await trial(mode, i)
      report.modes[mode.name].push(run)
      console.log(mode.name, i + 1, JSON.stringify({
        startupMs: run.startupMs, openMs: run.openMs, diagnosticMs: run.firstDiagnosticMs, idleCpu: run.cpuIdle,
        typingMs: run.typingMs, warmCompletionMs: run.warmCompletionMs,
        welcome: [run.welcome.rssMiB, run.welcome.footprintMiB], editor: [run.editor.rssMiB, run.editor.footprintMiB],
        afterClose: [run.afterClose.rssMiB, run.afterClose.footprintMiB],
      }))
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    }
  }
})
console.log(output)
