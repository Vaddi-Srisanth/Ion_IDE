import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { artifact, atPath, editorShows, resourceSnapshot, sleep, withScratch } from './desktop-harness.mjs'
import { median } from './benchmark-resource-metrics.mjs'

const { values } = parseArgs({ options: { target: { type: 'string' }, 'startup-only': { type: 'boolean' } } })
assert.equal(process.platform, 'darwin', 'This benchmark uses macOS process accounting.')
const execute = promisify(execFile)
const release = JSON.parse(await readFile('package.json', 'utf8'))
const original = await artifact(values.target ?? `release/Ion IDE-${release.version}-darwin-${process.arch}/Ion IDE.app`)
assert.ok(original.path.endsWith('.app'), 'Select an Apple Silicon or Intel macOS app bundle.')

async function stop(session) {
  const { child, browser } = session
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(3000, undefined, { ref: false })])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
  if (browser) await Promise.race([browser.close().catch(() => {}), sleep(2000, undefined, { ref: false })])
}

async function launch(bundle, profile) {
  const portFile = join(profile, 'DevToolsActivePort')
  await rm(portFile, { force: true })
  const env = { ...process.env }
  delete env.ION_DEV_URL
  delete env.ELECTRON_RUN_AS_NODE
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const child = spawn(bundle.executablePath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], { env, stdio: 'ignore' })
  const session = { child, pid: child.pid, profile, startedAt, spawnReturnMs: performance.now() - started }
  let launchError
  child.on('error', (error) => { launchError = error })
  try {
    let port
    const deadline = started + 8000
    while (performance.now() < deadline && !launchError && child.exitCode === null && child.signalCode === null) {
      port = await readFile(portFile, 'utf8').then((value) => Number(value.split('\n')[0]), () => null)
      if (port) break
      await sleep(15)
    }
    if (launchError) throw launchError
    assert.ok(port, 'The bundled app started its local DevTools endpoint.')
    session.portMs = performance.now() - started
    session.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8000 })
    session.cdpMs = performance.now() - started
    const context = session.browser.contexts()[0]
    session.page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 8000 })
    session.page.setDefaultTimeout(8000)
    await session.page.getByTestId('welcome').waitFor()
    session.startupMs = performance.now() - started
    assert.equal(session.page.url(), 'app://workbench/index.html')
    await context.setOffline(true)
    return session
  } catch (error) {
    await stop(session)
    throw error
  }
}

async function sample(session, probe) {
  const { timeMs, rssMiB, members } = await resourceSnapshot(session, { details: true })
  assert.ok(members.some(({ kind }) => kind === 'main') && members.some(({ kind }) => kind === 'renderer'))
  const { stdout } = await execute(probe, members.map(({ pid }) => String(pid)))
  const usage = new Map(stdout.trim().split('\n').map((line) => {
    const [pid, footprintBytes, cpuNs] = line.split(' ').map(Number)
    return [pid, { footprintBytes, cpuNs }]
  }))
  const processes = members.map(({ pid, kind, rssMiB: resident }) => {
    assert.ok(usage.has(pid), 'Every idle process has macOS footprint and CPU counters.')
    return { pid, kind, rssMiB: resident, ...usage.get(pid) }
  })
  return { timeMs, rssMiB, footprintMiB: processes.reduce((total, item) => total + item.footprintBytes / 1024 ** 2, 0), processes }
}

async function observe(session, probe, seconds) {
  await sleep(5000)
  const samples = [await sample(session, probe)]
  for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
    await sleep(5000)
    samples.push(await sample(session, probe))
  }
  const first = samples[0]
  const last = samples.at(-1)
  const initial = new Map(first.processes.map(({ pid, cpuNs }) => [pid, cpuNs]))
  for (const { processes } of samples) {
    assert.deepEqual(processes.map(({ pid }) => pid).sort(), [...initial.keys()].sort(), 'Idle process membership stayed stable.')
  }
  const durationMs = last.timeMs - first.timeMs
  const cpuNs = last.processes.reduce((sum, process) => sum + process.cpuNs - initial.get(process.pid), 0)
  return { durationMs, rssMiB: median(samples.map((item) => item.rssMiB)),
    footprintMiB: median(samples.map((item) => item.footprintMiB)), cpuPercentOneCore: 100 * cpuNs / 1e6 / durationMs, samples }
}

const report = await withScratch('packaged-runtime', async (scratch) => {
  const copy = join(scratch, 'Ion IDE.app')
  const probe = join(scratch, 'usage')
  await execute('/usr/bin/ditto', ['--norsrc', '--noextattr', original.path, copy])
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', copy])
  await execute('/usr/bin/xcrun', ['clang', '-O2', '-std=c11', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const bundle = await artifact(copy)
  const fixture = join(scratch, 'ion-runtime-fixture.c')
  await writeFile(fixture, 'int main(void) { return 0; }\n')
  const readSystem = async (command, args) => (await execute(command, args)).stdout.trim()
  const result = {
    schemaVersion: 1, timestamp: new Date().toISOString(), bundle: basename(original.path),
    version: await readSystem('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', join(copy, 'Contents/Info.plist')]),
    asarSha256: createHash('sha256').update(await readFile(join(copy, 'Contents/Resources/app.asar'))).digest('hex'),
    host: { os: await readSystem('/usr/bin/sw_vers', []),
      chip: await readSystem('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
      ramBytes: Number(await readSystem('/usr/sbin/sysctl', ['-n', 'hw.memsize'])),
      power: (await readSystem('/usr/bin/pmset', ['-g', 'batt'])).split('\n')[0],
      thermal: await readSystem('/usr/bin/pmset', ['-g', 'therm']) },
    method: 'Native signed bundle copy, 3 fresh-profile and 3 same-profile launches to visible Welcome with local CDP attachment. Launch stage times are cumulative from before spawn. OS caches intact.'
      + (values['startup-only'] ? '' : ' One warm session, 5 s settle per stage, 30 s Welcome idle and 15 s idle with one tiny C fixture open. Whole process family RSS, macOS phys_footprint and kernel CPU time.'),
    launches: [],
  }
  for (let trial = 1; trial <= 3; trial++) {
    const profile = join(scratch, 'profile-' + trial)
    await mkdir(profile)
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({
      version: 1, settings: { resourceProfile: 'minimal' },
      recents: [{ kind: 'file', path: fixture, name: basename(fixture), lastOpened: 1 }],
    }))
    const fresh = await launch(bundle, profile)
    await stop(fresh)
    const warm = await launch(bundle, profile)
    try {
      result.launches.push({ freshMs: fresh.startupMs, warmMs: warm.startupMs,
        freshStartedAt: fresh.startedAt, warmStartedAt: warm.startedAt,
        freshSpawnReturnMs: fresh.spawnReturnMs, warmSpawnReturnMs: warm.spawnReturnMs,
        freshPortMs: fresh.portMs, warmPortMs: warm.portMs, freshCdpMs: fresh.cdpMs, warmCdpMs: warm.cdpMs })
      if (trial !== 3 || values['startup-only']) continue
      result.welcomeIdle = await observe(warm, probe, 30)
      const started = performance.now()
      await warm.page.locator('.recent-entry').filter({ hasText: basename(fixture) }).click()
      await atPath(warm.page, 'tab', fixture).waitFor()
      await editorShows(warm.page, 'int main(void)')
      result.firstFileMs = performance.now() - started
      result.oneFileIdle = await observe(warm, probe, 15)
    } finally {
      await stop(warm)
    }
  }
  return result
})

await mkdir('performance-results', { recursive: true })
const output = `performance-results/packaged-runtime-${report.timestamp.replaceAll(':', '-')}.json`
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
const { samples: _welcomeSamples, ...welcomeIdle } = report.welcomeIdle ?? {}
const { samples: _editorSamples, ...oneFileIdle } = report.oneFileIdle ?? {}
console.log(JSON.stringify({ output, launches: report.launches, firstFileMs: report.firstFileMs, welcomeIdle, oneFileIdle }, null, 2))
